import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SafeLogger } from './common/safe-logger';
import { validateEnvironment } from './config/env.validation';

async function bootstrap(): Promise<void> {
  validateEnvironment();
  const app = await NestFactory.create(AppModule, { logger: new SafeLogger() });
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  const port = Number(process.env['PORT'] ?? 3000);
  try { await app.listen(port, '0.0.0.0'); }
  catch (error) { await app.close(); throw error; }
}
void bootstrap().catch(() => {
  new SafeLogger().error('Application startup failed; check configuration and listener availability');
  process.exitCode = 1;
});
