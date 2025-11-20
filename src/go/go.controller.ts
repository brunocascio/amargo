import {
  Controller,
  Get,
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
 * Go Module Proxy Implementation
 *
 * Go Module Proxy Protocol: https://go.dev/ref/mod#goproxy-protocol
 *
 * Endpoints:
 * - GET /{module}/@v/list - List available versions
 * - GET /{module}/@v/{version}.info - Get version metadata
 * - GET /{module}/@v/{version}.mod - Get go.mod file
 * - GET /{module}/@v/{version}.zip - Download module source
 * - GET /{module}/@latest - Get latest version info
 *
 * Module paths are case-sensitive and can contain multiple segments (e.g., github.com/user/repo)
 */
@Controller('go')
export class GoController {
  private readonly logger = new Logger(GoController.name);
  private upstreamUrl: string;
  private repositoryId: string | null = null;
  private goGroupId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly artifactService: ArtifactService,
    private readonly configService: AmargoConfigService,
  ) {
    const goConfig = this.configService.getRepository('go');
    this.upstreamUrl = goConfig.upstream || 'https://proxy.golang.org';
  }

  async onModuleInit() {
    // Ensure go repository exists in database
    const goConfig = this.configService.getRepository('go');

    let repository = await this.prisma.repository.findUnique({
      where: { name: 'go' },
    });

    if (!repository) {
      repository = await this.prisma.repository.create({
        data: {
          name: 'go',
          type: 'PROXY',
          format: 'GO',
          description: 'Go module proxy',
          upstreamUrl: this.upstreamUrl,
          isProxyEnabled: true,
          cacheTtl: goConfig.cacheTtl,
        },
      });
      this.logger.log('Created go repository in database');
    }

    this.repositoryId = repository.id;

    // Load go group for group lookups
    const goGroup = await this.prisma.repositoryGroup.findUnique({
      where: { name: 'go' },
    });

    if (goGroup) {
      this.goGroupId = goGroup.id;
      this.logger.log('Go group enabled for fallback lookups');
    }
  }

  /**
   * List available versions for a module
   * GET /go/{module}/@v/list
   *
   * Returns a list of known versions, one per line
   */
  @Get('*modulePath/@v/list')
  async listVersions(
    @Param('modulePath') modulePath: string | string[],
    @Res() res: Response,
  ) {
    const module = this.normalizeModulePath(modulePath);
    try {
      this.logger.debug(`Listing versions for module: ${module}`);

      const upstreamUrl = `${this.upstreamUrl}/${encodeModulePath(module)}/@v/list`;
      const response = await fetch(upstreamUrl);

      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          throw new NotFoundException(`Module ${module} not found`);
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${response.status}`,
        );
      }

      const versionList = await response.text();

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
      res.send(versionList);
    } catch (error) {
      this.logger.error(`Failed to list versions for module: ${module}`, error);
      throw error;
    }
  }

  /**
   * Get version metadata (.info file)
   * GET /go/{module}/@v/{version}.info
   *
   * Returns JSON with version and time
   * Example: {"Version":"v1.0.0","Time":"2023-01-01T00:00:00Z"}
   */
  @Get('*modulePath/@v/:version.info')
  async getVersionInfo(
    @Param('modulePath') modulePath: string | string[],
    @Param('version') version: string,
    @Res() res: Response,
  ) {
    const module = this.normalizeModulePath(modulePath);
    return this.handleVersionInfo(module, version, res);
  }

  /**
   * Get go.mod file for a specific version
   * GET /go/{module}/@v/{version}.mod
   *
   * Returns the go.mod file contents
   */
  @Get('*modulePath/@v/:version.mod')
  async getGoMod(
    @Param('modulePath') modulePath: string | string[],
    @Param('version') version: string,
    @Res() res: Response,
  ) {
    const module = this.normalizeModulePath(modulePath);
    return this.handleGoMod(module, version, res);
  }

  /**
   * Download module source (.zip file)
   * GET /go/{module}/@v/{version}.zip
   *
   * Returns a zip file containing the module source
   */
  @Get('*modulePath/@v/:version.zip')
  async getModuleZip(
    @Param('modulePath') modulePath: string | string[],
    @Param('version') version: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const module = this.normalizeModulePath(modulePath);
    return this.handleModuleZip(module, version, req, res);
  }

  /**
   * Get latest version info
   * GET /go/{module}/@latest
   *
   * Returns JSON with latest version info
   */
  @Get('*modulePath/@latest')
  async getLatest(
    @Param('modulePath') modulePath: string | string[],
    @Res() res: Response,
  ) {
    const module = this.normalizeModulePath(modulePath);
    try {
      this.logger.debug(`Fetching latest version for module: ${module}`);

      const upstreamUrl = `${this.upstreamUrl}/${encodeModulePath(module)}/@latest`;
      const response = await fetch(upstreamUrl);

      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          throw new NotFoundException(`Module ${module} not found`);
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${response.status}`,
        );
      }

      const latestInfo = (await response.json()) as unknown;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
      res.json(latestInfo);
    } catch (error) {
      this.logger.error(
        `Failed to fetch latest version for module: ${module}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Handle version info requests
   */
  private async handleVersionInfo(
    module: string,
    version: string,
    res: Response,
  ) {
    try {
      this.logger.debug(`Fetching version info: ${module}@${version}`);

      const upstreamUrl = `${this.upstreamUrl}/${encodeModulePath(module)}/@v/${version}.info`;
      const response = await fetch(upstreamUrl);

      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          this.logger.debug(
            `Version ${version} not found for module ${module} (expected for parent path lookups)`,
          );
          throw new NotFoundException(
            `Version ${version} not found for module ${module}`,
          );
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${response.status}`,
        );
      }

      const versionInfo = (await response.json()) as unknown;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day - versions are immutable
      res.json(versionInfo);
    } catch (error) {
      // Don't log 404s as errors - they're expected for parent path lookups
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(
        `Failed to fetch version info: ${module}@${version}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Handle go.mod file requests
   */
  private async handleGoMod(module: string, version: string, res: Response) {
    try {
      this.logger.debug(`Fetching go.mod: ${module}@${version}`);

      const upstreamUrl = `${this.upstreamUrl}/${encodeModulePath(module)}/@v/${version}.mod`;
      const response = await fetch(upstreamUrl);

      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          this.logger.debug(
            `go.mod not found for ${module}@${version} (expected for parent path lookups)`,
          );
          throw new NotFoundException(
            `go.mod not found for ${module}@${version}`,
          );
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${response.status}`,
        );
      }

      const goModContent = await response.text();

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable'); // 1 day - go.mod is immutable
      res.send(goModContent);
    } catch (error) {
      // Don't log 404s as errors - they're expected for parent path lookups
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Failed to fetch go.mod: ${module}@${version}`, error);
      throw error;
    }
  }

  /**
   * Handle module zip download with pull-through caching
   */
  private async handleModuleZip(
    module: string,
    version: string,
    req: Request,
    res: Response,
  ) {
    try {
      this.logger.debug(`Fetching module zip: ${module}@${version}`);

      if (!this.repositoryId) {
        throw new InternalServerErrorException('Go repository not initialized');
      }

      // Check cache - try group lookup if enabled
      const artifactKey = module;

      let cached = await this.tryGroupLookup(artifactKey, version);

      if (!cached && this.repositoryId) {
        // Fallback to direct repository lookup (backward compatibility)
        const directCached = await this.artifactService.getArtifact(
          this.repositoryId,
          artifactKey,
          version,
        );
        if (directCached) {
          cached = { ...directCached, repositoryName: 'go' };
        }
      }

      if (cached) {
        this.logger.debug(
          `Cache HIT: ${module}@${version} (from ${cached.repositoryName})`,
        );

        // Record download stats (fire and forget)
        this.artifactService
          .recordDownload(
            this.repositoryId,
            module,
            version,
            req.ip,
            req.get('user-agent'),
          )
          .catch((error) =>
            this.logger.error('Failed to record download:', error),
          );

        // Set response headers
        res.setHeader('Content-Type', 'application/zip');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument
        res.setHeader('Content-Length', cached.artifact.size.toString());
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        res.setHeader('ETag', `"${cached.artifact.checksum}"`);
        res.setHeader('X-Amargo-Cache', 'HIT');
        res.setHeader('X-Amargo-Repository', cached.repositoryName);

        // Stream from storage
        cached.stream.pipe(res);
        return;
      }

      // Cache MISS - try fetching from upstream repositories in group
      this.logger.debug(`Cache MISS: ${module}@${version}`);

      // Try group upstream fetch (tries each proxy in priority order)
      const groupFetch = await this.tryGroupUpstreamFetch(module, version);

      let upstreamResponse: any;
      let fetchRepositoryId: string;
      let fetchRepositoryName: string;

      if (groupFetch) {
        // Successfully fetched from one of the group's proxy repositories
        upstreamResponse = groupFetch.response;
        fetchRepositoryId = groupFetch.repositoryId;
        fetchRepositoryName = groupFetch.repositoryName;
      } else {
        // Fallback to default go behavior
        this.logger.log(
          `[UPSTREAM FETCH] Fallback to go: ${module}@${version}`,
        );

        const fallbackUrl = `${this.upstreamUrl}/${encodeModulePath(module)}/@v/${version}.zip`;
        upstreamResponse = await fetch(fallbackUrl);

        fetchRepositoryId = this.repositoryId;
        fetchRepositoryName = 'go';
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!upstreamResponse.ok) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          upstreamResponse.status === 404 ||
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          upstreamResponse.status === 410
        ) {
          throw new NotFoundException(
            `Module zip not found: ${module}@${version}`,
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        throw new InternalServerErrorException(
          `Upstream returned status ${upstreamResponse.status}`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!upstreamResponse.body) {
        throw new InternalServerErrorException('Upstream response has no body');
      }

      // Convert Web Streams ReadableStream to Node Readable
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
      const nodeStream = Readable.fromWeb(upstreamResponse.body);

      // We need to tee the stream: one for client, one for storage
      const { PassThrough } = await import('stream');
      const clientStream = new PassThrough();
      const storageStream = new PassThrough();

      nodeStream.pipe(clientStream);
      nodeStream.pipe(storageStream);

      // Store asynchronously (use the repository that successfully fetched it)
      this.artifactService
        .storeArtifact({
          repositoryId: fetchRepositoryId,
          name: module,
          version,
          stream: storageStream,
          contentType: 'application/zip',
          metadata: {
            type: 'module',
            source: 'go-upstream',
            sourceRepository: fetchRepositoryName,
          },
        })
        .then(() => {
          this.logger.log(
            `Cached ${module}@${version} in ${fetchRepositoryName}`,
          );
        })
        .catch((error) => {
          this.logger.error(`Failed to cache ${module}@${version}:`, error);
        });

      // Stream to client immediately
      res.setHeader('Content-Type', 'application/zip');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const contentLength = upstreamResponse.headers.get('content-length');
      if (contentLength) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        res.setHeader('Content-Length', contentLength);
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Amargo-Cache', 'MISS');

      clientStream.pipe(res);
    } catch (error) {
      this.logger.error(`Failed to fetch module: ${module}@${version}`, error);
      throw error;
    }
  }

  /**
   * Normalize module path from route parameter
   * Handles both single string and array of path segments
   */
  private normalizeModulePath(modulePath: string | string[]): string {
    const path = Array.isArray(modulePath)
      ? modulePath.join('/')
      : modulePath;
    return path.replace(/\/$/, '');
  }

  /**
   * Try to get artifact from repository group members (priority order)
   * Returns the first found artifact or null if none found
   */
  private async tryGroupLookup(
    artifactKey: string,
    version: string,
  ): Promise<{
    stream: Readable;
    artifact: any;
    repositoryName: string;
  } | null> {
    if (!this.goGroupId) {
      return null;
    }

    // Get group members ordered by priority
    const members = await this.prisma.repositoryGroupMember.findMany({
      where: { groupId: this.goGroupId },
      include: { repository: true },
      orderBy: { priority: 'asc' },
    });

    this.logger.log(
      `[GROUP LOOKUP] Checking ${members.length} repositories for: ${artifactKey}@${version}`,
    );

    // Try each member in priority order
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
   * Returns the first successful fetch or null if all fail
   */
  private async tryGroupUpstreamFetch(
    module: string,
    version: string,
  ): Promise<{
    response: Response;
    repositoryId: string;
    repositoryName: string;
    upstreamUrl: string;
  } | null> {
    if (!this.goGroupId) {
      return null;
    }

    // Get PROXY members from the group (ordered by priority)
    const members = await this.prisma.repositoryGroupMember.findMany({
      where: {
        groupId: this.goGroupId,
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
      `[GROUP UPSTREAM] Trying ${proxyMembers.length} upstream repositories for: ${module}@${version}`,
    );

    // Try each proxy in priority order
    for (const member of proxyMembers) {
      const upstream = member.repository.upstreamUrl!;
      const repoName = member.repository.name;

      this.logger.log(
        `[GROUP UPSTREAM] → Trying upstream: ${repoName} (${upstream})`,
      );

      try {
        const upstreamUrl = `${upstream}/${encodeModulePath(module)}/@v/${version}.zip`;
        const upstreamResponse = await fetch(upstreamUrl);

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
      `[GROUP UPSTREAM] All upstream repositories failed for: ${module}@${version}`,
    );
    return null;
  }
}

/**
 * Encode module path for Go proxy URLs
 * Upper case letters are converted to !lowercase
 * Example: github.com/User/Repo -> github.com/!user/!repo
 */
function encodeModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}
