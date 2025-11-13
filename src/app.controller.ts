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
      },
      documentation: 'See AMARGO_README.md and QUICKSTART.md',
    };
  }
}
