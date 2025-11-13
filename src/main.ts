import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Views and static assets
  app.setBaseViewsDir(join(__dirname, '..', 'src', 'views'));
  app.setViewEngine('hbs');

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Amargo running on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  // Ensure any startup error is logged and process exits
  // Use console.error directly because logger might not be initialized yet
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
