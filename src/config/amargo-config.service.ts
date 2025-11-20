import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { load } from 'js-yaml';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface StorageProviderConfig {
  type: 's3' | 'gcs' | 'azure' | 'local';
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  region?: string;
  forcePathStyle?: boolean;
  keyFile?: string;
  connectionString?: string;
  container?: string;
}

export interface RepositoryConfig {
  format: 'npm' | 'pypi' | 'docker' | 'maven' | 'nuget' | 'generic';
  type: 'hosted' | 'proxy' | 'group';
  enabled: boolean;
  upstream?: string;
  upstreamUsername?: string;
  upstreamPassword?: string;
  cacheTtl: number;
  path: string;
}

export interface GroupMemberConfig {
  name: string;
  priority: number;
}

export interface RepositoryGroupConfig {
  format: 'npm' | 'pypi' | 'docker' | 'maven' | 'nuget' | 'generic';
  enabled: boolean;
  path: string;
  members: GroupMemberConfig[];
}

export interface AmargoConfig {
  server: {
    port: number;
    host: string;
    cache: {
      enabled: boolean;
      maxAge: number;
    };
  };
  database: {
    url: string;
  };
  storage: {
    default: string;
    providers: Record<string, StorageProviderConfig>;
  };
  repositories: Record<string, RepositoryConfig>;
  groups?: Record<string, RepositoryGroupConfig>;
  cache: {
    cleanupInterval: number;
    maxSize: string;
    repositories?: Record<string, { maxSize?: string }>;
  };
  logging: {
    level: string;
    format: string;
  };
}

@Injectable()
export class AmargoConfigService {
  private config: AmargoConfig;

  constructor(private nestConfigService: NestConfigService) {
    this.loadConfig();
  }

  private loadConfig(): void {
    try {
      const configPath = join(process.cwd(), 'config', 'amargo.yaml');
      const fileContents = readFileSync(configPath, 'utf8');

      // Replace environment variables in YAML
      const processedContent = this.replaceEnvVars(fileContents);

      this.config = load(processedContent) as AmargoConfig;

      // Validate configuration
      this.validateConfig();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to load configuration: ${errorMessage}`);
    }
  }

  private replaceEnvVars(content: string): string {
    return content.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
      const parts = varName.split(':-');
      const envVar = parts[0] || '';
      const defaultValue = parts[1] || '';
      return process.env[envVar] || defaultValue || '';
    });
  }

  private validateConfig(): void {
    if (!this.config.server?.port) {
      throw new Error('Server port is required in configuration');
    }

    if (!this.config.storage?.default) {
      throw new Error('Default storage provider is required in configuration');
    }

    if (!this.config.storage.providers?.[this.config.storage.default]) {
      throw new Error(
        `Storage provider '${this.config.storage.default}' is not configured`,
      );
    }
  }

  get(): AmargoConfig {
    return this.config;
  }

  getServer() {
    return this.config.server;
  }

  getStorage() {
    return this.config.storage;
  }

  getStorageProvider(name?: string): StorageProviderConfig {
    const providerName = name || this.config.storage.default;
    const provider = this.config.storage.providers[providerName];

    if (!provider) {
      throw new Error(`Storage provider '${providerName}' not found`);
    }

    return provider;
  }

  getRepositories(): Record<string, RepositoryConfig> {
    return this.config.repositories;
  }

  getRepository(name: string): RepositoryConfig {
    const repo = this.config.repositories[name];
    if (!repo) {
      throw new Error(`Repository '${name}' not found in configuration`);
    }
    return repo;
  }

  getGroups(): Record<string, RepositoryGroupConfig> {
    return this.config.groups || {};
  }

  getGroup(name: string): RepositoryGroupConfig | undefined {
    return this.config.groups?.[name];
  }

  getCache() {
    return this.config.cache;
  }

  getLogging() {
    return this.config.logging;
  }

  getDatabaseUrl(): string {
    return (
      this.nestConfigService.get<string>('DATABASE_URL') ||
      this.config.database.url
    );
  }

  // Method to get configuration as readonly object for UI
  getReadOnlyConfig(): Readonly<AmargoConfig> {
    return Object.freeze(
      JSON.parse(JSON.stringify(this.config)),
    ) as AmargoConfig;
  }
}
