import { Injectable } from '@nestjs/common';
import { idempotentCommand } from '../common/idempotency';
import { DataSource, EntityManager } from 'typeorm';
import { quoteIdentifier } from '../database/safety';
import * as dto from './inventory.dto';
import { InventoryError, inventoryFailure } from './inventory.error';
import { inventoryTransaction } from './transaction';

interface Stock {
  id: string; variant_id: string; location_id: string;
  on_hand: number; reserved: number; available: number; sold: string;
}
interface Reservation {
  id: string; order_line_id: string; stock_level_id: string; quantity: number; state: string;
}
interface Line { id: string; order_id: string; variant_id: string; quantity: number }

/** Trusted transaction engine used by OrdersService and the authorized inventory facade.
 * Never register this engine with a controller or accept client audit actors.
 */
@Injectable()
export class InventoryEngine {
  private readonly schema: string;
  constructor(private readonly db: DataSource) {
    this.schema = quoteIdentifier((db.options as { schema?: string }).schema ?? 'public');
  }
  private table(name: string): string { return `${this.schema}.${quoteIdentifier(name)}`; }

  private async mutate<T>(operation: string, command: dto.Mutation, work: (manager: EntityManager) => Promise<T>, manager?: EntityManager): Promise<T> {
    const execute = (tx: EntityManager) => idempotentCommand(tx, this.schema, 'inventory', operation, command, async () => {
      await tx.query(`SELECT set_config('mnv.inventory_actor',$1,true),
        set_config('mnv.inventory_reason',$2,true),set_config('mnv.inventory_key',$3,true)`, [command.actor,command.reason,command.key]);
      return work(tx);
    });
    if (manager) {
      if (manager.connection !== this.db || !manager.queryRunner?.isTransactionActive) {
        throw new InventoryError('INVALID_TRANSACTION', 'Inventory requires an active transaction on its DataSource', 400);
      }
      // The owner must see raw SQLSTATEs so it can retry the WHOLE transaction, never just inventory.
      return execute(manager);
    }
    try { return await inventoryTransaction(this.db, execute); }
    catch (error) { return inventoryFailure(error); }
  }

  createLocation(value: dto.CreateLocation, manager?: EntityManager) {
    const v = dto.mutation(value, ['code','name']);
    const command = { key:v.key,actor:v.actor,reason:v.reason,code:dto.text(v['code'],'code'),name:dto.text(v['name'],'name') };
    return this.mutate('createLocation', command, async manager => {
      const [location] = await manager.query(`INSERT INTO ${this.table('stock_locations')} (code,name)
        VALUES ($1,$2) RETURNING id,code,name,archived_at`, [command.code,command.name]);
      return location;
    },manager);
  }

  manageLocation(value: dto.ManageLocation, manager?: EntityManager) {
    const v = dto.mutation(value, ['locationId','name','archived']);
    const command = { key:v.key,actor:v.actor,reason:v.reason,locationId:dto.uuid(v['locationId'],'locationId'),
      name:dto.text(v['name'],'name'),archived:dto.boolean(v['archived'],'archived') };
    return this.mutate('manageLocation', command, async manager => {
      const [location] = await manager.query(`WITH changed AS (UPDATE ${this.table('stock_locations')}
        SET name=$2,archived_at=CASE WHEN $3 THEN coalesce(archived_at,now()) ELSE NULL END
        WHERE id=$1 RETURNING id,code,name,archived_at) SELECT * FROM changed`, [command.locationId,command.name,command.archived]);
      if (!location) throw new InventoryError('LOCATION_NOT_FOUND', 'Stock location does not exist', 404);
      return location;
    },manager);
  }

  async listLocations() {
    try { return await this.db.manager.query(`SELECT id,code,name,archived_at FROM ${this.table('stock_locations')} ORDER BY code`); }
    catch (error) { return inventoryFailure(error); }
  }

  private async lockCatalog(manager: EntityManager, pairs: {variantId: string; locationId: string}[]) {
    for (const id of [...new Set(pairs.map(item => item.variantId))].sort()) {
      const [variant] = await manager.query(`SELECT id FROM ${this.table('product_variants')}
        WHERE id=$1 AND archived_at IS NULL FOR SHARE`, [id]);
      if (!variant) throw new InventoryError('VARIANT_NOT_FOUND', 'Active variant does not exist', 404);
    }
    for (const id of [...new Set(pairs.map(item => item.locationId))].sort()) {
      const [location] = await manager.query(`SELECT id FROM ${this.table('stock_locations')}
        WHERE id=$1 AND archived_at IS NULL FOR SHARE`, [id]);
      if (!location) throw new InventoryError('LOCATION_NOT_FOUND', 'Active stock location does not exist', 404);
    }
  }

