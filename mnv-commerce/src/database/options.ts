import { PaymentReliability1793491200000 } from './migrations/1793491200000-payment-reliability';
import { Authentication1793404800000 } from './migrations/1793404800000-authentication';
import { DataSource, DataSourceOptions } from 'typeorm';
import configuration from '../config/configuration';
import { commerceEntities } from './entities/commerce.entity';
import { InitialCommerce1793145600000 } from './migrations/1793145600000-initial-commerce';
import { CommerceWorkflow1793318400000 } from './migrations/1793318400000-commerce-workflow';
import { InventoryEngine1793232000000 } from './migrations/1793232000000-inventory-engine';

export function databaseOptions(migration = false): DataSourceOptions {
  const db = configuration().database;
  // Refuse a Vendure or otherwise unrelated target before even opening a connection.
  if (!/^mnv_commerce(?:_(?:dev|test)(?:_[a-z0-9_]+)?)?$/.test(db.name)) {
    throw new Error('Database name must identify a dedicated MNV Commerce development/test database');
  }
  if (migration && (!process.env['DB_MIGRATION_USER'] || !process.env['DB_MIGRATION_PASSWORD']
      || process.env['DB_MIGRATION_USER'] === db.user)) {
    throw new Error('Migration commands require separate DB_MIGRATION_USER and DB_MIGRATION_PASSWORD');
  }
  return {
    type: 'postgres', host: db.host, port: db.port, database: db.name,
    username: migration ? process.env['DB_MIGRATION_USER']! : db.user,
    password: migration ? process.env['DB_MIGRATION_PASSWORD']! : db.password,
    schema: db.schema, synchronize: false, migrationsRun: false, migrationsTransactionMode: 'all',
    migrationsTableName: 'mnv_migrations', migrations: [InitialCommerce1793145600000, InventoryEngine1793232000000, CommerceWorkflow1793318400000, Authentication1793404800000, PaymentReliability1793491200000],
    entities: commerceEntities, logging: false, extra: { max: db.poolSize, connectionTimeoutMillis: 3000 },
  };
}

export function createDataSource(migration = false): DataSource { return new DataSource(databaseOptions(migration)); }
