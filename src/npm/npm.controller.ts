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

@Controller('npm')
export class NpmController {
  private readonly logger = new Logger(NpmController.name);
  private upstreamUrl: string;
  private repositoryId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly artifactService: ArtifactService,
    private readonly configService: AmargoConfigService,
  ) {
    const npmConfig = this.configService.getRepository('npm');
    this.upstreamUrl = npmConfig.upstream || 'https://registry.npmjs.org';
  }

  async onModuleInit() {
    // Ensure npm repository exists in database
    const npmConfig = this.configService.getRepository('npm');
    
    let repository = await this.prisma.repository.findUnique({
      where: { name: 'npm' },
    });

    if (!repository) {
      repository = await this.prisma.repository.create({
        data: {
          name: 'npm',
          type: 'NPM',
          description: 'NPM package registry',
          upstreamUrl: this.upstreamUrl,
          isProxyEnabled: true,
          cacheTtl: npmConfig.cacheTtl,
        },
      });
      this.logger.log('Created npm repository in database');
    }

    this.repositoryId = repository.id;
  }

  /**
   * Proxy package metadata (unscoped or encoded scoped)
   * Examples:
   *  - /npm/express
   *  - /npm/@scope%2Fpkg
   */
  @Get(':pkg')
  async getPackageMetadataUnscoped(
    @Param('pkg') pkgParam: string,
    @Res() res: Response,
  ) {
    return this.handlePackageMetadata(pkgParam, res);
  }

  /**
   * Proxy package metadata (scoped, unencoded)
   * Example: /npm/@scope/pkg
   */
  @Get(':scope/:pkg')
  async getPackageMetadataScoped(
    @Param('scope') scope: string,
    @Param('pkg') pkg: string,
    @Res() res: Response,
  ) {
    const fullName = `${scope}/${pkg}`;
    return this.handlePackageMetadata(fullName, res);
  }

  /**
   * Proxy package tarball with pull-through caching
   * Unscoped or encoded scoped: /npm/:pkg/-/:filename (pkg may be '@scope%2Fname' or 'name')
   */
  @Get(':pkg/-/:filename')
  async getPackageTarballUnscoped(
    @Param('pkg') pkgParam: string,
    @Param('filename') filename: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const packageName = this.normalizePackageName(pkgParam);
    return this.handlePackageTarball(packageName, filename, req, res);
  }

  /**
   * Proxy package tarball with pull-through caching (scoped, unencoded)
   * Example: /npm/@scope/pkg/-/:filename
   */
  @Get(':scope/:pkg/-/:filename')
  async getPackageTarballScoped(
    @Param('scope') scope: string,
    @Param('pkg') pkg: string,
    @Param('filename') filename: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const packageName = `${scope}/${pkg}`;
    return this.handlePackageTarball(packageName, filename, req, res);
  }

  private async handlePackageMetadata(pkgParam: string, res: Response) {
    const packageName = this.normalizePackageName(pkgParam);
    try {
      this.logger.debug(`Fetching metadata for package: ${packageName}`);

      const upstreamPath = this.encodePackagePath(packageName);
      const response = await fetch(`${this.upstreamUrl}/${upstreamPath}`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new NotFoundException(`Package ${packageName} not found`);
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${response.status}`,
        );
      }

  const metadata = (await response.json()) as unknown;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
      res.json(metadata);
    } catch (error) {
      this.logger.error(
        `Failed to fetch package metadata: ${packageName}`,
        error,
      );
      throw error;
    }
  }

  private async handlePackageTarball(
    packageName: string,
    filename: string,
    req: Request,
    res: Response,
  ) {
    try {
      // Extract version from filename (e.g., "package-1.0.0.tgz" -> "1.0.0")
      const version = this.extractVersionFromFilename(filename, packageName);

      if (!version) {
        throw new NotFoundException(`Invalid tarball filename: ${filename}`);
      }

      this.logger.debug(`Fetching tarball: ${packageName}@${version}`);

      if (!this.repositoryId) {
        throw new InternalServerErrorException(
          'NPM repository not initialized',
        );
      }

      // Check if we have it cached
      const cached = await this.artifactService.getArtifact(
        this.repositoryId,
        packageName,
        version,
      );

      if (cached) {
        this.logger.debug(`Cache HIT: ${packageName}@${version}`);

        // Record download stats (fire and forget)
        this.artifactService
          .recordDownload(
            this.repositoryId,
            packageName,
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

        // Stream from storage
        cached.stream.pipe(res);
        return;
      }

      // Cache MISS - fetch from upstream
      this.logger.debug(`Cache MISS: ${packageName}@${version}`);

      const upstreamTarballUrl = `${this.upstreamUrl}/${this.encodePackagePath(
        packageName,
      )}/-/${filename}`;
      const upstreamResponse = await fetch(upstreamTarballUrl);

      if (!upstreamResponse.ok) {
        if (upstreamResponse.status === 404) {
          throw new NotFoundException(`Tarball not found: ${filename}`);
        }
        throw new InternalServerErrorException(
          `Upstream returned status ${upstreamResponse.status}`,
        );
      }

      if (!upstreamResponse.body) {
        throw new InternalServerErrorException('Upstream response has no body');
      }

      // Convert Web Streams ReadableStream to Node Readable
      // Convert Web stream to Node stream
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const nodeStream = Readable.fromWeb(upstreamResponse.body as any);

      // Store in cache (fire and forget the response to client separately)
      // We need to tee the stream: one for client, one for storage
      const { PassThrough } = await import('stream');
      const clientStream = new PassThrough();
      const storageStream = new PassThrough();

      nodeStream.pipe(clientStream);
      nodeStream.pipe(storageStream);

      // Store asynchronously
      this.artifactService
        .storeArtifact({
          repositoryId: this.repositoryId,
          name: packageName,
          version,
          stream: storageStream,
          contentType:
            upstreamResponse.headers.get('content-type') ||
            'application/octet-stream',
          metadata: {
            filename,
            source: 'npm-upstream',
          },
        })
        .then(() => {
          this.logger.log(`Cached ${packageName}@${version}`);
        })
        .catch((error) => {
          this.logger.error(
            `Failed to cache ${packageName}@${version}:`,
            error,
          );
        });

      // Stream to client immediately
      res.setHeader(
        'Content-Type',
        upstreamResponse.headers.get('content-type') ||
          'application/octet-stream',
      );
      const contentLength = upstreamResponse.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Amargo-Cache', 'MISS');

      clientStream.pipe(res);
    } catch (error) {
      this.logger.error(`Failed to fetch tarball: ${filename}`, error);
      throw error;
    }
  }

  /**
   * Extract version from tarball filename
   * e.g., "express-4.18.2.tgz" -> "4.18.2"
   */
  private extractVersionFromFilename(
    filename: string,
    packageName: string,
  ): string | null {
    // Remove .tgz extension
    const withoutExt = filename.replace(/\.tgz$/, '');
    
    // Remove package name prefix
    // Handle scoped packages: @scope/package-1.0.0 -> 1.0.0
    const cleanPackageName = packageName.replace(/^@[^/]+\//, '');
    const prefix = `${cleanPackageName}-`;
    
    if (withoutExt.startsWith(prefix)) {
      return withoutExt.substring(prefix.length);
    }
    
    return null;
  }

  /**
   * Normalize a package name parameter that may be encoded (e.g., '@scope%2Fname')
   * into a standard name with slash (e.g., '@scope/name').
   */
  private normalizePackageName(param: string): string {
    // If already contains a slash, return as is
    if (param.includes('/')) return param;
    // Decode %2F to '/'
    return param.replace(/%2F/gi, '/');
  }

  /**
   * Encode a package path for upstream requests.
   * Keep '@' but encode '/' as '%2F'. If it's already encoded, leave as is.
   */
  private encodePackagePath(name: string): string {
    if (/%2F/i.test(name)) return name; // already encoded
    return name.replace(/\//g, '%2F');
  }
}
