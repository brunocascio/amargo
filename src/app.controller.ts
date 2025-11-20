import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return {
      name: 'Amargo',
      version: '0.1.0',
      description: 'Universal Artifact Repository Manager',
      endpoints: {
        health: '/health',
        npm: '/npm/',
        docker: '/v2/',
        pypi: '/pypi/',
        go: '/go/',
        maven: '/maven/',
        nuget: '/nuget/',
      },
    };
  }
}
