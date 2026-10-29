import { DataSource, QueryRunner } from 'typeorm';
import { commerceTables } from './tables';
import { migrationNames } from './migration-names';

export function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Database identifiers must use lowercase letters, digits and underscores');
  return `"${value}"`;
}

type Queryable = DataSource | QueryRunner;
export async function verifyDatabaseIdentity(db: Queryable, disposable = false) {
  const [{ database, role, marker, owner, address, port }] = await db.query(`SELECT current_database() AS database,
 current_user AS role, pg_get_userbyid(datdba) AS owner, inet_server_addr()::text AS address,
 inet_server_port() AS port, shobj_description(oid, 'pg_database') AS marker
 FROM pg_database WHERE datname = current_database()`);
  const expected = process.env['DB_NAME'];
  if (database !== expected || !/^mnv_commerce(?:_(?:dev|test)(?:_[a-z0-9_]+)?)?$/.test(database)
      || !['mnv-commerce:development', 'mnv-commerce:disposable-test'].includes(marker)) {
    throw new Error('Database identity rejected: expected a named, explicitly marked MNV development/test database');
  }
  if (disposable && (!/^mnv_commerce_test_[a-z0-9_]+$/.test(database) || marker !== 'mnv-commerce:disposable-test')) {
    throw new Error('Operation requires a marked disposable MNV test database');
  }
  // A marker alone is insufficient: refuse unrelated objects anywhere in this dedicated database.
  const objects = await db.query(`SELECT n.nspname AS schema, c.relname AS name FROM pg_class c
 JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname NOT IN ('pg_catalog','information_schema')
 AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'`);
  const allowed = new Set<string>([...commerceTables, 'mnv_migrations', 'mnv_migrations_id_seq']);
  if (objects.some((row: { schema: string; name: string }) => row.schema !== process.env['DB_SCHEMA'] || !allowed.has(row.name))) {
    throw new Error('Database contains unidentified objects; migration refused');
  }
  return { database, role, owner, address, port, marker };
}

export async function migrationStatus(db: Queryable): Promise<{ ready: boolean; applied: string[]; pending: string[] }> {
  const table = `${quoteIdentifier(process.env['DB_SCHEMA']!)}."mnv_migrations"`;
  const [{ exists }] = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_class c
 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'mnv_migrations'
 AND c.relkind = 'r') AS exists`, [process.env['DB_SCHEMA']]);
  const applied: string[] = exists ? (await db.query(`SELECT name FROM ${table} ORDER BY id`)).map((row: { name: string }) => row.name) : [];
  const expected = migrationNames;
  const pending = expected.filter(name => !applied.includes(name));
  const [{ count }] = await db.query(`SELECT count(*)::int AS count FROM pg_class c
 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'
 AND c.relname = ANY($2::text[])`, [process.env['DB_SCHEMA'], commerceTables]);
  return { ready: pending.length === 0 && applied.length === expected.length && count === commerceTables.length, applied, pending };
}

export async function grantRuntimePrivileges(runner: QueryRunner): Promise<void> {
  const schema = quoteIdentifier(process.env['DB_SCHEMA']!);
  const appRole = quoteIdentifier(process.env['DB_USER']!);
  const [role] = await runner.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
 pg_get_userbyid(datdba) = rolname AS owns_database FROM pg_roles, pg_database
 WHERE rolname = $1 AND datname = current_database()`, [process.env['DB_USER']]);
  if (!role || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolbypassrls || role.owns_database) {
    throw new Error('Runtime role must exist and must not own the database or have administrative privileges');
  }
  await runner.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC, ${appRole}`);
  await runner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);
  // Explicit grants prevent accidental DDL, TRUNCATE or history deletion privileges.
  for (const table of commerceTables) {
    const target = `${schema}.${quoteIdentifier(table)}`;
    await runner.query(`REVOKE ALL ON ${target} FROM ${appRole}`);
    const history = ['stock_movements', 'order_transitions'].includes(table);
    const retained = ['orders', 'order_lines', 'payment_attempts'].includes(table);
    await runner.query(`GRANT SELECT, INSERT${history ? '' : ', UPDATE'}${history || retained ? '' : ', DELETE'} ON ${target} TO ${appRole}`);
  }
  // Runtime registration may create only default customers. Only the migration owner can
  // provision/change roles or verification status; no HTTP DTO accepts these columns.
  await runner.query(`REVOKE INSERT, UPDATE, DELETE ON ${schema}.users FROM ${appRole}`);
  await runner.query(`GRANT INSERT (email,password_hash), UPDATE (password_hash,archived_at) ON ${schema}.users TO ${appRole}`);
  await runner.query(`REVOKE INSERT, UPDATE, DELETE ON ${schema}.sessions FROM ${appRole}`);
  await runner.query(`GRANT INSERT (user_id,token_hash,expires_at), UPDATE (revoked_at) ON ${schema}.sessions TO ${appRole}`);
  // Inventory counters and ledger are maintained by narrowly scoped owner triggers.
  // Grant column writes rather than trusting callers to maintain a redundant counter.
  await runner.query(`REVOKE INSERT, UPDATE, DELETE ON ${schema}.stock_levels FROM ${appRole}`);
  await runner.query(`GRANT INSERT (variant_id,location_id,on_hand), UPDATE (on_hand)
    ON ${schema}.stock_levels TO ${appRole}`);
  await runner.query(`REVOKE INSERT ON ${schema}.stock_movements, ${schema}.order_transitions FROM ${appRole}`);
  await runner.query(`REVOKE DELETE ON ${schema}.stock_reservations FROM ${appRole}`);
  await runner.query(`GRANT SELECT ON ${schema}."mnv_migrations" TO ${appRole}`);
  const [{ can_create }] = await runner.query(`SELECT has_schema_privilege($1, $2, 'CREATE') OR
 has_database_privilege($1, current_database(), 'CREATE') AS can_create`, [process.env['DB_USER'], process.env['DB_SCHEMA']]);
  if (can_create) throw new Error('Runtime role inherits schema creation privileges; remove them before migrating');
}
