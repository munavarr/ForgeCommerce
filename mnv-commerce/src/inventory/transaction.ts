import { setTimeout } from 'node:timers/promises';
import { DataSource, EntityManager } from 'typeorm';
import { sqlState } from './inventory.error';

/** Callback must contain database work only. A retry gets a fresh runner/manager/transaction. */
export async function inventoryTransaction<T>(db: DataSource, work: (manager: EntityManager) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const runner = db.createQueryRunner();
    let retry = false;
    let discard: Error | undefined;
    try {
      await runner.connect();
      await runner.startTransaction('READ COMMITTED');
      const result = await work(runner.manager);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      // A rollback/release failure is not retried: connection state is no longer trustworthy.
      if (runner.isTransactionActive) {
        try { await runner.rollbackTransaction(); }
        catch (rollbackError) {
          discard = new Error('Inventory transaction rollback failed');
          throw rollbackError;
        }
      }
      if (!['40001', '40P01'].includes(sqlState(error) ?? '') || attempt >= 3) throw error;
      retry = true;
    } finally {
      if (discard) {
        // TypeORM 0.3.31's PostgreSQL release(error) path evicts the pg client from its pool.
        // Its public release() cannot convey this error and could reuse an aborted connection.
        const postgres = runner as typeof runner & { releasePostgresConnection(error: Error): Promise<void> };
        await postgres.releasePostgresConnection(discard);
      } else await runner.release();
    }
    if (retry) await setTimeout(10 * 2 ** attempt + Math.floor(Math.random() * 10));
  }
}
