import { MigrationInterface, QueryRunner } from 'typeorm';
import { quoteIdentifier, verifyDatabaseIdentity } from '../safety';

/** Extends existing attempts without rewriting legacy evidence. Old failed means definitive
 * failure; managed attempts use the explicit declined state. No new domain table. */
export class PaymentReliability1793491200000 implements MigrationInterface {
  name='PaymentReliability1793491200000';
  async up(runner:QueryRunner):Promise<void> {
    await verifyDatabaseIdentity(runner);
    const s=quoteIdentifier(process.env['DB_SCHEMA']!);
    await runner.query(`SET LOCAL search_path TO ${s}, pg_catalog`);
    await runner.query(`ALTER TABLE payment_attempts ADD COLUMN request_hash text
      CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
      DROP CONSTRAINT payment_attempts_state_check,
      ADD CONSTRAINT payment_attempts_state_check CHECK (state IN ('pending','unknown','succeeded','declined','failed')),
      ADD CONSTRAINT managed_payment_shape CHECK (request_hash IS NULL OR
        (state<>'failed' AND (state NOT IN ('succeeded','declined') OR provider_reference IS NOT NULL)))`);
    await runner.query(`CREATE UNIQUE INDEX payment_attempts_managed_order_idx ON payment_attempts(order_id) WHERE request_hash IS NOT NULL`);
    await runner.query(`CREATE INDEX payment_attempts_unresolved_idx ON payment_attempts(id) WHERE request_hash IS NOT NULL AND state IN ('pending','unknown')`);
    await runner.query(`DROP TRIGGER commerce_payment_guard ON payment_attempts`);
    await runner.query(`CREATE OR REPLACE FUNCTION commerce_payment_guard() RETURNS trigger LANGUAGE plpgsql
      SET search_path=pg_catalog AS $$ DECLARE parent record; BEGIN
        IF TG_OP='INSERT' THEN
          SELECT * INTO STRICT parent FROM ${s}.orders WHERE id=NEW.order_id FOR NO KEY UPDATE;
          IF NEW.request_hash IS NOT NULL THEN
            IF parent.state<>'placed' OR parent.checked_out_at IS NULL OR parent.total<>NEW.amount OR
              parent.currency<>NEW.currency OR NEW.state<>'pending' OR NEW.provider_reference IS NOT NULL OR
              EXISTS (SELECT 1 FROM ${s}.payment_attempts WHERE order_id=NEW.order_id) THEN
              RAISE EXCEPTION 'Invalid new managed payment' USING ERRCODE='23514'; END IF;
          ELSIF EXISTS (SELECT 1 FROM ${s}.payment_attempts WHERE order_id=NEW.order_id AND request_hash IS NOT NULL) THEN
            RAISE EXCEPTION 'Managed payment cannot be bypassed' USING ERRCODE='23514';
          END IF;
        ELSIF OLD.request_hash IS NULL THEN
          IF OLD.state<>'pending' OR (NEW.id,NEW.order_id,NEW.provider,NEW.provider_reference,NEW.idempotency_key,
            NEW.amount,NEW.currency,NEW.created_at,NEW.request_hash) IS DISTINCT FROM
            (OLD.id,OLD.order_id,OLD.provider,OLD.provider_reference,OLD.idempotency_key,
            OLD.amount,OLD.currency,OLD.created_at,OLD.request_hash) THEN
            RAISE EXCEPTION 'Legacy payment evidence is immutable' USING ERRCODE='23514'; END IF;
        ELSE
          IF OLD.state NOT IN ('pending','unknown') OR NEW.state NOT IN ('pending','unknown','succeeded','declined') OR
            (OLD.state='unknown' AND NEW.state='pending') OR
            (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference) OR
            (NEW.id,NEW.order_id,NEW.provider,NEW.idempotency_key,NEW.amount,NEW.currency,NEW.created_at,NEW.request_hash)
            IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.provider,OLD.idempotency_key,OLD.amount,OLD.currency,OLD.created_at,OLD.request_hash) THEN
            RAISE EXCEPTION 'Invalid managed payment transition' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER commerce_payment_guard BEFORE INSERT OR UPDATE ON payment_attempts
      FOR EACH ROW EXECUTE FUNCTION commerce_payment_guard()`);
    await runner.query(`CREATE TRIGGER payment_attempts_retained BEFORE DELETE OR TRUNCATE ON payment_attempts
      FOR EACH STATEMENT EXECUTE FUNCTION reject_commerce_history_mutation()`);
    await runner.query(`CREATE FUNCTION payment_cancellation_guard() RETURNS trigger LANGUAGE plpgsql
      SET search_path=pg_catalog AS $$ BEGIN
        IF NEW.state='cancelled' AND OLD.state<>NEW.state AND EXISTS
          (SELECT 1 FROM ${s}.payment_attempts WHERE order_id=OLD.id AND request_hash IS NOT NULL
            AND state IN ('pending','unknown','succeeded')) THEN
          RAISE EXCEPTION 'Unresolved payment blocks cancellation' USING ERRCODE='23514'; END IF;
        RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER payment_cancellation_guard BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION payment_cancellation_guard()`);
    // Expiry is an admission deadline, not automatic release. A confirmed managed payment
    // may consume its still-active holds after expiry during crash recovery.
    await runner.query(`CREATE OR REPLACE FUNCTION inventory_reservation_transition() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE line_record record; level_record record; order_state text; locked_order_id uuid; used bigint;
        hand_delta integer:=0; reserve_delta integer; movement_kind text;
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF OLD.state<>'active' OR NEW.state NOT IN ('released','consumed','expired') OR
            (NEW.id,NEW.order_line_id,NEW.stock_level_id,NEW.quantity,NEW.created_at,NEW.expires_at)
            IS DISTINCT FROM (OLD.id,OLD.order_line_id,OLD.stock_level_id,OLD.quantity,OLD.created_at,OLD.expires_at)
          THEN RAISE EXCEPTION 'Invalid reservation transition' USING ERRCODE='23514'; END IF;
        ELSIF NEW.state<>'active' OR NEW.expires_at<=clock_timestamp() THEN
          RAISE EXCEPTION 'Invalid new reservation' USING ERRCODE='23514';
        END IF;
        SELECT * INTO STRICT line_record FROM ${s}.order_lines WHERE id=NEW.order_line_id;
        locked_order_id:=line_record.order_id;
        -- These writes never change keys. NO KEY UPDATE avoids upgrading the FK's KEY SHARE
        -- locks into mutually conflicting UPDATE locks during concurrent direct inserts.
        SELECT state INTO STRICT order_state FROM ${s}.orders WHERE id=line_record.order_id FOR NO KEY UPDATE;
        SELECT * INTO STRICT line_record FROM ${s}.order_lines WHERE id=NEW.order_line_id FOR NO KEY UPDATE;
        IF line_record.order_id<>locked_order_id THEN
          RAISE EXCEPTION 'Order line changed concurrently' USING ERRCODE='40001'; END IF;
        SELECT * INTO STRICT level_record FROM ${s}.stock_levels WHERE id=NEW.stock_level_id FOR NO KEY UPDATE;
        IF line_record.variant_id<>level_record.variant_id THEN
          RAISE EXCEPTION 'Reservation variant mismatch' USING ERRCODE='23514'; END IF;
        IF TG_OP='INSERT' THEN
          IF order_state NOT IN ('draft','placed') THEN
            RAISE EXCEPTION 'Order cannot reserve' USING ERRCODE='23514'; END IF;
          SELECT coalesce(sum(quantity),0) INTO used FROM ${s}.stock_reservations
            WHERE order_line_id=NEW.order_line_id AND state IN ('active','consumed');
          -- AFTER trigger includes NEW in the sum. The locked line serializes split allocations.
          IF used>line_record.quantity THEN
            RAISE EXCEPTION 'Reservation exceeds order line' USING ERRCODE='23514'; END IF;
          reserve_delta:=NEW.quantity; movement_kind:='reservation';
        ELSE
          reserve_delta:=-NEW.quantity;
          IF NEW.state='consumed' THEN
            IF order_state<>'paid' OR (NEW.expires_at<=clock_timestamp() AND NOT EXISTS
              (SELECT 1 FROM ${s}.payment_attempts WHERE order_id=locked_order_id
                AND request_hash IS NOT NULL AND state='succeeded')) THEN
              RAISE EXCEPTION 'Sale requires paid order and unexpired reservation' USING ERRCODE='23514'; END IF;
            hand_delta:=-NEW.quantity; movement_kind:='sale';
          ELSE
            IF EXISTS (SELECT 1 FROM ${s}.payment_attempts WHERE order_id=locked_order_id
              AND request_hash IS NOT NULL AND state IN ('pending','unknown','succeeded')) THEN
              RAISE EXCEPTION 'Unresolved payment retains reservations' USING ERRCODE='23514'; END IF;
            movement_kind:='release';
          END IF;
        END IF;
        UPDATE ${s}.stock_levels SET on_hand=on_hand+hand_delta,reserved=reserved+reserve_delta
          WHERE id=NEW.stock_level_id;
        INSERT INTO ${s}.stock_movements
          (stock_level_id,order_line_id,reservation_id,quantity_delta,reason,kind,on_hand_delta,reserved_delta,actor,request_key)
        VALUES (NEW.stock_level_id,NEW.order_line_id,NEW.id,
          CASE WHEN movement_kind='sale' THEN hand_delta ELSE -reserve_delta END,
          coalesce(nullif(current_setting('mnv.inventory_reason',true),''),movement_kind),
          movement_kind,hand_delta,reserve_delta,
          coalesce(nullif(current_setting('mnv.inventory_actor',true),''),session_user),
          nullif(current_setting('mnv.inventory_key',true),''));
        RETURN NEW;
      END $$`);
    for(const name of ['commerce_payment_guard','payment_cancellation_guard','inventory_reservation_transition'])
      await runner.query(`REVOKE ALL ON FUNCTION ${s}.${name}() FROM PUBLIC`);
  }
  async down(runner:QueryRunner):Promise<void> {
    await verifyDatabaseIdentity(runner,true);
    if(process.env['MNV_ALLOW_DESTRUCTIVE_ROLLBACK']!==process.env['DB_NAME']) throw new Error('Exact disposable confirmation required');
    const s=quoteIdentifier(process.env['DB_SCHEMA']!);
    await runner.query(`SET LOCAL search_path TO ${s}, pg_catalog`);
    // Refuse to erase new recovery semantics or fingerprints, even in a disposable DB.
    const [row]=await runner.query(`SELECT id FROM payment_attempts WHERE request_hash IS NOT NULL LIMIT 1`);
    if(row) throw new Error('Managed attempts require forward recovery');
    await runner.query(`DROP TRIGGER payment_cancellation_guard ON orders`);
    await runner.query(`DROP FUNCTION payment_cancellation_guard()`);
    await runner.query(`DROP TRIGGER payment_attempts_retained ON payment_attempts`);
    await runner.query(`DROP TRIGGER commerce_payment_guard ON payment_attempts`);
    await runner.query(`CREATE OR REPLACE FUNCTION commerce_payment_guard() RETURNS trigger LANGUAGE plpgsql
      SET search_path=pg_catalog AS $$ BEGIN
        IF OLD.state<>'pending' OR (NEW.id,NEW.order_id,NEW.provider,NEW.provider_reference,NEW.idempotency_key,
          NEW.amount,NEW.currency,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.provider,OLD.provider_reference,
          OLD.idempotency_key,OLD.amount,OLD.currency,OLD.created_at) THEN
          RAISE EXCEPTION 'Payment evidence is immutable' USING ERRCODE='23514'; END IF;
        RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER commerce_payment_guard BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION commerce_payment_guard()`);
    await runner.query(`CREATE OR REPLACE FUNCTION inventory_reservation_transition() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE line_record record; level_record record; order_state text; locked_order_id uuid; used bigint;
        hand_delta integer:=0; reserve_delta integer; movement_kind text;
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF OLD.state<>'active' OR NEW.state NOT IN ('released','consumed','expired') OR
            (NEW.id,NEW.order_line_id,NEW.stock_level_id,NEW.quantity,NEW.created_at,NEW.expires_at)
            IS DISTINCT FROM (OLD.id,OLD.order_line_id,OLD.stock_level_id,OLD.quantity,OLD.created_at,OLD.expires_at)
          THEN RAISE EXCEPTION 'Invalid reservation transition' USING ERRCODE='23514'; END IF;
        ELSIF NEW.state<>'active' OR NEW.expires_at<=clock_timestamp() THEN
          RAISE EXCEPTION 'Invalid new reservation' USING ERRCODE='23514';
        END IF;
        SELECT * INTO STRICT line_record FROM ${s}.order_lines WHERE id=NEW.order_line_id;
        locked_order_id:=line_record.order_id;
        -- These writes never change keys. NO KEY UPDATE avoids upgrading the FK's KEY SHARE
        -- locks into mutually conflicting UPDATE locks during concurrent direct inserts.
        SELECT state INTO STRICT order_state FROM ${s}.orders WHERE id=line_record.order_id FOR NO KEY UPDATE;
        SELECT * INTO STRICT line_record FROM ${s}.order_lines WHERE id=NEW.order_line_id FOR NO KEY UPDATE;
        IF line_record.order_id<>locked_order_id THEN
          RAISE EXCEPTION 'Order line changed concurrently' USING ERRCODE='40001'; END IF;
        SELECT * INTO STRICT level_record FROM ${s}.stock_levels WHERE id=NEW.stock_level_id FOR NO KEY UPDATE;
        IF line_record.variant_id<>level_record.variant_id THEN
          RAISE EXCEPTION 'Reservation variant mismatch' USING ERRCODE='23514'; END IF;
        IF TG_OP='INSERT' THEN
          IF order_state NOT IN ('draft','placed') THEN
            RAISE EXCEPTION 'Order cannot reserve' USING ERRCODE='23514'; END IF;
          SELECT coalesce(sum(quantity),0) INTO used FROM ${s}.stock_reservations
            WHERE order_line_id=NEW.order_line_id AND state IN ('active','consumed');
          -- AFTER trigger includes NEW in the sum. The locked line serializes split allocations.
          IF used>line_record.quantity THEN
            RAISE EXCEPTION 'Reservation exceeds order line' USING ERRCODE='23514'; END IF;
          reserve_delta:=NEW.quantity; movement_kind:='reservation';
        ELSE
          reserve_delta:=-NEW.quantity;
          IF NEW.state='consumed' THEN
            IF order_state<>'paid' OR NEW.expires_at<=clock_timestamp() THEN
              RAISE EXCEPTION 'Sale requires paid order and unexpired reservation' USING ERRCODE='23514'; END IF;
            hand_delta:=-NEW.quantity; movement_kind:='sale';
          ELSE movement_kind:='release'; END IF;
        END IF;
        UPDATE ${s}.stock_levels SET on_hand=on_hand+hand_delta,reserved=reserved+reserve_delta
          WHERE id=NEW.stock_level_id;
        INSERT INTO ${s}.stock_movements
          (stock_level_id,order_line_id,reservation_id,quantity_delta,reason,kind,on_hand_delta,reserved_delta,actor,request_key)
        VALUES (NEW.stock_level_id,NEW.order_line_id,NEW.id,
          CASE WHEN movement_kind='sale' THEN hand_delta ELSE -reserve_delta END,
          coalesce(nullif(current_setting('mnv.inventory_reason',true),''),movement_kind),
          movement_kind,hand_delta,reserve_delta,
          coalesce(nullif(current_setting('mnv.inventory_actor',true),''),session_user),
          nullif(current_setting('mnv.inventory_key',true),''));
        RETURN NEW;
      END $$`);
    await runner.query(`DROP INDEX payment_attempts_managed_order_idx`);
    await runner.query(`DROP INDEX payment_attempts_unresolved_idx`);
    await runner.query(`ALTER TABLE payment_attempts DROP CONSTRAINT managed_payment_shape,
      DROP CONSTRAINT payment_attempts_state_check, DROP COLUMN request_hash,
      ADD CONSTRAINT payment_attempts_state_check CHECK (state IN ('pending','succeeded','failed'))`);
  }
}
