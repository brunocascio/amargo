import { Readable } from 'stream';

export interface StorageMetadata {
  size: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
}

export interface PutObjectOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface IStorageAdapter {
  /**
   * Store an object from a readable stream
   */
  putObject(
    key: string,
    stream: Readable,
    options?: PutObjectOptions,
  ): Promise<void>;

  /**
   * Get an object as a readable stream
   */
  getObject(key: string): Promise<Readable>;

  /**
   * Get object metadata without downloading the object
   */
  headObject(key: string): Promise<StorageMetadata>;

  /**
   * Delete an object
   */
  deleteObject(key: string): Promise<void>;

  /**
   * Check if an object exists
   */
  exists(key: string): Promise<boolean>;

  /**
   * List objects with a given prefix
   */
  listObjects(prefix: string, maxKeys?: number): Promise<string[]>;
}
