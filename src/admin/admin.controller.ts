import { Controller, Get, Render } from '@nestjs/common';
import { AmargoConfigService } from '../config/amargo-config.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly configService: AmargoConfigService) {}

  @Get()
  @Render('admin')
  index() {
    const cfg = this.configService.getReadOnlyConfig();
    // Provide a safe, pretty-printed JSON for rendering
    return {
      title: this.configService.getAdmin()?.ui?.title ?? 'Amargo Admin',
      configJson: JSON.stringify(cfg, null, 2),
    };
  }
}
