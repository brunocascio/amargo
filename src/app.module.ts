import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AmargoConfigModule } from './config/config.module';
import { PrismaService } from './database/prisma.service';
import { StorageService } from './storage/storage.service';
import { ArtifactService } from './artifact/artifact.service';
import { NpmController } from './npm/npm.controller';
import { DockerController } from './docker/docker.controller';
import { PypiController } from './pypi/pypi.controller';
import { GoController } from './go/go.controller';
import { MavenController } from './maven/maven.controller';
import { CacheCleanupService } from './cache/cache-cleanup.service';
import { HealthController } from './health/health.controller';
import { RepositoryInitService } from './repository/repository-init.service';

@Module({
  imports: [AmargoConfigModule],
  controllers: [
    AppController,
    NpmController,
    DockerController,
    PypiController,
    GoController,
    MavenController,
    HealthController,
  ],
  providers: [
    AppService,
    PrismaService,
    StorageService,
    ArtifactService,
    CacheCleanupService,
    RepositoryInitService,
  ],
})
export class AppModule {}
