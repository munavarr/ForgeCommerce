import { MigrationInterface, QueryRunner } from 'typeorm';
import { quoteIdentifier, verifyDatabaseIdentity } from '../safety';

export class Authentication1793404800000 implements MigrationInterface {
  name = 'Authentication1793404800000';
  async up(runner: QueryRunner): Promise<void> {
    await verifyDatabaseIdentity(runner);
    const s=quoteIdentifier(process.env['DB_SCHEMA']!);
    await runner.query(`ALTER TABLE ${s}.users ADD COLUMN role text NOT NULL DEFAULT 'customer'
      CHECK (role IN ('customer','administrator')), ADD COLUMN email_verified_at timestamptz`);
    // Existing sessions predate real authentication. Retain their digests and revoke them.
    await runner.query(`UPDATE ${s}.sessions SET revoked_at=greatest(created_at,clock_timestamp()) WHERE revoked_at IS NULL`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await verifyDatabaseIdentity(runner,true);
    if(process.env['MNV_ALLOW_DESTRUCTIVE_ROLLBACK']!==process.env['DB_NAME']) throw new Error('Exact disposable confirmation required');
    await runner.query(`ALTER TABLE ${quoteIdentifier(process.env['DB_SCHEMA']!)}.users DROP COLUMN role, DROP COLUMN email_verified_at`);
  }
}
