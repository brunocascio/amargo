import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AmargoConfigModule } from './config/config.module';
import { PrismaService } from './database/prisma.service';
import { AdminController } from './admin/admin.controller';
import { StorageService } from './storage/storage.service';
import { ArtifactService } from './artifact/artifact.service';
import { NpmController } from './npm/npm.controller';
import { DockerController } from './docker/docker.controller';
import { CacheCleanupService } from './cache/cache-cleanup.service';
import { HealthController } from './health/health.controller';

@Module({
  imports: [AmargoConfigModule],
  controllers: [
    AppController,
    AdminController,
    NpmController,
    DockerController,
    HealthController,
  ],
  providers: [
    AppService,
    PrismaService,
    StorageService,
    ArtifactService,
    CacheCleanupService,
  ],
})
export class AppModule {}
