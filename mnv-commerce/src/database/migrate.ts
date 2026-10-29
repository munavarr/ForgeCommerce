import 'reflect-metadata';
import { createDataSource } from './options';
import { grantRuntimePrivileges, migrationStatus, verifyDatabaseIdentity } from './safety';
import { migrationNames } from './migration-names';

export async function migrate(command: string): Promise<void> {
  if (!['run', 'show', 'revert'].includes(command)) throw new Error('Use run, show or revert');
  const db = createDataSource(command !== 'show');
  try {
    await db.initialize();
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      // Session advisory lock serializes competing CLI runs before TypeORM touches its bookkeeping table.
      await runner.query('SELECT pg_advisory_lock(1793145600, 1)');
      const identity = await verifyDatabaseIdentity(runner, command === 'revert');
      process.stdout.write(`${JSON.stringify({ identity })}\n`);
      if (command === 'show') {
        process.stdout.write(`${JSON.stringify(await migrationStatus(runner))}\n`);
      } else {
        const status = await migrationStatus(runner);
        if (status.applied.some(name => !migrationNames.includes(name))) {
          throw new Error('Unknown migration history; migration refused');
        }
        if (command === 'revert' && process.env['MNV_ALLOW_DESTRUCTIVE_ROLLBACK'] !== identity.database) {
          throw new Error('Destructive rollback requires MNV_ALLOW_DESTRUCTIVE_ROLLBACK to equal the disposable database name');
        }
        // Use this runner for the entire migration, privilege grants and metadata write.
        const { MigrationExecutor } = await import('typeorm');
        const executor = new MigrationExecutor(db, runner);
        await runner.startTransaction();
        try {
          if (command === 'run') {
            await executor.executePendingMigrations();
            await grantRuntimePrivileges(runner);
          } else await executor.undoLastMigration();
          await runner.commitTransaction();
        } catch (error) { await runner.rollbackTransaction(); throw error; }
        process.stdout.write(`${JSON.stringify({ command, ...await migrationStatus(runner) })}\n`);
      }
    } finally {
      await runner.query('SELECT pg_advisory_unlock(1793145600, 1)');
      await runner.release();
    }
  } finally { if (db.isInitialized) await db.destroy(); }
}

if (require.main === module) {
  // Deliberately omit driver messages, SQL, URLs and environment values on failure.
  void migrate(process.argv[2] ?? '').catch(() => {
    process.stderr.write('MNV migration command failed. Check configuration, database identity, privileges and migration state. No credentials are logged.\n');
    process.exitCode = 1;
  });
}
