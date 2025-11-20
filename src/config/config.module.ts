import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AmargoConfigService } from './amargo-config.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
  ],
  providers: [AmargoConfigService],
  exports: [AmargoConfigService],
})
export class AmargoConfigModule {}
