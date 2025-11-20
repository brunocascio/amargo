import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AmargoConfigService } from '../config/amargo-config.service';

@Injectable()
export class CacheCleanupService implements OnModuleInit {
  private readonly logger = new Logger(CacheCleanupService.name);
  private cleanupIntervalMs: number;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly configService: AmargoConfigService,
  ) {
    const cacheConfig = this.configService.getCache();
    this.cleanupIntervalMs = (cacheConfig.cleanupInterval || 3600) * 1000;
  }

  onModuleInit() {
    this.startCleanupJob();
  }

  private startCleanupJob(): void {
    this.logger.log(
      `Starting cache cleanup job (interval: ${this.cleanupIntervalMs / 1000}s)`,
    );

    this.intervalHandle = setInterval(() => {
      this.cleanupExpiredCache().catch((error) =>
        this.logger.error('Cache cleanup failed:', error),
      );
    }, this.cleanupIntervalMs);

    // Run immediately on startup
    this.cleanupExpiredCache().catch((error) =>
      this.logger.error('Initial cache cleanup failed:', error),
    );
  }

  async cleanupExpiredCache(): Promise<void> {
    const now = new Date();
    const BATCH_SIZE = 100; // Process in batches to avoid memory issues
    let totalCleaned = 0;

    try {
      // Process expired entries in batches
      let hasMore = true;

      while (hasMore) {
        // Find a batch of expired cache entries
        const expiredEntries = await this.prisma.cacheEntry.findMany({
          where: {
            expiresAt: {
              lt: now,
            },
          },
          take: BATCH_SIZE,
          select: {
            id: true,
            artifactPath: true,
          },
        });

        if (expiredEntries.length === 0) {
          hasMore = false;
          break;
        }

        this.logger.debug(
          `Processing batch of ${expiredEntries.length} expired cache entries`,
        );

        const adapter = this.storage.getDefaultAdapter();

        // Collect artifact paths and IDs to delete
        const artifactPathsToDelete: string[] = [];
        const cacheEntryIdsToDelete: string[] = [];

        for (const entry of expiredEntries) {
          try {
            // Find the artifact
            const artifact = await this.prisma.artifact.findFirst({
              where: {
                path: entry.artifactPath,
              },
              select: {
                id: true,
                path: true,
                name: true,
                version: true,
              },
            });

            if (artifact) {
              artifactPathsToDelete.push(artifact.path);
              // Note: We'll delete artifacts which will cascade to cache entries
            } else {
              // Orphaned cache entry
              cacheEntryIdsToDelete.push(entry.id);
            }
          } catch (error) {
            this.logger.error(`Failed to process entry ${entry.id}:`, error);
          }
        }

        // Batch delete from storage (fire and forget with error handling)
        for (const path of artifactPathsToDelete) {
          adapter.deleteObject(path).catch((error) => {
            this.logger.error(`Failed to delete from storage: ${path}`, error);
          });
        }

        // Batch delete artifacts from database (cascade deletes cache entries)
        if (artifactPathsToDelete.length > 0) {
          const deleteResult = await this.prisma.artifact.deleteMany({
            where: {
              path: {
                in: artifactPathsToDelete,
              },
            },
          });
          totalCleaned += deleteResult.count;
          this.logger.debug(`Deleted ${deleteResult.count} artifacts`);
        }

        // Delete orphaned cache entries
        if (cacheEntryIdsToDelete.length > 0) {
          const deleteResult = await this.prisma.cacheEntry.deleteMany({
            where: {
              id: {
                in: cacheEntryIdsToDelete,
              },
            },
          });
          totalCleaned += deleteResult.count;
          this.logger.debug(
            `Deleted ${deleteResult.count} orphaned cache entries`,
          );
        }

        // If we got fewer entries than batch size, we're done
        if (expiredEntries.length < BATCH_SIZE) {
          hasMore = false;
        }
      }

      if (totalCleaned === 0) {
        this.logger.debug('No expired cache entries found');
      } else {
        this.logger.log(
          `Cache cleanup completed (${totalCleaned} entries cleaned)`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to cleanup expired cache:', error);
      throw error;
    }
  }

  stopCleanupJob(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('Cache cleanup job stopped');
    }
  }
}
