-- CreateEnum
CREATE TYPE "RepositoryType" AS ENUM ('NPM', 'PYPI', 'DOCKER', 'MAVEN', 'NUGET', 'GENERIC');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('S3', 'MINIO', 'GCS', 'AZURE_BLOB', 'LOCAL');

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RepositoryType" NOT NULL,
    "description" TEXT,
    "upstreamUrl" TEXT,
    "isProxyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cacheTtl" INTEGER NOT NULL DEFAULT 3600,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "metadata" JSONB,
    "cacheTtl" INTEGER,
    "lastAccessed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_configs" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "provider" "StorageProvider" NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache_entries" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "artifactPath" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "download_stats" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "artifactName" TEXT NOT NULL,
    "artifactVersion" TEXT NOT NULL,
    "downloadDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "download_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repositories_name_key" ON "repositories"("name");

-- CreateIndex
CREATE INDEX "artifacts_repositoryId_name_idx" ON "artifacts"("repositoryId", "name");

-- CreateIndex
CREATE INDEX "artifacts_lastAccessed_idx" ON "artifacts"("lastAccessed");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_repositoryId_name_version_key" ON "artifacts"("repositoryId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "storage_configs_repositoryId_key" ON "storage_configs"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "cache_entries_key_key" ON "cache_entries"("key");

-- CreateIndex
CREATE INDEX "cache_entries_expiresAt_idx" ON "cache_entries"("expiresAt");

-- CreateIndex
CREATE INDEX "cache_entries_repositoryId_idx" ON "cache_entries"("repositoryId");

-- CreateIndex
CREATE INDEX "download_stats_repositoryId_downloadDate_idx" ON "download_stats"("repositoryId", "downloadDate");

-- CreateIndex
CREATE INDEX "download_stats_artifactName_downloadDate_idx" ON "download_stats"("artifactName", "downloadDate");

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_configs" ADD CONSTRAINT "storage_configs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
