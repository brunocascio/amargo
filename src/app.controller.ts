import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return {
      name: 'Amargo',
      version: '0.0.1',
      description: 'Universal Artifact Repository Manager',
      endpoints: {
        health: '/health',
        admin: '/admin',
        npm: '/npm/:package',
        npmTarball: '/npm/:package/-/:filename',
        dockerV2: '/v2/',
        dockerManifest: '/v2/:name/manifests/:reference',
        dockerBlob: '/v2/:name/blobs/:digest',
      },
      documentation: 'See AMARGO_README.md and QUICKSTART.md',
    };
  }
}
