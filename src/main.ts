import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import compression from 'compression';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable gzip compression for response bodies
  // Reduces bandwidth usage by 50-70% for JSON/HTML responses
  app.use(
    compression({
      threshold: 1024, // Only compress responses larger than 1KB
      level: 6, // Compression level (0-9, default: 6)
    }),
  );

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
