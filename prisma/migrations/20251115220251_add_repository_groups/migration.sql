/*
  Warnings:

  - The values [NPM,PYPI,DOCKER,MAVEN,NUGET,GENERIC] on the enum `RepositoryType` will be removed. If these variants are still used in the database, this will fail.
  - Added the required column `format` to the `repositories` table without a default value. This is not possible if the table is not empty.

*/

-- Drop existing data
TRUNCATE TABLE "artifacts" CASCADE;
TRUNCATE TABLE "repositories" CASCADE;
TRUNCATE TABLE "cache_entries" CASCADE;

-- Step 1: Create new enums
CREATE TYPE "RepositoryFormat" AS ENUM ('NPM', 'PYPI', 'DOCKER', 'MAVEN', 'NUGET', 'GENERIC');
CREATE TYPE "RepositoryType_new" AS ENUM ('HOSTED', 'PROXY', 'GROUP');

-- Step 2: Add format column (NOT NULL)
ALTER TABLE "repositories" ADD COLUMN "format" "RepositoryFormat" NOT NULL DEFAULT 'DOCKER'::"RepositoryFormat";
ALTER TABLE "repositories" ALTER COLUMN "format" DROP DEFAULT;

-- Step 3: Convert type column to new enum
ALTER TABLE "repositories" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "repositories" ALTER COLUMN "type" TYPE "RepositoryType_new" USING 'PROXY'::"RepositoryType_new";
ALTER TABLE "repositories" ALTER COLUMN "type" SET DEFAULT 'PROXY'::"RepositoryType_new";

-- Step 4: Rename enums
ALTER TYPE "RepositoryType" RENAME TO "RepositoryType_old";
ALTER TYPE "RepositoryType_new" RENAME TO "RepositoryType";
DROP TYPE "RepositoryType_old";

-- Step 5: Create group tables
CREATE TABLE "repository_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" "RepositoryFormat" NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repository_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repository_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repository_group_members_pkey" PRIMARY KEY ("id")
);

-- Step 6: Create indexes
CREATE UNIQUE INDEX "repository_groups_name_key" ON "repository_groups"("name");
CREATE INDEX "repository_group_members_groupId_priority_idx" ON "repository_group_members"("groupId", "priority");
CREATE UNIQUE INDEX "repository_group_members_groupId_repositoryId_key" ON "repository_group_members"("groupId", "repositoryId");

-- Step 7: Add foreign keys
ALTER TABLE "repository_group_members" ADD CONSTRAINT "repository_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "repository_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repository_group_members" ADD CONSTRAINT "repository_group_members_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
