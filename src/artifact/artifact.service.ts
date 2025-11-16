import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { Readable } from 'stream';
import { createHash } from 'crypto';

export interface StoreArtifactOptions {
  repositoryId: string;
  name: string;
  version: string;
  stream: Readable;
  contentType: string;
  metadata?: any;
  cacheTtl?: number;
}

export interface ArtifactInfo {
  id: string;
  name: string;
  version: string;
  path: string;
  size: bigint;
  checksum: string;
  contentType: string;
  metadata: any;
  lastAccessed: Date;
}

@Injectable()
export class ArtifactService {
  private readonly logger = new Logger(ArtifactService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Store an artifact in storage and create metadata record
   */
  async storeArtifact(options: StoreArtifactOptions): Promise<ArtifactInfo> {
    const {
      repositoryId,
      name,
      version,
      stream,
      contentType,
      metadata,
      cacheTtl,
    } = options;

    // Generate storage path
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
    });

    if (!repository) {
      throw new NotFoundException(`Repository ${repositoryId} not found`);
    }

    const storagePath = this.generateStoragePath(
      repository.name,
      name,
      version,
    );

    // Calculate checksum while streaming to storage
    const { size, checksum } = await this.storeWithChecksum(
      storagePath,
      stream,
      contentType,
    );

    // Create artifact record
    const artifact = await this.prisma.artifact.create({
      data: {
        repositoryId,
        name,
        version,
        path: storagePath,
        size,
        checksum,
        contentType,
        metadata: metadata || {},
        cacheTtl,
      },
    });

    // Create cache entry with expiration
    const ttl = cacheTtl || repository.cacheTtl;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.prisma.cacheEntry.create({
      data: {
        key: `${repositoryId}:${name}:${version}`,
        repositoryId,
        artifactPath: storagePath,
        expiresAt,
        metadata: { contentType },
      },
    });

    this.logger.log(
      `Stored artifact ${name}@${version} in repository ${repository.name}`,
    );

    return {
      id: artifact.id,
      name: artifact.name,
      version: artifact.version,
      path: artifact.path,
      size: artifact.size,
      checksum: artifact.checksum,
      contentType: artifact.contentType,
      metadata: artifact.metadata,
      lastAccessed: artifact.lastAccessed,
    };
  }

  /**
   * Get an artifact stream from storage
   */
  async getArtifact(
    repositoryId: string,
    name: string,
    version: string,
  ): Promise<{ stream: Readable; artifact: ArtifactInfo } | null> {
    const artifact = await this.prisma.artifact.findUnique({
      where: {
        repositoryId_name_version: {
          repositoryId,
          name,
          version,
        },
      },
    });

    if (!artifact) {
      return null;
    }

    // Update last accessed time (fire and forget)
    this.prisma.artifact
      .update({
        where: { id: artifact.id },
        data: { lastAccessed: new Date() },
      })
      .catch((error) =>
        this.logger.error('Failed to update lastAccessed:', error),
      );

    // Get stream from storage
    const adapter = this.storage.getDefaultAdapter();
    const stream = await adapter.getObject(artifact.path);

    return {
      stream,
      artifact: {
        id: artifact.id,
        name: artifact.name,
        version: artifact.version,
        path: artifact.path,
        size: artifact.size,
        checksum: artifact.checksum,
        contentType: artifact.contentType,
        metadata: artifact.metadata,
        lastAccessed: artifact.lastAccessed,
      },
    };
  }

  /**
   * Check if artifact exists
   */
  async exists(
    repositoryId: string,
    name: string,
    version: string,
  ): Promise<boolean> {
    const count = await this.prisma.artifact.count({
      where: {
        repositoryId,
        name,
        version,
      },
    });

    return count > 0;
  }

  /**
   * Delete an artifact
   */
  async deleteArtifact(
    repositoryId: string,
    name: string,
    version: string,
  ): Promise<void> {
    const artifact = await this.prisma.artifact.findUnique({
      where: {
        repositoryId_name_version: {
          repositoryId,
          name,
          version,
        },
      },
    });

    if (!artifact) {
      throw new NotFoundException('Artifact not found');
    }

    // Delete from storage
    const adapter = this.storage.getDefaultAdapter();
    await adapter.deleteObject(artifact.path);

    // Delete from database (cascade will delete cache entries)
    await this.prisma.artifact.delete({
      where: { id: artifact.id },
    });

    this.logger.log(`Deleted artifact ${name}@${version}`);
  }

  /**
   * Record download statistics
   */
  async recordDownload(
    repositoryId: string,
    artifactName: string,
    artifactVersion: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    await this.prisma.downloadStats.create({
      data: {
        repositoryId,
        artifactName,
        artifactVersion,
        ipAddress,
        userAgent,
      },
    });
  }

  /**
   * Generate storage path for an artifact
   */
  private generateStoragePath(
    repositoryName: string,
    artifactName: string,
    version: string,
  ): string {
    // Clean the artifact name to be filesystem-safe
    const safeName = artifactName.replace(/[^a-zA-Z0-9@/_.-]/g, '_');
    return `repositories/${repositoryName}/${safeName}/${version}/artifact`;
  }

  /**
   * Store stream to storage while calculating checksum
   */
  private async storeWithChecksum(
    path: string,
    stream: Readable,
    contentType: string,
  ): Promise<{ size: bigint; checksum: string }> {
    const hash = createHash('sha256');
    let size = 0;

    // Create a pass-through stream that calculates hash and size
    const { PassThrough } = await import('stream');
    const passThrough = new PassThrough();

    passThrough.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });

    // Pipe input stream through pass-through
    stream.pipe(passThrough);

    // Store to storage
    const adapter = this.storage.getDefaultAdapter();
    await adapter.putObject(path, passThrough, { contentType });

    const checksum = hash.digest('hex');

    return {
      size: BigInt(size),
      checksum,
    };
  }
}
