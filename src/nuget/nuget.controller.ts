import {
  Controller,
  Get,
  Logger,
  Param,
  Req,
  Res,
  NotFoundException,
  InternalServerErrorException,
  Head,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { ArtifactService } from '../artifact/artifact.service';
import { AmargoConfigService } from '../config/amargo-config.service';
import { Readable } from 'stream';

/**
 * NuGetController implements the NuGet V3 API protocol
 * Supports Package Base Address (PackageBaseAddress/3.0.0) and Registration (RegistrationsBaseUrl/3.6.0)
 * 
 * Key endpoints:
 * - Service Index: /nuget/v3/index.json
 * - Package versions: /nuget/v3-flatcontainer/{id}/index.json
 * - Package content: /nuget/v3-flatcontainer/{id}/{version}/{id}.{version}.nupkg
 * - Package manifest: /nuget/v3-flatcontainer/{id}/{version}/{id}.nuspec
 * - Registration index: /nuget/v3/registration/{id}/index.json
 * 
 * References:
 * - https://learn.microsoft.com/en-us/nuget/api/overview
 * - https://learn.microsoft.com/en-us/nuget/api/package-base-address-resource
 * - https://learn.microsoft.com/en-us/nuget/api/registration-base-url-resource
 */
@Controller('nuget')
export class NuGetController {
  private readonly logger = new Logger(NuGetController.name);
  private repositoryId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly artifactService: ArtifactService,
    private readonly configService: AmargoConfigService,
  ) {}

  async onModuleInit() {
    // Ensure nuget repository exists in database
    const nugetConfig = this.configService.getRepository('nuget');

    let repository = await this.prisma.repository.findUnique({
      where: { name: 'nuget' },
    });

    if (!repository) {
      repository = await this.prisma.repository.create({
        data: {
          name: 'nuget',
          type: 'PROXY',
          format: 'NUGET',
          description: 'NuGet package registry',
          upstreamUrl: nugetConfig.upstream || 'https://api.nuget.org',
          isProxyEnabled: true,
          cacheTtl: nugetConfig.cacheTtl,
        },
      });
      this.logger.log('Created nuget repository');
    }

    this.repositoryId = repository.id;
  }

  /**
   * Service Index - Entry point for NuGet V3 API
   * Returns a list of available resources and their endpoints
   */
  @Get('v3/index.json')
  async getServiceIndex(@Req() req: Request, @Res() res: Response) {
    this.logger.log('Service index requested');

    const baseUrl = `${req.protocol}://${req.get('host')}/nuget`;

    const serviceIndex = {
      version: '3.0.0',
      resources: [
        {
          '@id': `${baseUrl}/v3-flatcontainer/`,
          '@type': 'PackageBaseAddress/3.0.0',
          comment: 'Base URL of where NuGet packages are stored, in the format https://api.nuget.org/v3-flatcontainer/{id-lower}/{version-lower}/{id-lower}.{version-lower}.nupkg',
        },
        {
          '@id': `${baseUrl}/v3/registration/`,
          '@type': 'RegistrationsBaseUrl/3.6.0',
          comment: 'Base URL of Azure storage where NuGet package registration info is stored, in the format https://api.nuget.org/v3/registration/{id-lower}/index.json',
        },
        {
          '@id': `${baseUrl}/query`,
          '@type': 'SearchQueryService',
          comment: 'Query endpoint of NuGet Search service (primary)',
        },
        {
          '@id': `${baseUrl}/autocomplete`,
          '@type': 'SearchAutocompleteService',
          comment: 'Autocomplete endpoint of NuGet Search service',
        },
      ],
    };

    res.json(serviceIndex);
  }

  /**
   * Package versions list
   * GET /v3-flatcontainer/{id}/index.json
   * Returns all available versions for a package
   */
  @Get('v3-flatcontainer/:packageId/index.json')
  async getPackageVersions(
    @Param('packageId') packageId: string,
    @Res() res: Response,
  ) {
    const lowerId = packageId.toLowerCase();
    this.logger.log(`Package versions requested: ${lowerId}`);

    try {
      // Try to find in repository group first
      const group = await this.getRepositoryGroup();
      
      if (group) {
        const result = await this.getVersionsFromGroup(group, lowerId);
        if (result) {
          return res.json(result);
        }
      }

      // Fallback to single repository
      const repository = await this.prisma.repository.findUnique({
        where: { name: 'nuget' },
      });

      if (!repository) {
        throw new NotFoundException('NuGet repository not configured');
      }

      const upstreamUrl = `${repository.upstreamUrl}/v3-flatcontainer/${lowerId}/index.json`;
      this.logger.log(`Fetching versions from upstream: ${upstreamUrl}`);

      const response = await fetch(upstreamUrl);
      if (!response.ok) {
        if (response.status === 404) {
          throw new NotFoundException(`Package not found: ${lowerId}`);
        }
        throw new InternalServerErrorException(
          `Upstream error: ${response.status}`,
        );
      }

      const data = await response.json();
      res.json(data);
    } catch (error) {
      this.logger.error(`Error fetching package versions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Package content download (.nupkg)
   * GET /v3-flatcontainer/{id}/{version}/{id}.{version}.nupkg
   */
  @Get('v3-flatcontainer/:packageId/:version/:filename')
  @Head('v3-flatcontainer/:packageId/:version/:filename')
  async downloadPackage(
    @Param('packageId') packageId: string,
    @Param('version') version: string,
    @Param('filename') filename: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const lowerId = packageId.toLowerCase();
    const lowerVersion = version.toLowerCase();
    const isNupkg = filename.endsWith('.nupkg');
    const isNuspec = filename.endsWith('.nuspec');

    this.logger.log(
      `Package ${isNupkg ? 'content' : 'manifest'} requested: ${lowerId}@${lowerVersion}`,
    );

    try {
      // Try to find in repository group first
      const group = await this.getRepositoryGroup();
      
      if (group) {
        const result = await this.downloadFromGroup(
          group,
          lowerId,
          lowerVersion,
          filename,
          req,
          res,
        );
        if (result) {
          return;
        }
      }

      // Fallback to single repository
      const repository = await this.prisma.repository.findUnique({
        where: { name: 'nuget' },
      });

      if (!repository) {
        throw new NotFoundException('NuGet repository not configured');
      }

      await this.handlePackageDownload(
        repository,
        lowerId,
        lowerVersion,
        filename,
        req,
        res,
      );
    } catch (error) {
      this.logger.error(`Error downloading package: ${error.message}`);
      throw error;
    }
  }

  /**
   * Registration index - Package metadata
   * GET /v3/registration/{id}/index.json
   */
  @Get('v3/registration/:packageId/index.json')
  async getRegistrationIndex(
    @Param('packageId') packageId: string,
    @Res() res: Response,
  ) {
    const lowerId = packageId.toLowerCase();
    this.logger.log(`Registration index requested: ${lowerId}`);

    try {
      const repository = await this.prisma.repository.findUnique({
        where: { name: 'nuget' },
      });

      if (!repository) {
        throw new NotFoundException('NuGet repository not configured');
      }

      const upstreamUrl = `${repository.upstreamUrl}/v3/registration/${lowerId}/index.json`;
      this.logger.log(`Proxying registration to upstream: ${upstreamUrl}`);

      const response = await fetch(upstreamUrl);
      if (!response.ok) {
        if (response.status === 404) {
          throw new NotFoundException(`Package not found: ${lowerId}`);
        }
        throw new InternalServerErrorException(
          `Upstream error: ${response.status}`,
        );
      }

      const data = await response.json();
      res.json(data);
    } catch (error) {
      this.logger.error(`Error fetching registration: ${error.message}`);
      throw error;
    }
  }

  /**
   * Search query endpoint (stub)
   * This is a placeholder - full search implementation would require indexing
   */
  @Get('query')
  async searchPackages(@Req() req: Request, @Res() res: Response) {
    this.logger.log('Search query requested (stub)');
    
    const repository = await this.prisma.repository.findUnique({
      where: { name: 'nuget' },
    });

    if (!repository) {
      throw new NotFoundException('NuGet repository not configured');
    }

    // Proxy to upstream
    const queryString = new URLSearchParams(req.query as any).toString();
    const upstreamUrl = `${repository.upstreamUrl}/query?${queryString}`;
    
    const response = await fetch(upstreamUrl);
    if (!response.ok) {
      throw new InternalServerErrorException(`Upstream error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  }

  /**
   * Autocomplete endpoint (stub)
   */
  @Get('autocomplete')
  async autocomplete(@Req() req: Request, @Res() res: Response) {
    this.logger.log('Autocomplete requested (stub)');
    
    const repository = await this.prisma.repository.findUnique({
      where: { name: 'nuget' },
    });

    if (!repository) {
      throw new NotFoundException('NuGet repository not configured');
    }

    // Proxy to upstream
    const queryString = new URLSearchParams(req.query as any).toString();
    const upstreamUrl = `${repository.upstreamUrl}/autocomplete?${queryString}`;
    
    const response = await fetch(upstreamUrl);
    if (!response.ok) {
      throw new InternalServerErrorException(`Upstream error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  }

  /**
   * Helper: Get repository group
   */
  private async getRepositoryGroup() {
    const groups = this.configService.getGroups();
    const groupConfig = Object.values(groups).find(
      (g) => g.format === 'nuget',
    );

    if (!groupConfig) {
      return null;
    }

    const groupName = Object.keys(groups).find(
      (key) => groups[key] === groupConfig,
    );

    if (!groupName) {
      return null;
    }

    const group = await this.prisma.repositoryGroup.findUnique({
      where: { name: groupName },
      include: {
        members: {
          include: { repository: true },
          orderBy: { priority: 'asc' },
        },
      },
    });

    return group;
  }

  /**
   * Helper: Get versions from repository group
   */
  private async getVersionsFromGroup(group: any, packageId: string) {
    for (const member of group.members) {
      const repository = member.repository;
      const upstreamUrl = `${repository.upstreamUrl}/v3-flatcontainer/${packageId}/index.json`;

      try {
        this.logger.log(
          `Checking ${repository.name} for package versions: ${packageId}`,
        );
        const response = await fetch(upstreamUrl);

        if (response.ok) {
          this.logger.log(`Found in ${repository.name}`);
          const data = await response.json();
          return data;
        }
      } catch (error) {
        this.logger.debug(
          `Failed to fetch from ${repository.name}: ${error.message}`,
        );
      }
    }

    return null;
  }

  /**
   * Helper: Download package from repository group
   */
  private async downloadFromGroup(
    group: any,
    packageId: string,
    version: string,
    filename: string,
    req: Request,
    res: Response,
  ) {
    for (const member of group.members) {
      const repository = member.repository;

      try {
        this.logger.log(
          `Checking ${repository.name} for ${packageId}@${version}`,
        );

        await this.handlePackageDownload(
          repository,
          packageId,
          version,
          filename,
          req,
          res,
        );
        return true;
      } catch (error) {
        if (error instanceof NotFoundException) {
          this.logger.debug(
            `Package not found in ${repository.name}, trying next repository`,
          );
          continue;
        }
        throw error;
      }
    }

    throw new NotFoundException(`Package not found: ${packageId}@${version}`);
  }

  /**
   * Helper: Handle package download from specific repository
   */
  private async handlePackageDownload(
    repository: any,
    packageId: string,
    version: string,
    filename: string,
    req: Request,
    res: Response,
  ) {
    const isNupkg = filename.endsWith('.nupkg');
    
    // Generate artifact key for caching (use packageId as name)
    const artifactKey = packageId;

    // Check if we have it in cache (only for .nupkg files)
    if (isNupkg) {
      const cached = await this.artifactService.getArtifact(
        repository.id,
        artifactKey,
        version,
      );

      if (cached) {
        this.logger.log(`Cache HIT: ${packageId}@${version}`);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`,
        );
        res.setHeader('Content-Length', cached.artifact.size.toString());
        res.setHeader('X-Cache', 'HIT');

        if (req.method === 'HEAD') {
          return res.end();
        }

        cached.stream.pipe(res);
        return;
      }

      this.logger.log(`Cache MISS: ${packageId}@${version}`);
    }

    // Fetch from upstream
    const upstreamUrl = `${repository.upstreamUrl}/v3-flatcontainer/${packageId}/${version}/${filename}`;
    this.logger.log(`Fetching from upstream: ${upstreamUrl}`);

    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
    });

    if (!upstreamResponse.ok) {
      if (upstreamResponse.status === 404) {
        throw new NotFoundException(
          `Package not found: ${packageId}@${version}`,
        );
      }
      throw new InternalServerErrorException(
        `Upstream error: ${upstreamResponse.status}`,
      );
    }

    // Set response headers
    const contentType =
      upstreamResponse.headers.get('content-type') ||
      (filename.endsWith('.nupkg')
        ? 'application/octet-stream'
        : filename.endsWith('.nuspec')
          ? 'application/xml'
          : 'application/octet-stream');

    res.setHeader('Content-Type', contentType);
    const contentLength = upstreamResponse.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    if (filename.endsWith('.nupkg')) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
    }
    res.setHeader('X-Cache', 'MISS');

    if (req.method === 'HEAD') {
      return res.end();
    }

    // For .nupkg files, tee the stream to cache it
    if (isNupkg && upstreamResponse.body) {
      const upstreamStream = Readable.fromWeb(
        upstreamResponse.body as any,
      );

      // Create a pass-through stream for the client
      const clientStream = new Readable({
        read() {},
      });

      // Create a buffer array to collect chunks for storage
      const chunks: Buffer[] = [];

      upstreamStream.on('data', (chunk) => {
        chunks.push(chunk);
        clientStream.push(chunk);
      });

      upstreamStream.on('end', async () => {
        clientStream.push(null);

        // Store in cache
        try {
          const buffer = Buffer.concat(chunks);
          const storageStream = Readable.from(buffer);

          await this.artifactService.storeArtifact({
            repositoryId: repository.id,
            name: artifactKey,
            version: version,
            stream: storageStream,
            contentType: 'application/octet-stream',
            metadata: {
              packageId,
              filename,
            },
          });

          this.logger.log(`Cached ${packageId}@${version} in nuget`);
        } catch (error) {
          this.logger.error(`Failed to cache artifact: ${error.message}`);
        }
      });

      upstreamStream.on('error', (error) => {
        this.logger.error(`Stream error: ${error.message}`);
        clientStream.destroy(error);
      });

      clientStream.pipe(res);
    } else {
      // For .nuspec and other files, just proxy the response
      const stream = Readable.fromWeb(upstreamResponse.body as any);
      stream.pipe(res);
    }
  }
}
