import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
