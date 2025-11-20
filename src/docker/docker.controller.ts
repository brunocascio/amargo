import {
  Controller,
  Get,
  Head,
  Logger,
  Param,
  Req,
  Res,
  Headers,
  NotFoundException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { ArtifactService } from '../artifact/artifact.service';
import { AmargoConfigService } from '../config/amargo-config.service';
import { Readable } from 'stream';

/**
 * Docker Registry API v2 implementation
 * Spec: https://docs.docker.com/registry/spec/api/
 */
@Controller('v2')
export class DockerController {
  private readonly logger = new Logger(DockerController.name);
  private upstreamUrl: string;
  private repositoryId: string | null = null;
  private dockerGroupId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly artifactService: ArtifactService,
    private readonly configService: AmargoConfigService,
  ) {
    const dockerConfig = this.configService.getRepository('docker-proxy');
    this.upstreamUrl = dockerConfig.upstream || 'https://registry-1.docker.io';
  }

  async onModuleInit() {
    const dockerConfig = this.configService.getRepository('docker-proxy');

    let repository = await this.prisma.repository.findUnique({
      where: { name: 'docker-proxy' },
    });

    if (!repository) {
      repository = await this.prisma.repository.create({
        data: {
          name: 'docker-proxy',
          type: 'PROXY',
          format: 'DOCKER',
          description: 'Docker container registry proxy',
          upstreamUrl: this.upstreamUrl,
          isProxyEnabled: true,
          cacheTtl: dockerConfig.cacheTtl,
        },
      });
      this.logger.log('Created docker-proxy repository in database');
    }

    this.repositoryId = repository.id;

    // Load docker group for group lookups
    const dockerGroup = await this.prisma.repositoryGroup.findUnique({
      where: { name: 'docker' },
    });

    if (dockerGroup) {
      this.dockerGroupId = dockerGroup.id;
      this.logger.log('Docker group enabled for fallback lookups');
    }
  }

  /**
   * Version check - required by Docker client
   * GET /v2/
   */
  @Get()
  ping(@Res() res: Response) {
    res.setHeader('Docker-Distribution-API-Version', 'registry/2.0');
    res.json({});
  }

  /**
   * Get image manifest
   * GET /v2/:name/manifests/:reference or /v2/:scope/:name/manifests/:reference
   * reference can be a tag or digest
   * Uses wildcard to match multi-segment image names
   */
  @Get('*imagePath/manifests/:reference')
  async getManifest(
    @Param('imagePath') imagePath: string,
    @Param('reference') reference: string,
    @Headers('accept') accept: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // imagePath comes as array from wildcard, join it back to string
    const fullImagePath = Array.isArray(imagePath)
      ? imagePath.join('/')
      : imagePath;
    return this.handleManifest(
      'GET',
      fullImagePath,
      reference,
      accept,
      req,
      res,
    );
  }

  /**
   * Head image manifest
   * HEAD /v2/:name/manifests/:reference
   */
  @Head('*imagePath/manifests/:reference')
  async headManifest(
    @Param('imagePath') imagePath: string,
    @Param('reference') reference: string,
    @Headers('accept') accept: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const fullImagePath = Array.isArray(imagePath)
      ? imagePath.join('/')
      : imagePath;
    return this.handleManifest(
      'HEAD',
      fullImagePath,
      reference,
      accept,
      req,
      res,
    );
  }

  /**
   * Get image blob/layer
   * GET /v2/:name/blobs/:digest
   */
  @Get('*imagePath/blobs/:digest')
  async getBlob(
    @Param('imagePath') imagePath: string,
    @Param('digest') digest: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const fullImagePath = Array.isArray(imagePath)
      ? imagePath.join('/')
      : imagePath;
    return this.handleBlob('GET', fullImagePath, digest, req, res);
  }

  /**
   * Head image blob/layer
   * HEAD /v2/:name/blobs/:digest
   */
  @Head('*imagePath/blobs/:digest')
  async headBlob(
    @Param('imagePath') imagePath: string,
    @Param('digest') digest: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const fullImagePath = Array.isArray(imagePath)
      ? imagePath.join('/')
      : imagePath;
    return this.handleBlob('HEAD', fullImagePath, digest, req, res);
  }

  /**
   * Handle manifest requests (GET/HEAD)
   */
  private async handleManifest(
    method: 'GET' | 'HEAD',
    name: string,
    reference: string,
    accept: string | undefined,
    req: Request,
    res: Response,
  ) {
    try {
      this.logger.debug(
        `${method} manifest: ${name}:${reference} (accept: ${accept || 'default'})`,
      );

      if (!this.repositoryId) {
        throw new InternalServerErrorException(
          'Docker repository not initialized',
        );
      }

      // For Docker Hub, prepend 'library/' for official images
      const upstreamName = this.normalizeImageName(name);

      // Check cache first - try group lookup if enabled
      const artifactKey = `${name}:manifest:${reference}`;

      let cached = await this.tryGroupLookup(artifactKey, reference);

      if (!cached && this.repositoryId) {
        // Fallback to direct repository lookup (backward compatibility)
        const directCached = await this.artifactService.getArtifact(
          this.repositoryId,
          artifactKey,
          reference,
        );
        if (directCached) {
          cached = { ...directCached, repositoryName: 'docker-proxy' };
        }
      }

      if (cached) {
        this.logger.debug(
          `Cache HIT: manifest ${name}:${reference} (from ${cached.repositoryName})`,
        );

        res.setHeader(
          'Content-Type',
          cached.artifact.contentType ||
            'application/vnd.docker.distribution.manifest.v2+json',
        );
        res.setHeader('Content-Length', cached.artifact.size.toString());

        // Ensure Docker-Content-Digest has sha256: prefix
        const digest = cached.artifact.checksum.startsWith('sha256:')
          ? cached.artifact.checksum
          : `sha256:${cached.artifact.checksum}`;
        res.setHeader('Docker-Content-Digest', digest);
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
      this.logger.debug(`Cache MISS: manifest ${name}:${reference}`);

      // Try group upstream fetch (tries each proxy in priority order)
      const groupFetch = await this.tryGroupUpstreamFetch(
        name,
        reference,
        accept,
        method,
      );

      let upstreamResponse: any;
      let fetchRepositoryId: string;
      let fetchRepositoryName: string;

      if (groupFetch) {
        // Successfully fetched from one of the group's proxy repositories
        upstreamResponse = groupFetch.response;
        fetchRepositoryId = groupFetch.repositoryId;
        fetchRepositoryName = groupFetch.repositoryName;
      } else {
        // Fallback to default docker-proxy behavior
        this.logger.log(
          `[UPSTREAM FETCH] Fallback to docker-proxy: ${upstreamName}:${reference}`,
        );

        const token = await this.getDockerHubToken(upstreamName);
        const fallbackUrl = `${this.upstreamUrl}/v2/${upstreamName}/manifests/${reference}`;

        const headers: Record<string, string> = {
          Accept:
            accept ||
            'application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json',
        };

        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        upstreamResponse = await fetch(fallbackUrl, {
          method,
          headers,
        });

        fetchRepositoryId = this.repositoryId!;
        fetchRepositoryName = 'docker-proxy';
      }

      if (!upstreamResponse.ok) {
        if (upstreamResponse.status === 404) {
          throw new NotFoundException(
            `Manifest not found: ${name}:${reference}`,
          );
        }
        if (upstreamResponse.status === 401) {
          throw new UnauthorizedException('Upstream authentication failed');
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${upstreamResponse.status}`,
        );
      }

      const contentType =
        upstreamResponse.headers.get('content-type') ||
        'application/vnd.docker.distribution.manifest.v2+json';
      const dockerDigest = upstreamResponse.headers.get(
        'docker-content-digest',
      );

      res.setHeader('Content-Type', contentType);
      if (dockerDigest) {
        res.setHeader('Docker-Content-Digest', dockerDigest);
      }

      const contentLength = upstreamResponse.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      res.setHeader('X-Amargo-Cache', 'MISS');

      if (method === 'HEAD') {
        res.end();
        return;
      }

      if (!upstreamResponse.body) {
        throw new InternalServerErrorException('Upstream response has no body');
      }

      // Stream manifest and cache it
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const nodeStream = Readable.fromWeb(upstreamResponse.body);
      const { PassThrough } = await import('stream');
      const clientStream = new PassThrough();
      const storageStream = new PassThrough();

      nodeStream.pipe(clientStream);
      nodeStream.pipe(storageStream);

      // Cache manifest asynchronously (use the repository that successfully fetched it)
      this.artifactService
        .storeArtifact({
          repositoryId: fetchRepositoryId,
          name: artifactKey,
          version: reference,
          stream: storageStream,
          contentType,
          metadata: {
            type: 'manifest',
            imageName: name,
            digest: dockerDigest,
            sourceRepository: fetchRepositoryName,
          },
        })
        .then(() => {
          this.logger.log(
            `Cached manifest ${name}:${reference} in ${fetchRepositoryName}`,
          );
        })
        .catch((error) => {
          this.logger.error(
            `Failed to cache manifest ${name}:${reference}:`,
            error,
          );
        });

      clientStream.pipe(res);
    } catch (error) {
      this.logger.error(`Failed to fetch manifest ${name}:${reference}`, error);
      throw error;
    }
  }

  /**
   * Handle blob requests (GET/HEAD)
   */
  private async handleBlob(
    method: 'GET' | 'HEAD',
    name: string,
    digest: string,
    req: Request,
    res: Response,
  ) {
    try {
      this.logger.debug(`${method} blob: ${name} ${digest}`);

      if (!this.repositoryId) {
        throw new InternalServerErrorException(
          'Docker repository not initialized',
        );
      }

      const upstreamName = this.normalizeImageName(name);

      // Check cache - try group lookup if enabled
      const artifactKey = `${name}:blob:${digest}`;

      let cached = await this.tryGroupLookup(artifactKey, digest);

      if (!cached && this.repositoryId) {
        // Fallback to direct repository lookup (backward compatibility)
        const directCached = await this.artifactService.getArtifact(
          this.repositoryId,
          artifactKey,
          digest,
        );
        if (directCached) {
          cached = { ...directCached, repositoryName: 'docker-proxy' };
        }
      }

      if (cached) {
        this.logger.debug(
          `Cache HIT: blob ${digest} (from ${cached.repositoryName})`,
        );

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', cached.artifact.size.toString());
        res.setHeader('Docker-Content-Digest', digest);
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
      this.logger.debug(`Cache MISS: blob ${digest}`);

      // Try group upstream fetch for blobs
      const groupFetch = await this.tryGroupUpstreamFetchBlob(
        name,
        digest,
        method,
      );

      let upstreamResponse: any;
      let fetchRepositoryId: string;
      let fetchRepositoryName: string;

      if (groupFetch) {
        // Successfully fetched from one of the group's proxy repositories
        upstreamResponse = groupFetch.response;
        fetchRepositoryId = groupFetch.repositoryId;
        fetchRepositoryName = groupFetch.repositoryName;
      } else {
        // Fallback to default docker-proxy behavior
        this.logger.log(
          `[UPSTREAM FETCH] Fallback to docker-proxy for blob: ${digest}`,
        );

        const token = await this.getDockerHubToken(upstreamName);
        const fallbackUrl = `${this.upstreamUrl}/v2/${upstreamName}/blobs/${digest}`;

        const headers: Record<string, string> = {};
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        upstreamResponse = await fetch(fallbackUrl, {
          method,
          headers,
        });

        fetchRepositoryId = this.repositoryId!;
        fetchRepositoryName = 'docker-proxy';
      }

      if (!upstreamResponse.ok) {
        if (upstreamResponse.status === 404) {
          throw new NotFoundException(`Blob not found: ${digest}`);
        }
        if (upstreamResponse.status === 401) {
          throw new UnauthorizedException('Upstream authentication failed');
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${upstreamResponse.status}`,
        );
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Docker-Content-Digest', digest);

      const contentLength = upstreamResponse.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      res.setHeader('X-Amargo-Cache', 'MISS');

      if (method === 'HEAD') {
        res.end();
        return;
      }

      if (!upstreamResponse.body) {
        throw new InternalServerErrorException('Upstream response has no body');
      }

      // Stream blob and cache it
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const nodeStream = Readable.fromWeb(upstreamResponse.body);
      const { PassThrough } = await import('stream');
      const clientStream = new PassThrough();
      const storageStream = new PassThrough();

      nodeStream.pipe(clientStream);
      nodeStream.pipe(storageStream);

      // Cache blob asynchronously (use the repository that successfully fetched it)
      this.artifactService
        .storeArtifact({
          repositoryId: fetchRepositoryId,
          name: artifactKey,
          version: digest,
          stream: storageStream,
          contentType: 'application/octet-stream',
          metadata: {
            type: 'blob',
            imageName: name,
            digest,
            sourceRepository: fetchRepositoryName,
          },
        })
        .then(() => {
          this.logger.log(`Cached blob ${digest} in ${fetchRepositoryName}`);
        })
        .catch((error) => {
          this.logger.error(`Failed to cache blob ${digest}:`, error);
        });

      clientStream.pipe(res);
    } catch (error) {
      this.logger.error(`Failed to fetch blob ${digest}`, error);
      throw error;
    }
  }

  /**
   * Normalize image name for Docker Hub
   * Official images need 'library/' prefix
   */
  private normalizeImageName(name: string): string {
    // If image name has no slash, it's an official image
    // Docker Hub requires library/ prefix for these
    if (!name.includes('/')) {
      return `library/${name}`;
    }
    return name;
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
    if (!this.dockerGroupId) {
      return null;
    }

    // Get group members ordered by priority
    const members = await this.prisma.repositoryGroupMember.findMany({
      where: { groupId: this.dockerGroupId },
      include: { repository: true },
      orderBy: { priority: 'asc' },
    });

    this.logger.log(
      `[GROUP LOOKUP] Checking ${members.length} repositories for: ${artifactKey}`,
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
      `[GROUP LOOKUP] Artifact not found in any repository: ${artifactKey}`,
    );
    return null;
  }

  /**
   * Try to fetch from upstream repositories in the group (priority order)
   * Returns the first successful fetch or null if all fail
   */
  private async tryGroupUpstreamFetch(
    name: string,
    reference: string,
    accept: string | undefined,
    method: 'GET' | 'HEAD' = 'GET',
  ): Promise<{
    response: Response;
    repositoryId: string;
    repositoryName: string;
    upstreamUrl: string;
  } | null> {
    if (!this.dockerGroupId) {
      return null;
    }

    // Get PROXY members from the group (ordered by priority)
    const members = await this.prisma.repositoryGroupMember.findMany({
      where: {
        groupId: this.dockerGroupId,
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
      `[GROUP UPSTREAM] Trying ${proxyMembers.length} upstream repositories for: ${name}:${reference}`,
    );

    // Try each proxy in priority order
    for (const member of proxyMembers) {
      const upstream = member.repository.upstreamUrl!;
      const repoName = member.repository.name;

      this.logger.log(
        `[GROUP UPSTREAM] → Trying upstream: ${repoName} (${upstream})`,
      );

      try {
        // For Docker Hub, normalize image name
        const upstreamName = upstream.includes('docker.io')
          ? this.normalizeImageName(name)
          : name;

        // Get token if needed (only for Docker Hub)
        let token: string | null = null;
        if (upstream.includes('docker.io')) {
          token = await this.getDockerHubToken(upstreamName);
        }

        const upstreamUrl = `${upstream}/v2/${upstreamName}/manifests/${reference}`;

        const headers: Record<string, string> = {
          Accept:
            accept ||
            'application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json',
        };

        if (token) {
          headers.Authorization = `Bearer ${token}`;
        } else if (
          member.repository.upstreamUsername &&
          member.repository.upstreamPassword
        ) {
          // Use Basic Auth for authenticated upstreams (e.g., Nexus)
          const credentials = Buffer.from(
            `${member.repository.upstreamUsername}:${member.repository.upstreamPassword}`,
          ).toString('base64');
          headers.Authorization = `Basic ${credentials}`;
        }

        const upstreamResponse = await fetch(upstreamUrl, {
          method,
          headers,
        });

        if (upstreamResponse.ok) {
          this.logger.log(
            `[GROUP UPSTREAM] ✓ SUCCESS from: ${repoName} (${upstream})`,
          );
          return {
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[GROUP UPSTREAM] ✗ ERROR from: ${repoName} - ${errorMessage}`,
        );
      }
    }

    this.logger.log(
      `[GROUP UPSTREAM] All upstream repositories failed for: ${name}:${reference}`,
    );
    return null;
  }

  /**
   * Try to fetch blob from upstream repositories in the group (priority order)
   */
  private async tryGroupUpstreamFetchBlob(
    name: string,
    digest: string,
    method: 'GET' | 'HEAD' = 'GET',
  ): Promise<{
    response: Response;
    repositoryId: string;
    repositoryName: string;
    upstreamUrl: string;
  } | null> {
    if (!this.dockerGroupId) {
      return null;
    }

    // Get PROXY members from the group (ordered by priority)
    const members = await this.prisma.repositoryGroupMember.findMany({
      where: {
        groupId: this.dockerGroupId,
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
      `[GROUP UPSTREAM] Trying ${proxyMembers.length} upstream repositories for blob: ${digest}`,
    );

    // Try each proxy in priority order
    for (const member of proxyMembers) {
      const upstream = member.repository.upstreamUrl!;
      const repoName = member.repository.name;

      this.logger.log(
        `[GROUP UPSTREAM] → Trying upstream: ${repoName} (${upstream})`,
      );

      try {
        // For Docker Hub, normalize image name
        const upstreamName = upstream.includes('docker.io')
          ? this.normalizeImageName(name)
          : name;

        // Get token if needed (only for Docker Hub)
        let token: string | null = null;
        if (upstream.includes('docker.io')) {
          token = await this.getDockerHubToken(upstreamName);
        }

        const upstreamUrl = `${upstream}/v2/${upstreamName}/blobs/${digest}`;

        const headers: Record<string, string> = {};
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        } else if (
          member.repository.upstreamUsername &&
          member.repository.upstreamPassword
        ) {
          // Use Basic Auth for authenticated upstreams (e.g., Nexus)
          const credentials = Buffer.from(
            `${member.repository.upstreamUsername}:${member.repository.upstreamPassword}`,
          ).toString('base64');
          headers.Authorization = `Basic ${credentials}`;
        }

        const upstreamResponse = await fetch(upstreamUrl, {
          method,
          headers,
        });

        if (upstreamResponse.ok) {
          this.logger.log(
            `[GROUP UPSTREAM] ✓ SUCCESS from: ${repoName} (${upstream})`,
          );
          return {
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[GROUP UPSTREAM] ✗ ERROR from: ${repoName} - ${errorMessage}`,
        );
      }
    }

    this.logger.log(
      `[GROUP UPSTREAM] All upstream repositories failed for blob: ${digest}`,
    );
    return null;
  }

  /**
   * Get Docker Hub authentication token
   * Required for pulling public images from Docker Hub
   */
  private async getDockerHubToken(imageName: string): Promise<string | null> {
    try {
      const authUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${imageName}:pull`;
      const response = await fetch(authUrl);

      if (!response.ok) {
        this.logger.warn(
          `Failed to get Docker Hub token for ${imageName}: ${response.status}`,
        );
        return null;
      }

      const data = (await response.json()) as { token?: string };
      return data.token || null;
    } catch (error) {
      this.logger.error('Failed to get Docker Hub token:', error);
      return null;
    }
  }
}
