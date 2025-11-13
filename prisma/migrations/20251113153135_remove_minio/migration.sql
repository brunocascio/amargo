/*
  Warnings:

  - The values [MINIO] on the enum `StorageProvider` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "StorageProvider_new" AS ENUM ('S3', 'GCS', 'AZURE_BLOB', 'LOCAL');
ALTER TABLE "storage_configs" ALTER COLUMN "provider" TYPE "StorageProvider_new" USING ("provider"::text::"StorageProvider_new");
ALTER TYPE "StorageProvider" RENAME TO "StorageProvider_old";
ALTER TYPE "StorageProvider_new" RENAME TO "StorageProvider";
DROP TYPE "StorageProvider_old";
COMMIT;
