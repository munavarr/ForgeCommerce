import { MigrationInterface, QueryRunner } from 'typeorm';
import { quoteIdentifier, verifyDatabaseIdentity } from '../safety';

/** Preserves legacy rows and their snapshots. Existing placed means PaymentPending. */
export class CommerceWorkflow1793318400000 implements MigrationInterface {
  name = 'CommerceWorkflow1793318400000';
  async up(runner: QueryRunner): Promise<void> {
    await verifyDatabaseIdentity(runner);
    const s=quoteIdentifier(process.env['DB_SCHEMA']!);
    await runner.query(`SET LOCAL search_path TO ${s}, pg_catalog`);
    await runner.query(`ALTER TABLE products ADD COLUMN description text NOT NULL DEFAULT '',
      ADD COLUMN active boolean NOT NULL DEFAULT true,
      ADD CONSTRAINT products_description_length CHECK (length(description)<=10000),
      ADD CONSTRAINT products_name_length CHECK (length(name)<=200)`);
    await runner.query(`ALTER TABLE product_variants ADD COLUMN active boolean NOT NULL DEFAULT true,
      ADD CONSTRAINT variants_text_length CHECK (length(sku)<=200 AND length(name)<=200)`);
    await runner.query(`ALTER TABLE orders ADD COLUMN subtotal bigint NOT NULL DEFAULT 0 CHECK (subtotal>=0),
      ADD COLUMN tax bigint NOT NULL DEFAULT 0 CHECK (tax>=0),
      ADD COLUMN shipping bigint NOT NULL DEFAULT 0 CHECK (shipping>=0),
      ADD COLUMN pricing jsonb,
      ADD COLUMN checked_out_at timestamptz,
      ADD CONSTRAINT orders_pricing_total CHECK (checked_out_at IS NULL OR
        (pricing IS NOT NULL AND total::numeric=subtotal::numeric+tax::numeric+shipping::numeric))`);
    await runner.query(`ALTER TABLE order_lines ADD COLUMN product_description text,
      ADD COLUMN currency varchar(3) CHECK (currency ~ '^[A-Z]{3}$'),
      ADD COLUMN pricing jsonb, ADD COLUMN removed_at timestamptz`);
    await runner.query(`CREATE INDEX order_lines_active_variant_idx ON order_lines(order_id,variant_id) WHERE removed_at IS NULL`);
    await runner.query(`ALTER TABLE order_transitions ADD COLUMN actor text NOT NULL DEFAULT 'legacy',
      ADD COLUMN reason text NOT NULL DEFAULT 'legacy', ADD COLUMN request_key text,
      ADD CONSTRAINT order_transition_audit CHECK (length(btrim(actor))>0 AND length(btrim(reason))>0)`);
    await runner.query(`ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_amount_check,
      ADD CONSTRAINT payment_attempts_amount_check CHECK (amount>=0)`);
    await runner.query(`CREATE FUNCTION commerce_order_guard() RETURNS trigger LANGUAGE plpgsql
      SET search_path=pg_catalog AS $$ BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.state<>'draft' THEN RAISE EXCEPTION 'Orders start as draft' USING ERRCODE='23514'; END IF;
      ELSE
        IF (NEW.id,NEW.code,NEW.user_id,NEW.created_at,NEW.currency) IS DISTINCT FROM
          (OLD.id,OLD.code,OLD.user_id,OLD.created_at,OLD.currency) THEN
          RAISE EXCEPTION 'Order identity is immutable' USING ERRCODE='23514'; END IF;
        IF OLD.state<>'draft' AND (NEW.total,NEW.subtotal,NEW.tax,NEW.shipping,NEW.pricing,NEW.checked_out_at)
          IS DISTINCT FROM (OLD.total,OLD.subtotal,OLD.tax,OLD.shipping,OLD.pricing,OLD.checked_out_at) THEN
          RAISE EXCEPTION 'Checkout pricing is immutable' USING ERRCODE='23514'; END IF;
        IF NEW.state<>OLD.state THEN
          IF NOT ((OLD.state='draft' AND NEW.state IN ('placed','cancelled')) OR
            (OLD.state='placed' AND NEW.state IN ('paid','cancelled'))) THEN
            RAISE EXCEPTION 'Illegal order transition' USING ERRCODE='23514'; END IF;
          IF NEW.state='paid' AND NOT EXISTS (SELECT 1 FROM ${s}.payment_attempts
            WHERE order_id=OLD.id AND state='succeeded' AND amount=OLD.total AND currency=OLD.currency
              AND provider_reference IS NOT NULL) THEN
            RAISE EXCEPTION 'Paid requires recorded matching payment evidence' USING ERRCODE='23514'; END IF;
        END IF;
      END IF;
      RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER commerce_order_guard BEFORE INSERT OR UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION commerce_order_guard()`);
    await runner.query(`CREATE FUNCTION commerce_transition_ledger() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
        IF NEW.state<>OLD.state THEN
          INSERT INTO ${s}.order_transitions(order_id,from_state,to_state,actor,reason,request_key)
            VALUES (NEW.id,OLD.state,NEW.state,
              coalesce(nullif(current_setting('mnv.order_actor',true),''),session_user),
              coalesce(nullif(current_setting('mnv.order_reason',true),''),'database transition'),
              nullif(current_setting('mnv.order_key',true),''));
        END IF;
        RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER commerce_transition_ledger AFTER UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION commerce_transition_ledger()`);
    await runner.query(`CREATE FUNCTION commerce_line_guard() RETURNS trigger LANGUAGE plpgsql
      SET search_path=pg_catalog AS $$ DECLARE parent_state text; BEGIN
        SELECT state INTO STRICT parent_state FROM ${s}.orders
          WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END FOR NO KEY UPDATE;
        IF parent_state<>'draft' THEN
          RAISE EXCEPTION 'Only draft lines can change' USING ERRCODE='23514'; END IF;
        IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD AND EXISTS
          (SELECT 1 FROM ${s}.stock_reservations WHERE order_line_id=OLD.id) THEN
          RAISE EXCEPTION 'Reserved snapshots are immutable' USING ERRCODE='23514'; END IF;
        IF TG_OP='UPDATE' AND (NEW.id,NEW.order_id,NEW.variant_id,NEW.created_at)
          IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.variant_id,OLD.created_at) THEN
          RAISE EXCEPTION 'Line identity is immutable' USING ERRCODE='23514'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END $$`);
    await runner.query(`CREATE TRIGGER commerce_line_guard BEFORE INSERT OR UPDATE OR DELETE ON order_lines
      FOR EACH ROW EXECUTE FUNCTION commerce_line_guard()`);
    await runner.query(`CREATE FUNCTION commerce_payment_guard() RETURNS trigger LANGUAGE plpgsql
      SET search_path=pg_catalog AS $$ BEGIN
        IF OLD.state<>'pending' OR (NEW.id,NEW.order_id,NEW.provider,NEW.provider_reference,NEW.idempotency_key,
          NEW.amount,NEW.currency,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.provider,OLD.provider_reference,
          OLD.idempotency_key,OLD.amount,OLD.currency,OLD.created_at) THEN
          RAISE EXCEPTION 'Payment evidence is immutable' USING ERRCODE='23514'; END IF;
        RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER commerce_payment_guard BEFORE UPDATE ON payment_attempts
      FOR EACH ROW EXECUTE FUNCTION commerce_payment_guard()`);
    for (const name of ['commerce_order_guard','commerce_transition_ledger','commerce_line_guard','commerce_payment_guard']) {
      await runner.query(`REVOKE ALL ON FUNCTION ${s}.${name}() FROM PUBLIC`);
    }
  }
  async down(runner: QueryRunner): Promise<void> {
    await verifyDatabaseIdentity(runner,true);
    if (process.env['MNV_ALLOW_DESTRUCTIVE_ROLLBACK']!==process.env['DB_NAME']) throw new Error('Exact disposable confirmation required');
    const s=quoteIdentifier(process.env['DB_SCHEMA']!);
    await runner.query(`SET LOCAL search_path TO ${s}, pg_catalog`);
    for (const [name,table] of [['commerce_order_guard','orders'],['commerce_transition_ledger','orders'],
      ['commerce_line_guard','order_lines'],['commerce_payment_guard','payment_attempts']]) {
      await runner.query(`DROP TRIGGER ${name} ON ${table}`);
      await runner.query(`DROP FUNCTION ${name}()`);
    }
    await runner.query(`ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_amount_check,
      ADD CONSTRAINT payment_attempts_amount_check CHECK (amount>0)`);
    await runner.query(`ALTER TABLE products DROP COLUMN description, DROP COLUMN active, DROP CONSTRAINT products_name_length`);
    await runner.query(`ALTER TABLE product_variants DROP COLUMN active, DROP CONSTRAINT variants_text_length`);
    await runner.query(`ALTER TABLE orders DROP COLUMN subtotal, DROP COLUMN tax, DROP COLUMN shipping, DROP COLUMN pricing, DROP COLUMN checked_out_at`);
    await runner.query(`ALTER TABLE order_lines DROP COLUMN product_description, DROP COLUMN currency, DROP COLUMN pricing, DROP COLUMN removed_at`);
    await runner.query(`ALTER TABLE order_transitions DROP COLUMN actor, DROP COLUMN reason, DROP COLUMN request_key`);
  }
}
