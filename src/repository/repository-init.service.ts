import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AmargoConfigService } from '../config/amargo-config.service';
import { RepositoryFormat, RepositoryType } from '@prisma/client';

@Injectable()
export class RepositoryInitService implements OnModuleInit {
  private readonly logger = new Logger(RepositoryInitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: AmargoConfigService,
  ) {}

  async onModuleInit() {
    await this.initializeRepositories();
    await this.initializeGroups();
  }

  /**
   * Initialize repositories from config
   */
  private async initializeRepositories(): Promise<void> {
    const repositories = this.configService.getRepositories();

    for (const [name, config] of Object.entries(repositories)) {
      if (!config.enabled) {
        this.logger.debug(`Skipping disabled repository: ${name}`);
        continue;
      }

      try {
        // Map config types to Prisma enums
        const type = this.mapRepositoryType(config.type);
        const format = this.mapRepositoryFormat(config.format);

        // Check if repository exists
        let repository = await this.prisma.repository.findUnique({
          where: { name },
        });

        if (repository) {
          // Update existing repository
          repository = await this.prisma.repository.update({
            where: { name },
            data: {
              type,
              format,
              upstreamUrl: config.upstream,
              isProxyEnabled: config.type === 'proxy',
              cacheTtl: config.cacheTtl,
            },
          });
          this.logger.log(
            `Updated repository: ${name} (${config.format}/${config.type})`,
          );
        } else {
          // Create new repository
          repository = await this.prisma.repository.create({
            data: {
              name,
              type,
              format,
              description: `${config.format.toUpperCase()} ${config.type} repository`,
              upstreamUrl: config.upstream,
              isProxyEnabled: config.type === 'proxy',
              cacheTtl: config.cacheTtl,
            },
          });
          this.logger.log(
            `Created repository: ${name} (${config.format}/${config.type})`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to initialize repository ${name}:`, error);
      }
    }
  }

  /**
   * Initialize repository groups from config
   */
  private async initializeGroups(): Promise<void> {
    const groups = this.configService.getGroups();

    for (const [name, config] of Object.entries(groups)) {
      if (!config.enabled) {
        this.logger.debug(`Skipping disabled group: ${name}`);
        continue;
      }

      try {
        const format = this.mapRepositoryFormat(config.format);

        // Check if group exists
        let group = await this.prisma.repositoryGroup.findUnique({
          where: { name },
        });

        if (group) {
          // Update existing group
          group = await this.prisma.repositoryGroup.update({
            where: { name },
            data: {
              format,
              description: `${config.format.toUpperCase()} repository group`,
            },
          });
          this.logger.log(`Updated repository group: ${name}`);
        } else {
          // Create new group
          group = await this.prisma.repositoryGroup.create({
            data: {
              name,
              format,
              description: `${config.format.toUpperCase()} repository group`,
            },
          });
          this.logger.log(`Created repository group: ${name}`);
        }

        // Sync group members
        await this.syncGroupMembers(group.id, name, config.members);
      } catch (error) {
        this.logger.error(`Failed to initialize group ${name}:`, error);
      }
    }
  }

  /**
   * Sync group members with config
   */
  private async syncGroupMembers(
    groupId: string,
    groupName: string,
    members: Array<{ name: string; priority: number }>,
  ): Promise<void> {
    // Get current members
    const existingMembers = await this.prisma.repositoryGroupMember.findMany({
      where: { groupId },
      include: { repository: true },
    });

    // Build map of existing members by repository name
    const existingMap = new Map(
      existingMembers.map((m) => [m.repository.name, m]),
    );

    // Track which members we want to keep
    const wantedRepoNames = new Set(members.map((m) => m.name));

    // Delete members that are no longer in config
    for (const existing of existingMembers) {
      if (!wantedRepoNames.has(existing.repository.name)) {
        await this.prisma.repositoryGroupMember.delete({
          where: { id: existing.id },
        });
        this.logger.debug(
          `Removed ${existing.repository.name} from group ${groupName}`,
        );
      }
    }

    // Add or update members from config
    for (const member of members) {
      // Find repository by name
      const repository = await this.prisma.repository.findUnique({
        where: { name: member.name },
      });

      if (!repository) {
        this.logger.warn(
          `Repository ${member.name} not found, skipping group member`,
        );
        continue;
      }

      const existing = existingMap.get(member.name);

      if (existing) {
        // Update priority if changed
        if (existing.priority !== member.priority) {
          await this.prisma.repositoryGroupMember.update({
            where: { id: existing.id },
            data: { priority: member.priority },
          });
          this.logger.debug(
            `Updated ${member.name} priority to ${member.priority} in group ${groupName}`,
          );
        }
      } else {
        // Add new member
        await this.prisma.repositoryGroupMember.create({
          data: {
            groupId,
            repositoryId: repository.id,
            priority: member.priority,
          },
        });
        this.logger.log(
          `Added ${member.name} (priority ${member.priority}) to group ${groupName}`,
        );
      }
    }
  }

  /**
   * Map config repository type to Prisma enum
   */
  private mapRepositoryType(type: string): RepositoryType {
    switch (type.toLowerCase()) {
      case 'hosted':
        return RepositoryType.HOSTED;
      case 'proxy':
        return RepositoryType.PROXY;
      case 'group':
        return RepositoryType.GROUP;
      default:
        throw new Error(`Unknown repository type: ${type}`);
    }
  }

  /**
   * Map config repository format to Prisma enum
   */
  private mapRepositoryFormat(format: string): RepositoryFormat {
    switch (format.toLowerCase()) {
      case 'npm':
        return RepositoryFormat.NPM;
      case 'pypi':
        return RepositoryFormat.PYPI;
      case 'docker':
        return RepositoryFormat.DOCKER;
      case 'go':
        return RepositoryFormat.GO;
      case 'maven':
        return RepositoryFormat.MAVEN;
      case 'nuget':
        return RepositoryFormat.NUGET;
      case 'generic':
        return RepositoryFormat.GENERIC;
      default:
        throw new Error(`Unknown repository format: ${format}`);
    }
  }
}
