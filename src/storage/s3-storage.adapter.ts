import { Injectable, Logger } from '@nestjs/common';
import { S3 } from 'aws-sdk';
import { Readable } from 'stream';
import {
  IStorageAdapter,
  StorageMetadata,
  PutObjectOptions,
} from './storage.interface';
import type { StorageProviderConfig } from '../config/amargo-config.service';

@Injectable()
export class S3StorageAdapter implements IStorageAdapter {
  private readonly logger = new Logger(S3StorageAdapter.name);
  private readonly s3: S3;
  private readonly bucket: string;

  constructor(config: StorageProviderConfig) {
    this.bucket = config.bucket || '';

    if (!this.bucket) {
      throw new Error('S3 bucket is required');
    }

    this.s3 = new S3({
      endpoint: config.endpoint,
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
      region: config.region || 'us-east-1',
      s3ForcePathStyle: config.forcePathStyle ?? false,
      signatureVersion: 'v4',
    });

    this.logger.log(
      `S3StorageAdapter initialized for bucket: ${this.bucket} at ${config.endpoint || 'AWS S3'}`,
    );
  }

  async putObject(
    key: string,
    stream: Readable,
    options?: PutObjectOptions,
  ): Promise<void> {
    try {
      await this.s3
        .upload({
          Bucket: this.bucket,
          Key: key,
          Body: stream,
          ContentType: options?.contentType || 'application/octet-stream',
          Metadata: options?.metadata,
        })
        .promise();

      this.logger.debug(`Stored object: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to store object ${key}:`, error);
      throw error;
    }
  }

  async getObject(key: string): Promise<Readable> {
    try {
      const result = await this.s3
        .getObject({
          Bucket: this.bucket,
          Key: key,
        })
        .promise();

      if (!result.Body) {
        throw new Error(`Object ${key} has no body`);
      }

      // Convert to readable stream
      if (result.Body instanceof Readable) {
        return result.Body;
      }

      // Convert Buffer to Readable
      const readable = new Readable();
      readable.push(result.Body as Buffer);
      readable.push(null);
      return readable;
    } catch (error) {
      this.logger.error(`Failed to get object ${key}:`, error);
      throw error;
    }
  }

  async headObject(key: string): Promise<StorageMetadata> {
    try {
      const result = await this.s3
        .headObject({
          Bucket: this.bucket,
          Key: key,
        })
        .promise();

      return {
        size: result.ContentLength || 0,
        contentType: result.ContentType,
        etag: result.ETag,
        lastModified: result.LastModified,
      };
    } catch (error) {
      this.logger.error(`Failed to head object ${key}:`, error);
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.s3
        .deleteObject({
          Bucket: this.bucket,
          Key: key,
        })
        .promise();

      this.logger.debug(`Deleted object: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete object ${key}:`, error);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.headObject(key);
      return true;
    } catch (error: any) {
      if (error.code === 'NotFound' || error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async listObjects(prefix: string, maxKeys = 1000): Promise<string[]> {
    try {
      const result = await this.s3
        .listObjectsV2({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: maxKeys,
        })
        .promise();

      return (result.Contents || []).map((obj) => obj.Key || '').filter(Boolean);
    } catch (error) {
      this.logger.error(`Failed to list objects with prefix ${prefix}:`, error);
      throw error;
    }
  }
}
