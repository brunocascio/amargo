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
 * PyPI (Python Package Index) Proxy Implementation
 *
 * PyPI Simple API: https://peps.python.org/pep-0503/
 *
 * Endpoints:
 * - GET /pypi/simple/ - Package index (list all packages)
 * - GET /pypi/simple/:package/ - Package page (list all versions/files)
 * - GET /pypi/packages/:path - Download package file
 */
@Controller('pypi')
export class PypiController {
  private readonly logger = new Logger(PypiController.name);
  private upstreamUrl: string;
  private repositoryId: string | null = null;
  private pypiGroupId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly artifactService: ArtifactService,
    private readonly configService: AmargoConfigService,
  ) {
    const pypiConfig = this.configService.getRepository('pypi');
    this.upstreamUrl = pypiConfig.upstream || 'https://pypi.org';
  }

  async onModuleInit() {
    // Ensure pypi repository exists in database
    const pypiConfig = this.configService.getRepository('pypi');

    let repository = await this.prisma.repository.findUnique({
      where: { name: 'pypi' },
    });

    if (!repository) {
      repository = await this.prisma.repository.create({
        data: {
          name: 'pypi',
          type: 'PROXY',
          format: 'PYPI',
          description: 'Python Package Index',
          upstreamUrl: this.upstreamUrl,
          isProxyEnabled: true,
          cacheTtl: pypiConfig.cacheTtl,
        },
      });
      this.logger.log('Created pypi repository in database');
    }

    this.repositoryId = repository.id;

    // Load pypi group for group lookups
    const pypiGroup = await this.prisma.repositoryGroup.findUnique({
      where: { name: 'pypi' },
    });

    if (pypiGroup) {
      this.pypiGroupId = pypiGroup.id;
      this.logger.log('PyPI group enabled for fallback lookups');
    }
  }

  /**
   * Package index - list all packages
   * GET /pypi/simple/
   */
  @Get('simple')
  async getPackageIndex(@Res() res: Response) {
    try {
      this.logger.debug('Fetching PyPI package index');

      const response = await fetch(`${this.upstreamUrl}/simple/`);

      if (!response.ok) {
        throw new InternalServerErrorException(
          `Upstream returned status ${response.status}`,
        );
      }

      const html = await response.text();

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=600'); // 10 minutes
      res.send(html);
    } catch (error) {
      this.logger.error('Failed to fetch package index', error);
      throw error;
    }
  }

  /**
   * Package page - list all versions and download links for a package
   * GET /pypi/simple/:package/
   *
   * Package names are case-insensitive and normalized (hyphens/underscores are treated as equivalent)
   */
  @Get('simple/:package')
  async getPackagePage(
    @Param('package') packageName: string,
    @Res() res: Response,
  ) {
    try {
      const normalizedName = this.normalizePackageName(packageName);
      this.logger.debug(`Fetching package page: ${normalizedName}`);

      const response = await fetch(
        `${this.upstreamUrl}/simple/${normalizedName}/`,
      );

      if (!response.ok) {
        if (response.status === 404) {
          throw new NotFoundException(`Package ${packageName} not found`);
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${response.status}`,
        );
      }

      // Get the HTML content
      let html = await response.text();

      // Rewrite package download URLs to point to our proxy
      // PyPI simple API uses relative URLs like: ../../packages/...
      // We need to proxy these through our /pypi/packages/ endpoint
      html = this.rewritePackageUrls(html);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
      res.send(html);
    } catch (error) {
      this.logger.error(`Failed to fetch package page: ${packageName}`, error);
      throw error;
    }
  }

  /**
   * Download package file with pull-through caching
   * GET /pypi/packages/:p1/:p2/:p3/:filename
   *
   * PyPI uses a specific URL structure:
   * /packages/{hash_prefix}/{hash_suffix}/{hash_full}/{filename}
   *
   * Example: /packages/ba/bb/dfa0141a32d773c47e4dede1a617c59a23b74dd302e449cf85413fc96bc4/requests-0.2.0.tar.gz
   */
  @Get('packages/:p1/:p2/:p3/:filename')
  async getPackageFile(
    @Param('p1') p1: string,
    @Param('p2') p2: string,
    @Param('p3') p3: string,
    @Param('filename') filename: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Reconstruct the full package path
    const packagePath = `${p1}/${p2}/${p3}/${filename}`;
    return this.handlePackageDownload(packagePath, filename, req, res);
  }

  /**
   * Handle package download logic
   */
  private async handlePackageDownload(
    packagePath: string,
    filename: string,
    req: Request,
    res: Response,
  ) {
    try {
      this.logger.debug(`Fetching package file: ${packagePath}`);

      // Extract package name and version from filename
      const { name, version } = this.parseFilename(filename);

      if (!name || !version) {
        throw new NotFoundException(`Invalid package filename: ${filename}`);
      }

      if (!this.repositoryId) {
        throw new InternalServerErrorException(
          'PyPI repository not initialized',
        );
      }

      // Check cache - try group lookup if enabled
      const artifactKey = name;

      let cached = await this.tryGroupLookup(artifactKey, version);

      if (!cached && this.repositoryId) {
        // Fallback to direct repository lookup (backward compatibility)
        const directCached = await this.artifactService.getArtifact(
          this.repositoryId,
          artifactKey,
          version,
        );
        if (directCached) {
          cached = { ...directCached, repositoryName: 'pypi' };
        }
      }

      if (cached) {
        this.logger.debug(
          `Cache HIT: ${name}@${version} (from ${cached.repositoryName})`,
        );

        // Record download stats (fire and forget)
        this.artifactService
          .recordDownload(
            this.repositoryId,
            name,
            version,
            req.ip,
            req.get('user-agent'),
          )
          .catch((error) =>
            this.logger.error('Failed to record download:', error),
          );

        // Set response headers
        res.setHeader('Content-Type', cached.artifact.contentType);
        res.setHeader('Content-Length', cached.artifact.size.toString());
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
        res.setHeader('ETag', `"${cached.artifact.checksum}"`);
        res.setHeader('X-Amargo-Cache', 'HIT');
        res.setHeader('X-Amargo-Repository', cached.repositoryName);

        // Stream from storage
        cached.stream.pipe(res);
        return;
      }

      // Cache MISS - try fetching from upstream repositories in group
      this.logger.debug(`Cache MISS: ${name}@${version}`);

      // Try group upstream fetch (tries each proxy in priority order)
      const groupFetch = await this.tryGroupUpstreamFetch(
        name,
        version,
        packagePath,
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
        // Fallback to default pypi behavior
        this.logger.log(
          `[UPSTREAM FETCH] Fallback to pypi: ${name}@${version}`,
        );

        const fallbackUrl = `${this.upstreamUrl}/packages/${packagePath}`;
        upstreamResponse = await fetch(fallbackUrl);

        fetchRepositoryId = this.repositoryId;
        fetchRepositoryName = 'pypi';
      }

      if (!upstreamResponse.ok) {
        if (upstreamResponse.status === 404) {
          throw new NotFoundException(`Package file not found: ${filename}`);
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${upstreamResponse.status}`,
        );
      }

      if (!upstreamResponse.body) {
        throw new InternalServerErrorException('Upstream response has no body');
      }

      // Convert Web Streams ReadableStream to Node Readable
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const nodeStream = Readable.fromWeb(upstreamResponse.body as any);

      // We need to tee the stream: one for client, one for storage
      const { PassThrough } = await import('stream');
      const clientStream = new PassThrough();
      const storageStream = new PassThrough();

      nodeStream.pipe(clientStream);
      nodeStream.pipe(storageStream);

      // Determine content type
      const contentType =
        upstreamResponse.headers.get('content-type') ||
        this.getContentTypeFromFilename(filename);

      // Store asynchronously (use the repository that successfully fetched it)
      this.artifactService
        .storeArtifact({
          repositoryId: fetchRepositoryId,
          name,
          version,
          stream: storageStream,
          contentType,
          metadata: {
            filename,
            originalPath: packagePath,
            source: 'pypi-upstream',
            sourceRepository: fetchRepositoryName,
          },
        })
        .then(() => {
          this.logger.log(
            `Cached ${name}@${version} in ${fetchRepositoryName}`,
          );
        })
        .catch((error) => {
          this.logger.error(`Failed to cache ${name}@${version}:`, error);
        });

      // Stream to client immediately
      res.setHeader('Content-Type', contentType);
      const contentLength = upstreamResponse.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Amargo-Cache', 'MISS');

      clientStream.pipe(res);
    } catch (error) {
      this.logger.error(`Failed to fetch package: ${packagePath}`, error);
      throw error;
    }
  }

  /**
   * Normalize package name according to PEP 503
   * Convert to lowercase and replace runs of [._-] with a single dash
   */
  private normalizePackageName(name: string): string {
    return name.toLowerCase().replace(/[-_.]+/g, '-');
  }

  /**
   * Parse package name and version from filename
   *
   * Python package filenames follow these patterns:
   * - Wheel: {name}-{version}(-{build})?-{python}-{abi}-{platform}.whl
   * - Source: {name}-{version}.tar.gz or {name}-{version}.zip
   *
   * Examples:
   * - requests-2.28.1-py3-none-any.whl
   * - Django-4.2.1.tar.gz
   * - numpy-1.24.0-cp39-cp39-manylinux_2_17_x86_64.whl
   */
  private parseFilename(filename: string): { name: string; version: string } {
    // Remove extension
    let nameWithVersion = filename;

    // Handle common Python package extensions
    if (filename.endsWith('.whl')) {
      nameWithVersion = filename.slice(0, -4);
    } else if (filename.endsWith('.tar.gz')) {
      nameWithVersion = filename.slice(0, -7);
    } else if (filename.endsWith('.tar.bz2')) {
      nameWithVersion = filename.slice(0, -8);
    } else if (filename.endsWith('.zip')) {
      nameWithVersion = filename.slice(0, -4);
    } else if (filename.endsWith('.egg')) {
      nameWithVersion = filename.slice(0, -4);
    }

    // For wheel files, extract name and version before the first hyphen after version
    // Format: {name}-{version}-{build}-{python}-{abi}-{platform}
    if (filename.endsWith('.whl')) {
      const parts = nameWithVersion.split('-');
      if (parts.length >= 2) {
        const name = parts[0];
        const version = parts[1];
        return { name: this.normalizePackageName(name), version };
      }
    }

    // For source distributions, the format is simpler: {name}-{version}
    const match = nameWithVersion.match(/^(.+?)-([0-9].*)$/);
    if (match) {
      const name = match[1];
      const version = match[2];
      return { name: this.normalizePackageName(name), version };
    }

    // Fallback: couldn't parse
    return { name: '', version: '' };
  }

  /**
   * Rewrite package URLs in HTML to point to our proxy
   *
   * PyPI simple API can use different URL patterns:
   * - Relative URLs: ../../packages/a1/b2/c3d4e5f6.../package-1.0.0.whl
   * - Absolute URLs: https://files.pythonhosted.org/packages/a1/b2/c3d4e5f6.../package-1.0.0.whl
   *
   * We rewrite these to absolute URLs pointing to our proxy:
   * /pypi/packages/a1/b2/c3d4e5f6.../package-1.0.0.whl
   */
  private rewritePackageUrls(html: string): string {
    // Replace relative URLs that start with ../../packages/
    let rewritten = html.replace(
      /href="\.\.\/\.\.\/packages\//g,
      'href="/pypi/packages/',
    );

    // Replace absolute URLs from files.pythonhosted.org
    rewritten = rewritten.replace(
      /href="https:\/\/files\.pythonhosted\.org\/packages\//g,
      'href="/pypi/packages/',
    );

    return rewritten;
  }

  /**
   * Determine content type from filename extension
   */
  private getContentTypeFromFilename(filename: string): string {
    if (filename.endsWith('.whl')) {
      return 'application/zip'; // Wheel files are ZIP archives
    } else if (filename.endsWith('.tar.gz') || filename.endsWith('.tgz')) {
      return 'application/gzip';
    } else if (filename.endsWith('.tar.bz2')) {
      return 'application/x-bzip2';
    } else if (filename.endsWith('.zip')) {
      return 'application/zip';
    } else if (filename.endsWith('.egg')) {
      return 'application/zip';
    }
    return 'application/octet-stream';
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
    if (!this.pypiGroupId) {
      return null;
    }

    // Get group members ordered by priority
    const members = await this.prisma.repositoryGroupMember.findMany({
      where: { groupId: this.pypiGroupId },
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
    name: string,
    version: string,
    packagePath: string,
  ): Promise<{
    response: Response;
    repositoryId: string;
    repositoryName: string;
    upstreamUrl: string;
  } | null> {
    if (!this.pypiGroupId) {
      return null;
    }

    // Get PROXY members from the group (ordered by priority)
    const members = await this.prisma.repositoryGroupMember.findMany({
      where: {
        groupId: this.pypiGroupId,
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
      `[GROUP UPSTREAM] Trying ${proxyMembers.length} upstream repositories for: ${name}@${version}`,
    );

    // Try each proxy in priority order
    for (const member of proxyMembers) {
      const upstream = member.repository.upstreamUrl!;
      const repoName = member.repository.name;

      this.logger.log(
        `[GROUP UPSTREAM] → Trying upstream: ${repoName} (${upstream})`,
      );

      try {
        const upstreamUrl = `${upstream}/packages/${packagePath}`;
        const upstreamResponse = await fetch(upstreamUrl);

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
        this.logger.warn(
          `[GROUP UPSTREAM] ✗ ERROR from: ${repoName} - ${error.message}`,
        );
      }
    }

    this.logger.log(
      `[GROUP UPSTREAM] All upstream repositories failed for: ${name}@${version}`,
    );
    return null;
  }
}