  private async stock(manager: EntityManager, variantId: string, locationId: string, lock = false): Promise<Stock> {
    const [stock] = await manager.query<Stock[]>(`SELECT s.id,s.variant_id,s.location_id,s.on_hand,s.reserved,
      s.on_hand-s.reserved AS available,
      (SELECT coalesce(sum(r.quantity),0)::text FROM ${this.table('stock_reservations')} r
        WHERE r.stock_level_id=s.id AND r.state='consumed') AS sold
      FROM ${this.table('stock_levels')} s WHERE s.variant_id=$1 AND s.location_id=$2 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [variantId,locationId]);
    if (!stock) throw new InventoryError('STOCK_NOT_INITIALIZED', 'Stock has not been initialized', 404);
    return stock;
  }

  async readStock(variantId: string, locationId: string): Promise<Stock> {
    const variant = dto.uuid(variantId, 'variantId'), location = dto.uuid(locationId, 'locationId');
    try { return await this.stock(this.db.manager, variant, location); }
    catch (error) { return inventoryFailure(error); }
  }

  initializeStock(value: dto.InitializeStock, manager?: EntityManager): Promise<Stock> {
    const v = dto.mutation(value, ['variantId','locationId','quantity']);
    const command = { key:v.key,actor:v.actor,reason:v.reason,variantId:dto.uuid(v['variantId'],'variantId'),
      locationId:dto.uuid(v['locationId'],'locationId'),quantity:dto.quantity(v['quantity'],'quantity','initial') };
    return this.mutate('initializeStock', command, async manager => {
      await this.lockCatalog(manager, [command]);
      // A nonexistent row cannot be row-locked. The UNIQUE pair arbitrates concurrent INSERTs;
      // the loser never applies an initial balance to the winner's existing stock.
      const inserted = await manager.query(`INSERT INTO ${this.table('stock_levels')} (variant_id,location_id,on_hand)
        VALUES ($1,$2,$3) ON CONFLICT (variant_id,location_id) DO NOTHING RETURNING id`,
      [command.variantId,command.locationId,command.quantity]);
      if (!inserted.length) throw new InventoryError('STOCK_ALREADY_INITIALIZED', 'Stock is already initialized');
      return this.stock(manager,command.variantId,command.locationId,true);
    },manager);
  }

  adjustStock(value: dto.AdjustStock, manager?: EntityManager): Promise<Stock> {
    const v = dto.mutation(value, ['variantId','locationId','delta']);
    const command = { key:v.key,actor:v.actor,reason:v.reason,variantId:dto.uuid(v['variantId'],'variantId'),
      locationId:dto.uuid(v['locationId'],'locationId'),delta:dto.quantity(v['delta'],'delta','delta') };
    return this.mutate('adjustStock', command, async manager => {
      await this.lockCatalog(manager,[command]);
      const stock = await this.stock(manager,command.variantId,command.locationId,true);
      if (stock.on_hand+command.delta<stock.reserved || stock.on_hand+command.delta>2147483647) {
        throw new InventoryError('INSUFFICIENT_STOCK', 'Adjustment would invalidate stock quantities');
      }
      await manager.query(`UPDATE ${this.table('stock_levels')} SET on_hand=on_hand+$2 WHERE id=$1`, [stock.id,command.delta]);
      return this.stock(manager,command.variantId,command.locationId);
    },manager);
  }

  private async lockOrder(manager: EntityManager, orderId: string, states: string[]) {
    const [order] = await manager.query(`SELECT id,state FROM ${this.table('orders')} WHERE id=$1 FOR UPDATE`, [orderId]);
    if (!order) throw new InventoryError('ORDER_NOT_FOUND','Order does not exist',404);
    if (!states.includes(order.state)) throw new InventoryError('ORDER_STATE','Order state does not permit this inventory operation');
  }
  private async lockLines(manager: EntityManager, ids: string[], orderId: string): Promise<Map<string,Line>> {
    const lines = new Map<string,Line>();
    for (const id of [...new Set(ids)].sort()) {
      const [line] = await manager.query<Line[]>(`SELECT id,order_id,variant_id,quantity FROM ${this.table('order_lines')} WHERE id=$1 FOR UPDATE`, [id]);
      if (!line || line.order_id!==orderId) throw new InventoryError('ORDER_LINE_MISMATCH','Line does not belong to this order');
      lines.set(id,line);
    }
    return lines;
  }

  reserveStock(value: dto.ReserveStock, manager?: EntityManager): Promise<Reservation[]> {
    const v = dto.mutation(value,['orderId','expiresAt','items']);
    const items = dto.list(v['items'],'items').map(item => {
      const row = dto.object(item,['lineId','variantId','locationId','quantity']);
      return { lineId:dto.uuid(row['lineId'],'lineId'),variantId:dto.uuid(row['variantId'],'variantId'),
        locationId:dto.uuid(row['locationId'],'locationId'),quantity:dto.quantity(row['quantity'],'quantity') };
    }).sort(dto.allocationOrder);
    if (new Set(items.map(item => `${item.lineId}:${item.locationId}`)).size!==items.length) {
      throw new InventoryError('INVALID_INVENTORY_INPUT','Duplicate allocation',400);
    }
    const command = { key:v.key,actor:v.actor,reason:v.reason,orderId:dto.uuid(v['orderId'],'orderId'),expiresAt:dto.expiry(v['expiresAt']),items };
    return this.mutate('reserveStock',command,async manager => {
      await this.lockOrder(manager,command.orderId,['draft','placed']);
      const lines = await this.lockLines(manager,items.map(item => item.lineId),command.orderId);
      await this.lockCatalog(manager,items);
      const stocks = new Map<string,Stock>();
      // All stock locks precede all reservation writes, in variant/location lexical order.
      for (const item of items) {
        if (lines.get(item.lineId)!.variant_id!==item.variantId) throw new InventoryError('VARIANT_MISMATCH','Allocation variant does not match order line');
        const pair = `${item.variantId}:${item.locationId}`;
        if (!stocks.has(pair)) stocks.set(pair,await this.stock(manager,item.variantId,item.locationId,true));
      }
      const reservations: Reservation[] = [];
      for (const item of items) {
        const stock = stocks.get(`${item.variantId}:${item.locationId}`)!;
        if (stock.available<item.quantity) throw new InventoryError('INSUFFICIENT_STOCK','Available stock is insufficient');
        const [{ used }] = await manager.query(`SELECT coalesce(sum(quantity),0)::text AS used
          FROM ${this.table('stock_reservations')} WHERE order_line_id=$1 AND state IN ('active','consumed')`,[item.lineId]);
        if (BigInt(used)+BigInt(item.quantity)>BigInt(lines.get(item.lineId)!.quantity)) {
          throw new InventoryError('LINE_QUANTITY_EXCEEDED','Allocation exceeds order line quantity');
        }
        const [reservation] = await manager.query<Reservation[]>(`INSERT INTO ${this.table('stock_reservations')}
          (order_line_id,stock_level_id,quantity,expires_at) VALUES ($1,$2,$3,$4)
          RETURNING id,order_line_id,stock_level_id,quantity,state`, [item.lineId,stock.id,item.quantity,command.expiresAt]);
        reservations.push(reservation!);
        stock.available-=item.quantity;
      }
      return reservations;
    },manager);
  }

  releaseReservations(value: dto.FinishReservation, manager?: EntityManager) { return this.finish(value,'released',manager); }
  commitReservations(value: dto.FinishReservation, manager?: EntityManager) { return this.finish(value,'consumed',manager); }

  private finish(value: dto.FinishReservation, state: 'released' | 'consumed', manager?: EntityManager): Promise<Reservation[]> {
    const v = dto.mutation(value,['orderId','reservationIds']);
    const ids = dto.list(v['reservationIds'],'reservationIds').map(id => dto.uuid(id,'reservationId')).sort();
    if (new Set(ids).size!==ids.length) throw new InventoryError('INVALID_INVENTORY_INPUT','Duplicate reservation ID',400);
    const command = { key:v.key,actor:v.actor,reason:v.reason,orderId:dto.uuid(v['orderId'],'orderId'),reservationIds:ids };
    return this.mutate(state==='released'?'releaseReservations':'commitReservations',command,async manager => {
      await this.lockOrder(manager,command.orderId,state==='consumed'?['paid']:['draft','placed','paid','fulfilled','cancelled']);
      const rows = await manager.query<(Reservation & {variant_id:string;location_id:string;order_id:string})[]>(`
        SELECT r.id,r.order_line_id,r.stock_level_id,r.quantity,r.state,s.variant_id,s.location_id,l.order_id
        FROM ${this.table('stock_reservations')} r JOIN ${this.table('stock_levels')} s ON s.id=r.stock_level_id
        JOIN ${this.table('order_lines')} l ON l.id=r.order_line_id WHERE r.id=ANY($1::uuid[])`,[ids]);
      if (rows.length!==ids.length || rows.some(row => row.order_id!==command.orderId)) {
        throw new InventoryError('RESERVATION_MISMATCH','Reservation does not belong to this order');
      }
      await this.lockLines(manager,rows.map(row => row.order_line_id),command.orderId);
      const sorted = [...rows].sort((a,b) => dto.allocationOrder(
        {variantId:a.variant_id,locationId:a.location_id,lineId:a.order_line_id,quantity:a.quantity},
        {variantId:b.variant_id,locationId:b.location_id,lineId:b.order_line_id,quantity:b.quantity}));
      for (const row of sorted) await this.stock(manager,row.variant_id,row.location_id,true);
      const results: Reservation[] = [];
      for (const id of ids) {
        const [row] = await manager.query<Reservation[]>(`SELECT id,state FROM ${this.table('stock_reservations')} WHERE id=$1 FOR UPDATE`,[id]);
        if (row!.state!=='active') throw new InventoryError('RESERVATION_FINALIZED','Reservation has already been finalized');
        const [updated] = await manager.query<Reservation[]>(`WITH changed AS (UPDATE ${this.table('stock_reservations')} SET state=$2 WHERE id=$1
          RETURNING id,order_line_id,stock_level_id,quantity,state) SELECT * FROM changed`,[id,state]);
        results.push(updated!);
      }
      return results;
    },manager);
  }
}
