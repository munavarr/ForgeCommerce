import { MigrationInterface, QueryRunner } from 'typeorm';
import { quoteIdentifier, verifyDatabaseIdentity } from '../safety';

/** Initial schema. down() destroys commerce data; the guarded CLI permits it only in disposable databases. */
export class InitialCommerce1793145600000 implements MigrationInterface {
  name = 'InitialCommerce1793145600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await verifyDatabaseIdentity(queryRunner);
    const schema = quoteIdentifier(process.env['DB_SCHEMA']!);
    await queryRunner.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await queryRunner.query(`CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 email text NOT NULL, password_hash text NOT NULL, archived_at timestamptz,
 CONSTRAINT users_email_format CHECK (email = lower(btrim(email)) AND position('@' in email) > 1),
 CONSTRAINT users_email_unique UNIQUE (email), CONSTRAINT users_password_nonempty CHECK (length(password_hash) > 0)
)`);
    await queryRunner.query(`CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CONSTRAINT sessions_token_hash CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT sessions_expiry CHECK (expires_at > created_at),
 CONSTRAINT sessions_revoked CHECK (revoked_at IS NULL OR revoked_at >= created_at)
)`);
    await queryRunner.query(`CREATE TABLE products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 name text NOT NULL CHECK (length(btrim(name)) > 0), archived_at timestamptz
)`);
    await queryRunner.query(`CREATE TABLE product_variants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 sku text NOT NULL UNIQUE CHECK (length(btrim(sku)) > 0 AND sku = btrim(sku)),
 name text NOT NULL CHECK (length(btrim(name)) > 0), price bigint NOT NULL CHECK (price >= 0),
 currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'), archived_at timestamptz
)`);
    await queryRunner.query(`CREATE TABLE stock_locations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 code text NOT NULL UNIQUE CHECK (length(btrim(code)) > 0),
 name text NOT NULL CHECK (length(btrim(name)) > 0), archived_at timestamptz
)`);
    await queryRunner.query(`CREATE TABLE stock_levels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
 location_id uuid NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
 on_hand integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
 CONSTRAINT stock_levels_variant_location UNIQUE (variant_id, location_id)
)`);
    await queryRunner.query(`CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 code text NOT NULL UNIQUE CHECK (length(btrim(code)) > 0),
 user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','placed','paid','fulfilled','cancelled')),
 currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'), total bigint NOT NULL CHECK (total >= 0)
)`);
    await queryRunner.query(`CREATE TABLE order_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
 sku text NOT NULL CHECK (length(btrim(sku)) > 0), product_name text NOT NULL CHECK (length(btrim(product_name)) > 0),
 variant_name text NOT NULL CHECK (length(btrim(variant_name)) > 0),
 quantity integer NOT NULL CHECK (quantity > 0), unit_price bigint NOT NULL CHECK (unit_price >= 0)
)`);
    await queryRunner.query(`CREATE TABLE stock_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 order_line_id uuid NOT NULL REFERENCES order_lines(id) ON DELETE RESTRICT,
 stock_level_id uuid NOT NULL REFERENCES stock_levels(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK (quantity > 0),
 state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','released','consumed','expired')),
 expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
)`);
    await queryRunner.query(`CREATE TABLE stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 stock_level_id uuid NOT NULL REFERENCES stock_levels(id) ON DELETE RESTRICT,
 order_line_id uuid REFERENCES order_lines(id) ON DELETE RESTRICT,
 quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
 reason text NOT NULL CHECK (length(btrim(reason)) > 0)
)`);
    await queryRunner.query(`CREATE TABLE order_transitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 from_state text NOT NULL CHECK (from_state IN ('draft','placed','paid','fulfilled','cancelled')),
 to_state text NOT NULL CHECK (to_state IN ('draft','placed','paid','fulfilled','cancelled')),
 CONSTRAINT order_transitions_changed CHECK (from_state <> to_state)
)`);
    await queryRunner.query(`CREATE TABLE payment_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK (length(btrim(provider)) > 0), provider_reference text,
 idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
 amount bigint NOT NULL CHECK (amount > 0), currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','succeeded','failed')),
 CONSTRAINT payment_attempts_provider_reference UNIQUE (provider, provider_reference)
)`);
    await queryRunner.query(`CREATE TABLE idempotency_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
 scope text NOT NULL CHECK (length(btrim(scope)) > 0), key text NOT NULL CHECK (length(btrim(key)) > 0),
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','completed')),
 response_status smallint, response_body jsonb,
 CONSTRAINT idempotency_records_scope_key UNIQUE (scope, key),
 CONSTRAINT idempotency_records_response CHECK (
 (state = 'processing' AND response_status IS NULL AND response_body IS NULL) OR
 (state = 'completed' AND response_status BETWEEN 100 AND 599 AND response_status IS NOT NULL AND response_body IS NOT NULL))
)`);
    await queryRunner.query(`CREATE INDEX sessions_user_id_idx ON sessions (user_id)`);
    await queryRunner.query(`CREATE INDEX sessions_expires_at_idx ON sessions (expires_at) WHERE revoked_at IS NULL`);
    await queryRunner.query(`CREATE INDEX product_variants_product_id_idx ON product_variants (product_id)`);
    await queryRunner.query(`CREATE INDEX stock_levels_location_id_idx ON stock_levels (location_id)`);
    await queryRunner.query(`CREATE INDEX orders_user_id_idx ON orders (user_id)`);
    await queryRunner.query(`CREATE INDEX orders_created_at_idx ON orders (created_at)`);
    await queryRunner.query(`CREATE INDEX order_lines_order_id_idx ON order_lines (order_id)`);
    await queryRunner.query(`CREATE INDEX order_lines_variant_id_idx ON order_lines (variant_id)`);
    await queryRunner.query(`CREATE INDEX stock_reservations_order_line_id_idx ON stock_reservations (order_line_id)`);
    await queryRunner.query(`CREATE INDEX stock_reservations_stock_level_id_idx ON stock_reservations (stock_level_id)`);
    await queryRunner.query(`CREATE INDEX stock_reservations_expires_at_idx ON stock_reservations (expires_at) WHERE state = 'active'`);
    await queryRunner.query(`CREATE INDEX stock_movements_stock_level_id_created_at_idx ON stock_movements (stock_level_id, created_at)`);
    await queryRunner.query(`CREATE INDEX stock_movements_order_line_id_idx ON stock_movements (order_line_id)`);
    await queryRunner.query(`CREATE INDEX order_transitions_order_id_created_at_idx ON order_transitions (order_id, created_at)`);
    await queryRunner.query(`CREATE INDEX payment_attempts_order_id_idx ON payment_attempts (order_id)`);
    // Statement triggers reject UPDATE, DELETE and TRUNCATE, including zero-row operations.
    await queryRunner.query(`CREATE FUNCTION reject_commerce_history_mutation() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog AS $$
 BEGIN RAISE EXCEPTION 'commerce history is append-only' USING ERRCODE = '23514'; END; $$`);
    for (const table of ['stock_movements', 'order_transitions']) {
      await queryRunner.query(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_commerce_history_mutation()`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // The migration also guards direct TypeORM API/CLI calls that bypass our command wrapper.
    const [{ name, marker }] = await queryRunner.query(`SELECT current_database() AS name,
 shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`);
    if (!/^mnv_commerce_test_[a-z0-9_]+$/.test(name) || marker !== 'mnv-commerce:disposable-test'
        || process.env['MNV_ALLOW_DESTRUCTIVE_ROLLBACK'] !== name) {
      throw new Error('Rollback requires a marked disposable MNV test database and exact database confirmation');
    }
    const schema = quoteIdentifier(process.env['DB_SCHEMA']!);
    await queryRunner.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await queryRunner.query('DROP TABLE idempotency_records');
    await queryRunner.query('DROP TABLE payment_attempts');
    await queryRunner.query('DROP TABLE order_transitions');
    await queryRunner.query('DROP TABLE stock_movements');
    await queryRunner.query('DROP TABLE stock_reservations');
    await queryRunner.query('DROP TABLE order_lines');
    await queryRunner.query('DROP TABLE orders');
    await queryRunner.query('DROP TABLE stock_levels');
    await queryRunner.query('DROP TABLE stock_locations');
    await queryRunner.query('DROP TABLE product_variants');
    await queryRunner.query('DROP TABLE products');
    await queryRunner.query('DROP TABLE sessions');
    await queryRunner.query('DROP TABLE users');
    await queryRunner.query('DROP FUNCTION reject_commerce_history_mutation()');
  }
}
