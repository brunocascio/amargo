import {
  Controller,
  Get,
  Head,
  Logger,
  Param,
  Req,
  Res,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { ArtifactService } from '../artifact/artifact.service';
import { AmargoConfigService } from '../config/amargo-config.service';
import { Readable } from 'stream';

/**
 * Maven Repository Implementation
 *
 * Maven Repository Layout: https://maven.apache.org/repository/layout.html
 *
 * Endpoints:
 * - GET /maven/{groupId}/{artifactId}/{version}/{filename} - Download artifact
 * - GET /maven/{groupId}/{artifactId}/maven-metadata.xml - Get artifact metadata
 * - HEAD /maven/{groupId}/{artifactId}/{version}/{filename} - Check artifact existence
 *
 * GroupId uses slashes instead of dots (e.g., org/springframework/spring-core)
 */
@Controller('maven')
export class MavenController {
  private readonly logger = new Logger(MavenController.name);
  private upstreamUrl: string;
  private repositoryId: string | null = null;
  private mavenGroupId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly artifactService: ArtifactService,
    private readonly configService: AmargoConfigService,
  ) {
    const mavenConfig = this.configService.getRepository('maven');
    this.upstreamUrl =
      mavenConfig.upstream || 'https://repo1.maven.org/maven2';
  }

  async onModuleInit() {
    // Ensure maven repository exists in database
    const mavenConfig = this.configService.getRepository('maven');

    let repository = await this.prisma.repository.findUnique({
      where: { name: 'maven' },
    });

    if (!repository) {
      repository = await this.prisma.repository.create({
        data: {
          name: 'maven',
          type: 'PROXY',
          format: 'MAVEN',
          description: 'Maven Central Repository',
          upstreamUrl: this.upstreamUrl,
          isProxyEnabled: true,
          cacheTtl: mavenConfig.cacheTtl,
        },
      });
      this.logger.log('Created maven repository in database');
    }

    this.repositoryId = repository.id;

    // Load maven group for group lookups
    const mavenGroup = await this.prisma.repositoryGroup.findUnique({
      where: { name: 'maven' },
    });

    if (mavenGroup) {
      this.mavenGroupId = mavenGroup.id;
      this.logger.log('Maven group enabled for fallback lookups');
    }
  }

  /**
   * Download Maven artifact or metadata
   * GET /maven/{path...}
   *
   * Handles all Maven repository paths including:
   * - Artifacts: /org/springframework/spring-core/5.3.0/spring-core-5.3.0.jar
   * - POMs: /org/springframework/spring-core/5.3.0/spring-core-5.3.0.pom
   * - Checksums: /org/springframework/spring-core/5.3.0/spring-core-5.3.0.jar.sha1
   * - Metadata: /org/springframework/spring-core/maven-metadata.xml
   */
  @Get('*artifactPath')
  async getArtifact(
    @Param('artifactPath') artifactPath: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.handleArtifactRequest('GET', artifactPath, req, res);
  }

  /**
   * Check Maven artifact existence
   * HEAD /maven/{path...}
   */
  @Head('*artifactPath')
  async headArtifact(
    @Param('artifactPath') artifactPath: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.handleArtifactRequest('HEAD', artifactPath, req, res);
  }

  /**
   * Handle artifact requests (GET/HEAD)
   */
  private async handleArtifactRequest(
    method: 'GET' | 'HEAD',
    artifactPath: string | string[],
    req: Request,
    res: Response,
  ) {
    const path = this.normalizePath(artifactPath);

    try {
      this.logger.debug(`${method} artifact: ${path}`);

      if (!this.repositoryId) {
        throw new InternalServerErrorException(
          'Maven repository not initialized',
        );
      }

      // Parse the path to extract groupId, artifactId, version, and filename
      const parsed = this.parseMavenPath(path);
      if (!parsed) {
        throw new NotFoundException(`Invalid Maven path: ${path}`);
      }

      const { groupId, artifactId, version, filename, isMetadata } = parsed;

      // Build artifact key for caching
      const artifactKey = isMetadata
        ? `${groupId}:${artifactId}:metadata`
        : `${groupId}:${artifactId}`;

      const artifactVersion = version || 'metadata';

      // Check cache - try group lookup if enabled
      let cached = await this.tryGroupLookup(artifactKey, artifactVersion);

      if (!cached && this.repositoryId) {
        // Fallback to direct repository lookup
        const directCached = await this.artifactService.getArtifact(
          this.repositoryId,
          artifactKey,
          artifactVersion,
        );
        if (directCached) {
          cached = { ...directCached, repositoryName: 'maven' };
        }
      }

      if (cached) {
        this.logger.debug(
          `Cache HIT: ${artifactKey}@${artifactVersion} (from ${cached.repositoryName})`,
        );

        // Record download stats (fire and forget)
        if (!isMetadata) {
          this.artifactService
            .recordDownload(
              this.repositoryId,
              artifactKey,
              artifactVersion,
              req.ip,
              req.get('user-agent'),
            )
            .catch((error) =>
              this.logger.error('Failed to record download:', error),
            );
        }

        // Set response headers
        res.setHeader('Content-Type', cached.artifact.contentType);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument
        res.setHeader('Content-Length', cached.artifact.size.toString());
        res.setHeader(
          'Cache-Control',
          isMetadata ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
        );
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        res.setHeader('ETag', `"${cached.artifact.checksum}"`);
        res.setHeader('X-Amargo-Cache', 'HIT');
        res.setHeader('X-Amargo-Repository', cached.repositoryName);

        if (method === 'GET') {
          cached.stream.pipe(res);
        } else {
          res.end();
        }
        return;
      }

      // Cache MISS - try fetching from upstream repositories in group
      this.logger.debug(`Cache MISS: ${artifactKey}@${artifactVersion}`);

      // Try group upstream fetch
      const groupFetch = await this.tryGroupUpstreamFetch(path, method);

      let upstreamResponse: any;
      let fetchRepositoryId: string;
      let fetchRepositoryName: string;

      if (groupFetch) {
        upstreamResponse = groupFetch.response;
        fetchRepositoryId = groupFetch.repositoryId;
        fetchRepositoryName = groupFetch.repositoryName;
      } else {
        // Fallback to default maven behavior
        this.logger.log(
          `[UPSTREAM FETCH] Fallback to maven: ${artifactKey}@${artifactVersion}`,
        );

        const fallbackUrl = `${this.upstreamUrl}/${path}`;
        upstreamResponse = await fetch(fallbackUrl, { method });

        fetchRepositoryId = this.repositoryId;
        fetchRepositoryName = 'maven';
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!upstreamResponse.ok) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (upstreamResponse.status === 404) {
          throw new NotFoundException(`Artifact not found: ${path}`);
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        throw new InternalServerErrorException(
          `Upstream returned status ${upstreamResponse.status}`,
        );
      }

      const contentType =
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        upstreamResponse.headers.get('content-type') ||
        this.getContentTypeFromFilename(filename);

      res.setHeader('Content-Type', contentType);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const contentLength = upstreamResponse.headers.get('content-length');
      if (contentLength) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        res.setHeader('Content-Length', contentLength);
      }
      res.setHeader(
        'Cache-Control',
        isMetadata ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
      );
      res.setHeader('X-Amargo-Cache', 'MISS');

      if (method === 'HEAD') {
        res.end();
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!upstreamResponse.body) {
        throw new InternalServerErrorException('Upstream response has no body');
      }

      // Stream artifact and cache it
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
      const nodeStream = Readable.fromWeb(upstreamResponse.body);
      const { PassThrough } = await import('stream');
      const clientStream = new PassThrough();
      const storageStream = new PassThrough();

      nodeStream.pipe(clientStream);
      nodeStream.pipe(storageStream);

      // Cache artifact asynchronously
      this.artifactService
        .storeArtifact({
          repositoryId: fetchRepositoryId,
          name: artifactKey,
          version: artifactVersion,
          stream: storageStream,
          contentType,
          metadata: {
            groupId,
            artifactId,
            version,
            filename,
            path,
            isMetadata,
            sourceRepository: fetchRepositoryName,
          },
        })
        .then(() => {
          this.logger.log(
            `Cached ${artifactKey}@${artifactVersion} in ${fetchRepositoryName}`,
          );
        })
        .catch((error) => {
          this.logger.error(
            `Failed to cache ${artifactKey}@${artifactVersion}:`,
            error,
          );
        });

      clientStream.pipe(res);
    } catch (error) {
      this.logger.error(`Failed to fetch artifact: ${path}`, error);
      throw error;
    }
  }

  /**
   * Normalize path from route parameter
   */
  private normalizePath(artifactPath: string | string[]): string {
    const path = Array.isArray(artifactPath)
      ? artifactPath.join('/')
      : artifactPath;
    return path.replace(/^\/+|\/+$/g, '');
  }

  /**
   * Parse Maven path to extract components
   *
   * Maven paths follow this structure:
   * - Artifact: {groupId}/{artifactId}/{version}/{artifactId}-{version}.{ext}
   * - Metadata: {groupId}/{artifactId}/maven-metadata.xml
   *
   * Examples:
   * - org/springframework/spring-core/5.3.0/spring-core-5.3.0.jar
   * - org/springframework/spring-core/maven-metadata.xml
   */
  private parseMavenPath(path: string): {
    groupId: string;
    artifactId: string;
    version: string | null;
    filename: string;
    isMetadata: boolean;
  } | null {
    const parts = path.split('/');

    if (parts.length < 3) {
      return null;
    }

    // Check if it's a metadata file
    const filename = parts[parts.length - 1];
    if (filename === 'maven-metadata.xml') {
      const artifactId = parts[parts.length - 2];
      const groupId = parts.slice(0, -2).join('.');
      return {
        groupId,
        artifactId,
        version: null,
        filename,
        isMetadata: true,
      };
    }

    // Regular artifact
    if (parts.length < 4) {
      return null;
    }

    const version = parts[parts.length - 2];
    const artifactId = parts[parts.length - 3];
    const groupId = parts.slice(0, -3).join('.');

    return {
      groupId,
      artifactId,
      version,
      filename,
      isMetadata: false,
    };
  }

  /**
   * Determine content type from filename extension
   */
  private getContentTypeFromFilename(filename: string): string {
    if (filename.endsWith('.jar')) {
      return 'application/java-archive';
    } else if (filename.endsWith('.pom')) {
      return 'application/xml';
    } else if (filename.endsWith('.xml')) {
      return 'application/xml';
    } else if (filename.endsWith('.war')) {
      return 'application/java-archive';
    } else if (filename.endsWith('.ear')) {
      return 'application/java-archive';
    } else if (filename.endsWith('.sha1') || filename.endsWith('.md5')) {
      return 'text/plain';
    } else if (filename.endsWith('.asc')) {
      return 'text/plain';
    }
    return 'application/octet-stream';
  }

  /**
   * Try to get artifact from repository group members (priority order)
   */
  private async tryGroupLookup(
    artifactKey: string,
    version: string,
  ): Promise<{
    stream: Readable;
    artifact: any;
    repositoryName: string;
  } | null> {
    if (!this.mavenGroupId) {
      return null;
    }

    const members = await this.prisma.repositoryGroupMember.findMany({
      where: { groupId: this.mavenGroupId },
      include: { repository: true },
      orderBy: { priority: 'asc' },
    });

    this.logger.log(
      `[GROUP LOOKUP] Checking ${members.length} repositories for: ${artifactKey}@${version}`,
    );

    for (const member of members) {
      this.logger.log(
        `[GROUP LOOKUP] → Trying repository: ${member.repository.name} (priority ${member.priority}, type: ${member.repository.type})`,
      );

      const cached = await this.artifactService.getArtifact(
        member.repository.id,
        artifactKey,
        version,
      );

      if (cached) {
        this.logger.log(
          `[GROUP LOOKUP] ✓ FOUND in repository: ${member.repository.name}`,
        );
        return {
          ...cached,
          repositoryName: member.repository.name,
        };
      } else {
        this.logger.log(
          `[GROUP LOOKUP] ✗ NOT FOUND in repository: ${member.repository.name}`,
        );
      }
    }

    this.logger.log(
      `[GROUP LOOKUP] Artifact not found in any repository: ${artifactKey}@${version}`,
    );
    return null;
  }

  /**
   * Try to fetch from upstream repositories in the group (priority order)
   */
  private async tryGroupUpstreamFetch(
    path: string,
    method: 'GET' | 'HEAD' = 'GET',
  ): Promise<{
    response: Response;
    repositoryId: string;
    repositoryName: string;
    upstreamUrl: string;
  } | null> {
    if (!this.mavenGroupId) {
      return null;
    }

    const members = await this.prisma.repositoryGroupMember.findMany({
      where: {
        groupId: this.mavenGroupId,
        repository: { type: 'PROXY' },
      },
      include: { repository: true },
      orderBy: { priority: 'asc' },
    });

    const proxyMembers = members.filter(
      (m) => m.repository.type === 'PROXY' && m.repository.upstreamUrl,
    );

    if (proxyMembers.length === 0) {
      return null;
    }

    this.logger.log(
      `[GROUP UPSTREAM] Trying ${proxyMembers.length} upstream repositories for: ${path}`,
    );

    for (const member of proxyMembers) {
      const upstream = member.repository.upstreamUrl!;
      const repoName = member.repository.name;

      this.logger.log(
        `[GROUP UPSTREAM] → Trying upstream: ${repoName} (${upstream})`,
      );

      try {
        const upstreamUrl = `${upstream}/${path}`;
        const upstreamResponse = await fetch(upstreamUrl, { method });

        if (upstreamResponse.ok) {
          this.logger.log(
            `[GROUP UPSTREAM] ✓ SUCCESS from: ${repoName} (${upstream})`,
          );
          return {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            response: upstreamResponse as any,
            repositoryId: member.repository.id,
            repositoryName: repoName,
            upstreamUrl: upstream,
          };
        } else {
          this.logger.log(
            `[GROUP UPSTREAM] ✗ FAILED from: ${repoName} (status: ${upstreamResponse.status})`,
          );
        }
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.logger.warn(
          `[GROUP UPSTREAM] ✗ ERROR from: ${repoName} - ${error.message}`,
        );
      }
    }

    this.logger.log(
      `[GROUP UPSTREAM] All upstream repositories failed for: ${path}`,
    );
    return null;
  }
}
