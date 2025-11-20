-- CreateIndex
CREATE INDEX "artifacts_name_version_idx" ON "artifacts"("name", "version");

-- CreateIndex
CREATE INDEX "cache_entries_repositoryId_expiresAt_idx" ON "cache_entries"("repositoryId", "expiresAt");
