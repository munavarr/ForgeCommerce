import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { CommerceAccess, AccessContext, PaymentResultVerifier } from './access';
import { CommerceStore } from './store';
import { CatalogService } from './catalog.service';
import { assertOrderTransition, lifecycleName } from './states';
import { PricingPolicy } from './pricing';
import { InventoryEngine } from '../inventory/inventory.engine';
import { inventoryTransaction } from '../inventory/transaction';
import { InventoryError } from '../inventory/inventory.error';
import * as dto from './commerce.dto';

@Injectable()
export class OrdersService extends CommerceStore {
  constructor(db:DataSource,private readonly access:CommerceAccess,private readonly catalog:CatalogService,
    private readonly inventory:InventoryEngine,private readonly policy:PricingPolicy,private readonly payments:PaymentResultVerifier) { super(db); }

  private async customerMutation<T>(operation:string,command:{key:string;userId:string},context:AccessContext,work:(tx:EntityManager)=>Promise<T>) {
    return this.mutate(operation,command,work,async tx=>{
      const principal=await this.access.customer(context,tx);
      if(principal.userId!==command.userId) throw new InventoryError('FORBIDDEN','Customer changed',403);
      const [user]=await tx.query(`SELECT id FROM ${this.table('users')} WHERE id=$1 AND archived_at IS NULL FOR SHARE`,[command.userId]);
      if(!user) throw new InventoryError('FORBIDDEN','Customer is unavailable',403);
    });
  }
  private async customer(context:AccessContext) { return dto.uuid((await this.access.customer(context)).userId,'customer'); }
  private command(input:unknown,fields:string[] = []): Record<string,unknown> & dto.OrderCommand {
    const v=dto.object(input,['key','orderId',...fields]);
    return { ...v,key:dto.text(v['key'],'key'),orderId:dto.uuid(v['orderId'],'orderId') };
  }
  private async owner(tx:EntityManager,id:string,userId:string) {
    const [order]=await tx.query(`SELECT o.* FROM ${this.table('orders')} o WHERE o.id=$1 AND o.user_id=$2 FOR UPDATE`,[id,userId]);
    // Deliberately identical result for missing and foreign orders.
    if (!order) throw new InventoryError('ORDER_NOT_FOUND','Order does not exist',404);
    const [user]=await tx.query(`SELECT id FROM ${this.table('users')} WHERE id=$1 AND archived_at IS NULL FOR SHARE`,[userId]);
    if (!user) throw new InventoryError('FORBIDDEN','Customer is unavailable',403);
    return order;
  }
  private draft(order:{state:string}) {
    if (order.state!=='draft') throw new InventoryError('ORDER_STATE','Only draft orders can change');
  }
  private async view(tx:EntityManager,id:string) {
    const [order]=await tx.query(`SELECT * FROM ${this.table('orders')} WHERE id=$1`,[id]);
    const lines=await tx.query(`SELECT * FROM ${this.table('order_lines')} WHERE order_id=$1 AND removed_at IS NULL ORDER BY id`,[id]);
    return { ...order,lifecycle:lifecycleName(order.state),lines };
  }
  async read(context:AccessContext,id:string) {
    const userId=await this.customer(context); dto.uuid(id,'orderId');
    // One transaction so ownership and the returned projection share the order lock.
    return inventoryTransaction(this.db,async tx=>{await this.access.customer(context,tx); await this.owner(tx,id,userId); return this.view(tx,id);});
  }
  async createDraft(context:AccessContext,input:{key:string}) {
    const userId=await this.customer(context), v=dto.object(input,['key']);
    const command={key:dto.text(v['key'],'key'),userId};
    return this.customerMutation('createDraft',command,context,async tx=>{
      const [user]=await tx.query(`SELECT id FROM ${this.table('users')} WHERE id=$1 AND archived_at IS NULL FOR SHARE`,[userId]);
      if (!user) throw new InventoryError('FORBIDDEN','Customer is unavailable',403);
      const [o]=await tx.query(`INSERT INTO ${this.table('orders')}(code,user_id,currency,total)
        VALUES ($1,$2,$3,0) RETURNING id`,[randomUUID(),userId,this.policy.configuration.currency]);
      return this.view(tx,o.id);
    });
  }
  /** Add is an absolute upsert by variant. Repeated keys replay; new keys set quantity, never increment it. */
  async setLine(context:AccessContext,input:dto.LineInput) {
    const userId=await this.customer(context),v=this.command(input,['variantId','quantity']);
    const command={key:v.key,orderId:v.orderId,userId,variantId:dto.uuid(v['variantId'],'variantId'),quantity:dto.quantity(v['quantity'],'quantity')};
    return this.customerMutation('setLine',command,context,async tx=>{
      const order=await this.owner(tx,command.orderId,userId); this.draft(order);
      const variant=(await this.catalog.eligible(tx,[command.variantId],order.currency)).get(command.variantId)!;
      const existing=await tx.query(`SELECT id FROM ${this.table('order_lines')} WHERE order_id=$1 AND variant_id=$2 ORDER BY id FOR UPDATE`,[order.id,command.variantId]);
      if (existing.length>1) throw new InventoryError('LEGACY_ORDER_REQUIRES_REVIEW','Legacy duplicate variants require explicit reconciliation');
      if (existing.length) {
        await tx.query(`UPDATE ${this.table('order_lines')} SET quantity=$2,removed_at=NULL,sku=$3,product_name=$4,
          variant_name=$5,unit_price=$6,product_description=$7,currency=$8 WHERE id=$1`,
        [existing[0].id,command.quantity,variant.sku,variant.product_name,variant.variant_name,variant.unit_price,variant.product_description,variant.currency]);
      } else {
        const [{n}]=await tx.query(`SELECT count(*)::int n FROM ${this.table('order_lines')} WHERE order_id=$1`,[order.id]);
        if(n>=100) dto.invalid('line limit');
        await tx.query(`INSERT INTO ${this.table('order_lines')}(order_id,variant_id,sku,product_name,variant_name,quantity,unit_price,product_description,currency)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[order.id,variant.id,variant.sku,variant.product_name,variant.variant_name,command.quantity,variant.unit_price,variant.product_description,variant.currency]);
      }
      await this.reprice(tx,order);
      return this.view(tx,order.id);
    });
  }
  async removeLine(context:AccessContext,input:dto.OrderCommand & {variantId:string}) {
    const userId=await this.customer(context),v=this.command(input,['variantId']);
    const command={key:v.key,orderId:v.orderId,userId,variantId:dto.uuid(v['variantId'],'variantId')};
    return this.customerMutation('removeLine',command,context,async tx=>{
      const order=await this.owner(tx,command.orderId,userId); this.draft(order);
      await tx.query(`UPDATE ${this.table('order_lines')} SET removed_at=now() WHERE order_id=$1 AND variant_id=$2 AND removed_at IS NULL`,[order.id,command.variantId]);
      await this.reprice(tx,order); return this.view(tx,order.id);
    });
  }
  private async reprice(tx:EntityManager,order:{id:string;currency:string}) {
    const lines=await tx.query<{id:string;variant_id:string;quantity:number;unit_price:string}[]>(`SELECT * FROM ${this.table('order_lines')} WHERE order_id=$1 AND removed_at IS NULL ORDER BY id FOR UPDATE`,[order.id]);
    const variants=await this.catalog.eligible(tx,[...new Set<string>(lines.map(l=>l.variant_id))].sort(),order.currency);
    for(const line of lines) {
      const v=variants.get(line.variant_id)!;
      line.unit_price=v.unit_price;
      await tx.query(`UPDATE ${this.table('order_lines')} SET sku=$2,product_name=$3,variant_name=$4,unit_price=$5,
        product_description=$6,currency=$7,pricing=$8::jsonb WHERE id=$1`,
      [line.id,v.sku,v.product_name,v.variant_name,v.unit_price,v.product_description,v.currency,JSON.stringify(this.policy.calculate([line]).pricing)]);
    }
    const totals=this.policy.calculate(lines);
    await tx.query(`UPDATE ${this.table('orders')} SET subtotal=$2,tax=$3,shipping=$4,total=$5,pricing=$6::jsonb WHERE id=$1`,
      [order.id,totals.subtotal,totals.tax,totals.shipping,totals.total,JSON.stringify(totals.pricing)]);
    return {lines,totals};
  }
  private async transition(tx:EntityManager,orderId:string,state:string,actor:string,key:string,reason:string) {
    const [current]=await tx.query(`SELECT state FROM ${this.table('orders')} WHERE id=$1 FOR UPDATE`,[orderId]);
    assertOrderTransition(current.state,state);
    await tx.query(`SELECT set_config('mnv.order_actor',$1,true),set_config('mnv.order_key',$2,true),set_config('mnv.order_reason',$3,true)`,[actor,key,reason]);
    await tx.query(`UPDATE ${this.table('orders')} SET state=$2 WHERE id=$1`,[orderId,state]);
  }
  async checkout(context:AccessContext,input:dto.OrderCommand) {
    const userId=await this.customer(context),v=this.command(input);
    const command={key:v.key,orderId:v.orderId,userId};
    return this.customerMutation('checkout',command,context,async tx=>{
      const order=await this.owner(tx,command.orderId,userId); this.draft(order);
      const [held]=await tx.query(`SELECT r.id FROM ${this.table('stock_reservations')} r
        JOIN ${this.table('order_lines')} l ON l.id=r.order_line_id WHERE l.order_id=$1 LIMIT 1`,[order.id]);
      if(held) throw new InventoryError('LEGACY_ORDER_REQUIRES_REVIEW','Draft with existing reservation history requires explicit reconciliation');
      const {lines}=await this.reprice(tx,order);
      if(!lines.length) throw new InventoryError('EMPTY_ORDER','An empty order cannot be checked out',400);
      // One server-selected fulfillment location, never a client-supplied allocation.
      const [location]=await tx.query(`SELECT id FROM ${this.table('stock_locations')}
        WHERE archived_at IS NULL AND code=$1 FOR SHARE`,[this.policy.configuration.fulfillmentLocationCode??'MAIN']);
      if(!location) throw new InventoryError('LOCATION_NOT_FOUND','No fulfillment location is configured');
      await this.inventory.reserveStock({key:this.inventoryKey('checkout',command.key),actor:userId,reason:'checkout',orderId:order.id,
        expiresAt:new Date(Date.now()+this.policy.configuration.reservationSeconds*1000).toISOString(),
        items:lines.map(l=>({lineId:l.id,variantId:l.variant_id,locationId:location.id,quantity:l.quantity}))},tx);
      await tx.query(`UPDATE ${this.table('orders')} SET checked_out_at=clock_timestamp() WHERE id=$1`,[order.id]);
      await this.transition(tx,order.id,'placed',userId,command.key,'checkout');
      return this.view(tx,order.id);
    });
  }
  private inventoryKey(operation:string,key:string) { return `${operation}:${createHash('sha256').update(key).digest('hex')}`; }
  private async reservationIds(tx:EntityManager,orderId:string) {
    const rows=await tx.query(`SELECT r.id FROM ${this.table('stock_reservations')} r
      JOIN ${this.table('order_lines')} l ON l.id=r.order_line_id WHERE l.order_id=$1 AND r.state='active' ORDER BY r.id`,[orderId]);
    return rows.map((r:{id:string})=>r.id);
  }
  async cancel(context:AccessContext,input:dto.OrderCommand) {
    const userId=await this.customer(context),v=this.command(input);
    const command={key:v.key,orderId:v.orderId,userId};
    return this.customerMutation('cancel',command,context,async tx=>{
      const order=await this.owner(tx,command.orderId,userId);
      if(!['draft','placed'].includes(order.state)) throw new InventoryError('ORDER_STATE','Order cannot be cancelled');
      const [unresolved]=await tx.query(`SELECT id FROM ${this.table('payment_attempts')} WHERE order_id=$1
        AND request_hash IS NOT NULL AND state IN ('pending','unknown','succeeded') LIMIT 1`,[order.id]);
      if(unresolved) throw new InventoryError('PAYMENT_UNRESOLVED','Reconcile the payment before cancellation');
      await this.release(tx,order.id,userId,command.key,'customer cancellation');
      await this.transition(tx,order.id,'cancelled',userId,command.key,'customer cancellation');
      return this.view(tx,order.id);
    });
  }
  private async release(tx:EntityManager,orderId:string,actor:string,key:string,reason:string) {
    const ids=await this.reservationIds(tx,orderId);
    if(ids.length) await this.inventory.releaseReservations({key:this.inventoryKey('release',key),actor,reason,orderId,reservationIds:ids},tx);
  }
  /** No HTTP entry point. Verification is outside retries; provider I/O must never charge here. */
  async recordPayment(input:{key:string;evidence:unknown}) {
    const v=dto.object(input,['key','evidence']),key=dto.text(v['key'],'key');
    const evidence=await this.payments.verify(v['evidence']);
    const command={key,provider:dto.text(evidence.provider,'provider'),reference:dto.text(evidence.reference,'reference'),
      orderId:dto.uuid(evidence.orderId,'orderId'),amount:dto.money(evidence.amount,'amount'),currency:dto.currency(evidence.currency),outcome:evidence.outcome};
    if(!['succeeded','failed'].includes(command.outcome)) dto.invalid('payment outcome');
    return this.mutate('recordPayment',command,async tx=>{
      const [order]=await tx.query(`SELECT * FROM ${this.table('orders')} WHERE id=$1 FOR UPDATE`,[command.orderId]);
      if(!order) throw new InventoryError('ORDER_NOT_FOUND','Order does not exist',404);
      const [managed]=await tx.query(`SELECT id FROM ${this.table('payment_attempts')} WHERE order_id=$1 AND request_hash IS NOT NULL`,[order.id]);
      if(managed) throw new InventoryError('PAYMENT_UNRESOLVED','Managed payments require provider reconciliation');
      const [previous]=await tx.query(`SELECT * FROM ${this.table('payment_attempts')} WHERE provider=$1 AND provider_reference=$2`,[command.provider,command.reference]);
      if(previous) {
        if(previous.order_id!==order.id || previous.amount!==command.amount || previous.currency!==command.currency || previous.state!==command.outcome)
          throw new InventoryError('PAYMENT_CONFLICT','Payment reference conflicts with recorded evidence');
        return this.view(tx,order.id);
      }
      if(order.state!=='placed') throw new InventoryError('ORDER_STATE','Payment requires PaymentPending');
      if(!order.checked_out_at) throw new InventoryError('LEGACY_ORDER_REQUIRES_REVIEW','Payment requires a complete checkout snapshot');
      if(order.total!==command.amount || order.currency!==command.currency)
        throw new InventoryError('PAYMENT_MISMATCH','Payment amount or currency does not match checkout');
      if(command.outcome==='succeeded') {
        const [invalid]=await tx.query(`SELECT l.id FROM ${this.table('order_lines')} l WHERE l.order_id=$1 AND l.removed_at IS NULL AND
          l.quantity<>(SELECT coalesce(sum(r.quantity),0) FROM ${this.table('stock_reservations')} r
          WHERE r.order_line_id=l.id AND r.state='active' AND r.expires_at>clock_timestamp()) LIMIT 1`,[order.id]);
        if(invalid) throw new InventoryError('RESERVATION_EXPIRED','Payment requires complete unexpired reservations');
      }
      await tx.query(`INSERT INTO ${this.table('payment_attempts')}(order_id,provider,provider_reference,idempotency_key,amount,currency,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[order.id,command.provider,command.reference,`result:${key}`,command.amount,command.currency,command.outcome]);
      if(command.outcome==='succeeded') {
        await this.transition(tx,order.id,'paid',command.provider,key,'authoritative payment succeeded');
        await this.inventory.commitReservations({key:this.inventoryKey('payment',key),actor:command.provider,reason:'authoritative payment succeeded',
          orderId:order.id,reservationIds:await this.reservationIds(tx,order.id)},tx);
      } else {
        await this.release(tx,order.id,command.provider,key,'authoritative payment failed');
        await this.transition(tx,order.id,'cancelled',command.provider,key,'authoritative payment failed');
      }
      return this.view(tx,order.id);
    });
  }
}
