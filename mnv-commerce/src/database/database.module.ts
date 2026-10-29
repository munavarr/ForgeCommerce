import { Module, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createDataSource } from './options';

@Module({
  providers: [{ provide: DataSource, useFactory: async () => {
    const db = createDataSource();
    // Startup connects only. Readiness reports connection/migration failures safely.
    try { await db.initialize(); } catch { /* Restart after restoring connectivity. */ }
    return db;
  } }],
  exports: [DataSource],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly db: DataSource) {}
  async onApplicationShutdown(): Promise<void> {
    if (this.db.isInitialized) await this.db.destroy();
  }
}
