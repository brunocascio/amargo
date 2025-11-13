import { Injectable, Logger } from '@nestjs/common';
import { AmargoConfigService } from '../config/amargo-config.service';
import { IStorageAdapter } from './storage.interface';
import { S3StorageAdapter } from './s3-storage.adapter';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private adapters: Map<string, IStorageAdapter> = new Map();
  private defaultAdapter: IStorageAdapter;

  constructor(private readonly configService: AmargoConfigService) {
    this.initializeAdapters();
  }

  private initializeAdapters(): void {
    const storageConfig = this.configService.getStorage();
    const defaultProviderName = storageConfig.default;

    // Initialize all configured storage providers
    for (const [name, providerConfig] of Object.entries(
      storageConfig.providers,
    )) {
      try {
        let adapter: IStorageAdapter;

        switch (providerConfig.type) {
          case 's3':
            adapter = new S3StorageAdapter(providerConfig);
            break;
          // Add other providers later (GCS, Azure, local)
          default:
            this.logger.warn(
              `Unsupported storage provider type: ${providerConfig.type}`,
            );
            continue;
        }

        this.adapters.set(name, adapter);

        if (name === defaultProviderName) {
          this.defaultAdapter = adapter;
        }

        this.logger.log(`Initialized storage adapter: ${name}`);
      } catch (error) {
        this.logger.error(`Failed to initialize storage adapter ${name}:`, error);
      }
    }

    if (!this.defaultAdapter) {
      throw new Error(
        `Default storage provider '${defaultProviderName}' could not be initialized`,
      );
    }

    this.logger.log(`Default storage adapter set to: ${defaultProviderName}`);
  }

  getAdapter(name?: string): IStorageAdapter {
    if (!name) {
      return this.defaultAdapter;
    }

    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Storage adapter '${name}' not found`);
    }

    return adapter;
  }

  getDefaultAdapter(): IStorageAdapter {
    return this.defaultAdapter;
  }
}
