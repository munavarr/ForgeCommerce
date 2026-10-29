import { MigrationInterface, QueryRunner } from 'typeorm';
import { quoteIdentifier, verifyDatabaseIdentity } from '../safety';

/** Forward-only for operational databases; never rewrites existing ledger entries. */
export class InventoryEngine1793232000000 implements MigrationInterface {
  name = 'InventoryEngine1793232000000';

  async up(runner: QueryRunner): Promise<void> {
    await verifyDatabaseIdentity(runner);
    const schema = quoteIdentifier(process.env['DB_SCHEMA']!);
    await runner.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    // Fail the entire migration on inconsistent legacy data; do not "repair" history silently.
    await runner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM stock_reservations r JOIN order_lines l ON l.id=r.order_line_id
        JOIN stock_levels s ON s.id=r.stock_level_id WHERE l.variant_id<>s.variant_id)
      OR EXISTS (SELECT 1 FROM stock_reservations r JOIN order_lines l ON l.id=r.order_line_id
        WHERE r.state IN ('active','consumed') GROUP BY l.id,l.quantity HAVING sum(r.quantity)>l.quantity)
      THEN RAISE EXCEPTION 'Legacy reservations require explicit reconciliation' USING ERRCODE='23514'; END IF;
    END $$`);
    await runner.query(`ALTER TABLE stock_levels ADD COLUMN reserved integer NOT NULL DEFAULT 0`);
    await runner.query(`UPDATE stock_levels s SET reserved=(SELECT coalesce(sum(r.quantity),0)
      FROM stock_reservations r WHERE r.stock_level_id=s.id AND r.state='active')`);
    await runner.query(`ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_available
      CHECK (reserved>=0 AND reserved<=on_hand)`);
    // Existing movements retain their exact values and explicit legacy semantics.
    await runner.query(`ALTER TABLE stock_movements
      ADD COLUMN kind text NOT NULL DEFAULT 'legacy',
      ADD COLUMN on_hand_delta integer,
      ADD COLUMN reserved_delta integer,
      ADD COLUMN reservation_id uuid REFERENCES stock_reservations(id) ON DELETE RESTRICT,
      ADD COLUMN actor text NOT NULL DEFAULT 'legacy',
      ADD COLUMN request_key text,
      ADD CONSTRAINT stock_movements_kind CHECK (kind IN ('legacy','initialization','adjustment','reservation','release','sale')),
      ADD CONSTRAINT stock_movements_deltas CHECK (kind='legacy' OR (
        on_hand_delta IS NOT NULL AND reserved_delta IS NOT NULL AND length(btrim(actor))>0 AND
        ((kind IN ('initialization','adjustment') AND reservation_id IS NULL AND order_line_id IS NULL
          AND on_hand_delta=quantity_delta AND reserved_delta=0)
        OR (kind='reservation' AND reservation_id IS NOT NULL AND order_line_id IS NOT NULL
          AND on_hand_delta=0 AND reserved_delta>0 AND quantity_delta=-reserved_delta)
        OR (kind='release' AND reservation_id IS NOT NULL AND order_line_id IS NOT NULL
          AND on_hand_delta=0 AND reserved_delta<0 AND quantity_delta=-reserved_delta)
        OR (kind='sale' AND reservation_id IS NOT NULL AND order_line_id IS NOT NULL
          AND on_hand_delta<0 AND on_hand_delta=reserved_delta AND quantity_delta=on_hand_delta))))`);
    await runner.query(`CREATE UNIQUE INDEX stock_movements_reservation_kind ON stock_movements(reservation_id,kind)
      WHERE reservation_id IS NOT NULL`);

    // These SECURITY DEFINER functions run as the migration owner. All objects are qualified;
    // no caller-writable schema or pg_temp precedes pg_catalog in function resolution.
    await runner.query(`CREATE FUNCTION inventory_level_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
      IF TG_OP='UPDATE' AND (NEW.id,NEW.variant_id,NEW.location_id,NEW.created_at)
        IS DISTINCT FROM (OLD.id,OLD.variant_id,OLD.location_id,OLD.created_at)
      THEN RAISE EXCEPTION 'Stock identity is immutable' USING ERRCODE='23514'; END IF;
      IF (TG_OP='INSERT' AND NEW.reserved<>0) OR
        (TG_OP='UPDATE' AND NEW.reserved<>OLD.reserved AND pg_trigger_depth()=1)
      THEN RAISE EXCEPTION 'Reserved stock is maintained by reservations' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER inventory_level_guard BEFORE INSERT OR UPDATE ON stock_levels
      FOR EACH ROW EXECUTE FUNCTION inventory_level_guard()`);
    await runner.query(`CREATE FUNCTION inventory_adjustment_ledger() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE delta integer; BEGIN
      IF TG_OP='INSERT' THEN delta:=NEW.on_hand;
      ELSE
        -- Reservation transitions record both legs in their own single movement.
        IF NEW.reserved<>OLD.reserved THEN RETURN NEW; END IF;
        delta:=NEW.on_hand-OLD.on_hand;
      END IF;
      IF delta<>0 THEN
        INSERT INTO ${schema}.stock_movements
          (stock_level_id,quantity_delta,reason,kind,on_hand_delta,reserved_delta,actor,request_key)
        VALUES (NEW.id,delta,coalesce(nullif(current_setting('mnv.inventory_reason',true),''),'database adjustment'),
          CASE WHEN TG_OP='INSERT' THEN 'initialization' ELSE 'adjustment' END,delta,0,
          coalesce(nullif(current_setting('mnv.inventory_actor',true),''),session_user),
          nullif(current_setting('mnv.inventory_key',true),''));
      END IF;
      RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER inventory_adjustment_ledger AFTER INSERT OR UPDATE ON stock_levels
      FOR EACH ROW EXECUTE FUNCTION inventory_adjustment_ledger()`);
    await runner.query(`CREATE FUNCTION inventory_reservation_transition() RETURNS trigger
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
        SELECT * INTO STRICT line_record FROM ${schema}.order_lines WHERE id=NEW.order_line_id;
        locked_order_id:=line_record.order_id;
        -- These writes never change keys. NO KEY UPDATE avoids upgrading the FK's KEY SHARE
        -- locks into mutually conflicting UPDATE locks during concurrent direct inserts.
        SELECT state INTO STRICT order_state FROM ${schema}.orders WHERE id=line_record.order_id FOR NO KEY UPDATE;
        SELECT * INTO STRICT line_record FROM ${schema}.order_lines WHERE id=NEW.order_line_id FOR NO KEY UPDATE;
        IF line_record.order_id<>locked_order_id THEN
          RAISE EXCEPTION 'Order line changed concurrently' USING ERRCODE='40001'; END IF;
        SELECT * INTO STRICT level_record FROM ${schema}.stock_levels WHERE id=NEW.stock_level_id FOR NO KEY UPDATE;
        IF line_record.variant_id<>level_record.variant_id THEN
          RAISE EXCEPTION 'Reservation variant mismatch' USING ERRCODE='23514'; END IF;
        IF TG_OP='INSERT' THEN
          IF order_state NOT IN ('draft','placed') THEN
            RAISE EXCEPTION 'Order cannot reserve' USING ERRCODE='23514'; END IF;
          SELECT coalesce(sum(quantity),0) INTO used FROM ${schema}.stock_reservations
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
        UPDATE ${schema}.stock_levels SET on_hand=on_hand+hand_delta,reserved=reserved+reserve_delta
          WHERE id=NEW.stock_level_id;
        INSERT INTO ${schema}.stock_movements
          (stock_level_id,order_line_id,reservation_id,quantity_delta,reason,kind,on_hand_delta,reserved_delta,actor,request_key)
        VALUES (NEW.stock_level_id,NEW.order_line_id,NEW.id,
          CASE WHEN movement_kind='sale' THEN hand_delta ELSE -reserve_delta END,
          coalesce(nullif(current_setting('mnv.inventory_reason',true),''),movement_kind),
          movement_kind,hand_delta,reserve_delta,
          coalesce(nullif(current_setting('mnv.inventory_actor',true),''),session_user),
          nullif(current_setting('mnv.inventory_key',true),''));
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER inventory_reservation_transition AFTER INSERT OR UPDATE ON stock_reservations
      FOR EACH ROW EXECUTE FUNCTION inventory_reservation_transition()`);
    await runner.query(`CREATE TRIGGER inventory_reservation_retained BEFORE DELETE OR TRUNCATE ON stock_reservations
      FOR EACH STATEMENT EXECUTE FUNCTION reject_commerce_history_mutation()`);
    await runner.query(`CREATE FUNCTION inventory_line_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
        IF (NEW.id,NEW.order_id,NEW.variant_id,NEW.quantity) IS DISTINCT FROM
          (OLD.id,OLD.order_id,OLD.variant_id,OLD.quantity) AND EXISTS
          (SELECT 1 FROM ${schema}.stock_reservations WHERE order_line_id=OLD.id)
        THEN RAISE EXCEPTION 'Reserved line identity and quantity are immutable' USING ERRCODE='23514'; END IF;
        RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER inventory_line_guard BEFORE UPDATE ON order_lines
      FOR EACH ROW EXECUTE FUNCTION inventory_line_guard()`);
    for (const name of ['inventory_level_guard', 'inventory_adjustment_ledger', 'inventory_reservation_transition', 'inventory_line_guard']) {
      await runner.query(`REVOKE ALL ON FUNCTION ${schema}.${name}() FROM PUBLIC`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await verifyDatabaseIdentity(runner, true);
    if (process.env['MNV_ALLOW_DESTRUCTIVE_ROLLBACK'] !== process.env['DB_NAME']) {
      throw new Error('Inventory rollback requires exact disposable database confirmation');
    }
    const schema = quoteIdentifier(process.env['DB_SCHEMA']!);
    await runner.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await runner.query('DROP TRIGGER inventory_line_guard ON order_lines');
    await runner.query('DROP TRIGGER inventory_reservation_retained ON stock_reservations');
    await runner.query('DROP TRIGGER inventory_reservation_transition ON stock_reservations');
    await runner.query('DROP TRIGGER inventory_adjustment_ledger ON stock_levels');
    await runner.query('DROP TRIGGER inventory_level_guard ON stock_levels');
    for (const name of ['inventory_line_guard','inventory_reservation_transition','inventory_adjustment_ledger','inventory_level_guard']) {
      await runner.query(`DROP FUNCTION ${name}()`);
    }
    await runner.query(`ALTER TABLE stock_movements DROP COLUMN kind, DROP COLUMN on_hand_delta,
      DROP COLUMN reserved_delta, DROP COLUMN reservation_id, DROP COLUMN actor, DROP COLUMN request_key`);
    await runner.query('ALTER TABLE stock_levels DROP COLUMN reserved');
  }
}
