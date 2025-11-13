import { Injectable, OnModuleInit, OnModuleDestroy, INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['error'],
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      console.log('Database connected successfully');
    } catch (error) {
      console.error('Failed to connect to database:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  enableShutdownHooks(app: INestApplication) {
    // Register a listener that will close the Nest application when the process is shutting down.
    // Use a non-async callback to avoid returning a Promise to process.on.
    process.on('beforeExit', () => {
      // app.close() returns a Promise; call it but do not await here.
      // Any errors will be handled by the Nest application's own shutdown hooks.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      app.close();
    });
  }
}