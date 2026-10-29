import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrationStatus } from './database/safety';

@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}
  @Get('live') live() { return { status: 'ok' }; }
  @Get('ready') async ready() {
    if (!this.dataSource.isInitialized) throw new HttpException({ status: 'unready', database: 'unavailable' }, HttpStatus.SERVICE_UNAVAILABLE);
    try {
      const status = await migrationStatus(this.dataSource);
      if (!status.ready) throw new Error('Migrations pending or unknown');
      return { status: 'ok', database: 'ready', schema: 'migration-controlled' };
    } catch {
      throw new HttpException({ status: 'unready', database: 'schema-unavailable' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
