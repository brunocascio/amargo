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

    try {
      // Find expired cache entries
      const expiredEntries = await this.prisma.cacheEntry.findMany({
        where: {
          expiresAt: {
            lt: now,
          },
        },
      });

      if (expiredEntries.length === 0) {
        this.logger.debug('No expired cache entries found');
        return;
      }

      this.logger.log(`Found ${expiredEntries.length} expired cache entries`);

      const adapter = this.storage.getDefaultAdapter();

      for (const entry of expiredEntries) {
        try {
          // Find the artifact
          const artifact = await this.prisma.artifact.findFirst({
            where: {
              path: entry.artifactPath,
            },
          });

          if (artifact) {
            // Delete from storage
            await adapter.deleteObject(artifact.path);

            // Delete artifact record (cascade will delete cache entry)
            await this.prisma.artifact.delete({
              where: { id: artifact.id },
            });

            this.logger.debug(
              `Cleaned up artifact: ${artifact.name}@${artifact.version}`,
            );
          } else {
            // Orphaned cache entry, delete it
            await this.prisma.cacheEntry.delete({
              where: { id: entry.id },
            });
          }
        } catch (error) {
          this.logger.error(`Failed to cleanup entry ${entry.id}:`, error);
        }
      }

      this.logger.log(
        `Cache cleanup completed (${expiredEntries.length} entries cleaned)`,
      );
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
