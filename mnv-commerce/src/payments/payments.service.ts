import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { CommerceAccess, AccessContext } from '../commerce/access';
import { CommerceStore } from '../commerce/store';
import * as dto from '../commerce/commerce.dto';
import { InventoryEngine } from '../inventory/inventory.engine';
import { inventoryTransaction } from '../inventory/transaction';
import { InventoryError } from '../inventory/inventory.error';
import { PaymentProvider, PaymentRequest, PaymentResult, PaymentState } from './provider';

interface Attempt {
  id:string; order_id:string; amount:string; currency:string; provider:string;
  provider_reference:string|null; idempotency_key:string; state:PaymentState;
}
const terminal=(state:PaymentState)=>state==='succeeded'||state==='declined';
export function validateResult(result:PaymentResult, request:PaymentRequest, provider:string):void {
  if (!result || result.provider!==provider || result.attemptId!==request.attemptId ||
    result.idempotencyKey!==request.idempotencyKey || result.orderId!==request.orderId ||
    result.amount!==request.amount || result.currency!==request.currency ||
    !['pending','unknown','succeeded','declined'].includes(result.state) ||
    (result.reference!==null && (typeof result.reference!=='string'||!result.reference.trim()||result.reference.length>200)) ||
    (terminal(result.state)&&!result.reference))
    throw new InventoryError('PAYMENT_MISMATCH','Provider result does not match the persisted payment request');
}

@Injectable()
export class PaymentsService extends CommerceStore {
  constructor(db:DataSource,private readonly access:CommerceAccess,private readonly inventory:InventoryEngine,
    private readonly provider:PaymentProvider) { super(db); }

  /** Trusted service API only. No development-payment controller is registered. */
  async start(context:AccessContext,input:{key:string;orderId:string}) {
    this.provider.assertAvailable();
    const v=dto.object(input,['key','orderId']);
    const userId=dto.uuid((await this.access.customer(context)).userId,'customer');
    const command={key:dto.text(v['key'],'key'),orderId:dto.uuid(v['orderId'],'orderId'),userId};
    const saved=await this.mutate('startPayment',command,async tx=>{
      const [order]=await tx.query(`SELECT * FROM ${this.table('orders')} WHERE id=$1 AND user_id=$2 FOR UPDATE`,[command.orderId,userId]);
      if(!order) throw new InventoryError('ORDER_NOT_FOUND','Order does not exist',404);
      if(order.state!=='placed'||!order.checked_out_at) throw new InventoryError('ORDER_STATE','Payment requires a frozen checkout');
      await this.completeHolds(tx,order.id,true);
      const [prior]=await tx.query(`SELECT id FROM ${this.table('payment_attempts')} WHERE order_id=$1`,[order.id]);
      if(prior) throw new InventoryError('PAYMENT_EXISTS','Use the original payment key or reconciliation');
      // The request fingerprint includes the frozen amount/currency and owner. The public
      // command has no client-selected amount, provider, state or test outcome.
      const hash=createHash('sha256').update(JSON.stringify({orderId:order.id,userId,amount:order.total,currency:order.currency,provider:this.provider.name})).digest('hex');
      const [attempt]=await tx.query(`INSERT INTO ${this.table('payment_attempts')}
        (order_id,provider,idempotency_key,amount,currency,request_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [order.id,this.provider.name,`payment:${randomUUID()}`,order.total,order.currency,hash]);
      return {id:attempt.id as string};
    },async tx=>{
      if((await this.access.customer(context,tx)).userId!==userId) throw new InventoryError('FORBIDDEN','Customer changed',403);
    });
    // The transaction and idempotency record are COMMITTED before any provider call.
    return this.execute(saved.id,'charge');
  }
  private request(a:Attempt):PaymentRequest {
    return {attemptId:a.id,idempotencyKey:a.idempotency_key,orderId:a.order_id,amount:a.amount,currency:a.currency};
  }
  private async attempt(id:string):Promise<Attempt> {
    const [a]=await this.db.query(`SELECT * FROM ${this.table('payment_attempts')} WHERE id=$1 AND request_hash IS NOT NULL`,[id]);
    if(!a) throw new InventoryError('PAYMENT_NOT_FOUND','Managed payment attempt does not exist',404);
    if(a.provider!==this.provider.name) throw new InventoryError('PAYMENT_UNAVAILABLE','Attempt provider is unavailable',503);
    return a as Attempt;
  }
  private async execute(id:string,operation:'charge'|'lookup') {
    const a=await this.attempt(id);
    if(terminal(a.state)) return a;
    let result:PaymentResult;
    try {
      const request=this.request(a);
      const observed=operation==='lookup'?await this.provider.lookup(request):await this.provider.charge(request);
      // Only an authoritative not-found lookup permits resubmission, with the original key.
      result=observed.state==='not_found'?await this.provider.charge(request):observed;
    }
    catch { return this.unknown(id); }
    try { validateResult(result,this.request(a),this.provider.name); }
    catch(error) { await this.unknown(id); throw error; }
    // A new transaction finalizes the local result. On a crash/failure it leaves the
    // durable pending/unknown attempt available for lookup, including ambiguous commits.
    return this.finalize(id,result);
  }
  private unknown(id:string) {
    return inventoryTransaction(this.db,async tx=>{
      const a=await this.lock(tx,id);
      if(!terminal(a.state)) await tx.query(`UPDATE ${this.table('payment_attempts')} SET state='unknown' WHERE id=$1`,[id]);
      return this.current(tx,id);
    });
  }
  private async current(tx:EntityManager,id:string):Promise<Attempt> {
    return (await tx.query(`SELECT * FROM ${this.table('payment_attempts')} WHERE id=$1`,[id]))[0] as Attempt;
  }
  private async lock(tx:EntityManager,id:string) {
    // All payment, cancellation and inventory paths lock order before attempt/stock.
    const [hint]=await tx.query(`SELECT order_id FROM ${this.table('payment_attempts')} WHERE id=$1 AND request_hash IS NOT NULL`,[id]);
    if(!hint) throw new InventoryError('PAYMENT_NOT_FOUND','Managed payment attempt does not exist',404);
    await tx.query(`SELECT id FROM ${this.table('orders')} WHERE id=$1 FOR UPDATE`,[hint.order_id]);
    const [a]=await tx.query(`SELECT * FROM ${this.table('payment_attempts')} WHERE id=$1 FOR UPDATE`,[id]);
    return a as Attempt;
  }
  private async completeHolds(tx:EntityManager,orderId:string,unexpired:boolean) {
    const [invalid]=await tx.query(`SELECT l.id FROM ${this.table('order_lines')} l WHERE l.order_id=$1 AND l.removed_at IS NULL AND
      l.quantity<>(SELECT coalesce(sum(r.quantity),0) FROM ${this.table('stock_reservations')} r
      WHERE r.order_line_id=l.id AND r.state='active' ${unexpired?'AND r.expires_at>clock_timestamp()':''}) LIMIT 1`,[orderId]);
    const [line]=await tx.query(`SELECT id FROM ${this.table('order_lines')} WHERE order_id=$1 AND removed_at IS NULL LIMIT 1`,[orderId]);
    if(invalid||!line) throw new InventoryError('RESERVATION_EXPIRED','Payment requires complete held reservations');
  }
  private finalize(id:string,result:PaymentResult) {
    return inventoryTransaction(this.db,async tx=>{
      const a=await this.lock(tx,id);
      validateResult(result,this.request(a),a.provider);
      if(terminal(a.state)) {
        // Stale pending/unknown notifications cannot regress a terminal result.
        if(terminal(result.state)&&(a.state!==result.state||a.provider_reference!==result.reference))
          throw new InventoryError('PAYMENT_CONFLICT','Conflicting terminal provider result requires investigation');
        return a;
      }
      const [order]=await tx.query(`SELECT * FROM ${this.table('orders')} WHERE id=$1`,[a.order_id]);
      if(order.state!=='placed'||!order.checked_out_at||order.total!==a.amount||order.currency!==a.currency)
        throw new InventoryError('PAYMENT_MISMATCH','Payment cannot finalize this order snapshot');
      if(a.provider_reference && result.reference && a.provider_reference!==result.reference)
        throw new InventoryError('PAYMENT_CONFLICT','Provider reference changed');
      const state=a.state==='unknown'&&result.state==='pending'?'unknown':result.state;
      await tx.query(`UPDATE ${this.table('payment_attempts')} SET state=$2,provider_reference=coalesce(provider_reference,$3) WHERE id=$1`,[id,state,result.reference]);
      if(terminal(state)) {
        if(state==='succeeded') await this.completeHolds(tx,order.id,false);
        await tx.query(`SELECT set_config('mnv.order_actor',$1,true),set_config('mnv.order_key',$2,true),set_config('mnv.order_reason',$3,true)`,[a.provider,a.idempotency_key,`payment ${state}`]);
        await tx.query(`UPDATE ${this.table('orders')} SET state=$2 WHERE id=$1`,[order.id,state==='succeeded'?'paid':'cancelled']);
        const rows=await tx.query(`SELECT r.id FROM ${this.table('stock_reservations')} r JOIN ${this.table('order_lines')} l ON l.id=r.order_line_id
          WHERE l.order_id=$1 AND r.state='active' ORDER BY r.id`,[order.id]);
        const command={key:`finalize:${a.id}`,actor:a.provider,reason:`payment ${state}`,orderId:order.id,reservationIds:rows.map((r:{id:string})=>r.id)};
        if(state==='succeeded') await this.inventory.commitReservations(command,tx);
        else if(rows.length) await this.inventory.releaseReservations(command,tx);
      }
      return this.current(tx,id);
    });
  }
  /** Internal transport boundary for a future signed provider. Development always rejects.
   * Tests inject an opaque authority in their own fixture; no test secret/token is installed.
   */
  async notification(evidence:unknown) {
    const result=await this.provider.verifyNotification(evidence);
    dto.uuid(result.attemptId,'attemptId');
    const a=await this.attempt(result.attemptId);
    validateResult(result,this.request(a),this.provider.name);
    return this.finalize(a.id,result);
  }
  async reconcileAttempt(id:string) { return this.execute(dto.uuid(id,'attemptId'),'lookup'); }
  /** Keyset scan, one bounded page per query. A failed item does not starve later attempts.
   * Restarting scans unresolved rows again; no in-memory cursor is needed for recovery.
   */
  async reconcile() {
    let cursor='00000000-0000-0000-0000-000000000000',processed=0,unresolved=0;
    const errors:string[]=[];
    for(;;) {
      const rows: {id:string}[]=await this.db.query(`SELECT id FROM ${this.table('payment_attempts')}
        WHERE request_hash IS NOT NULL AND state IN ('pending','unknown') AND id>$1 ORDER BY id LIMIT 100`,[cursor]);
      if(!rows.length) break;
      for(const row of rows) {
        try { const result=await this.reconcileAttempt(row.id); processed++; if(!terminal(result.state)) unresolved++; }
        catch { errors.push(row.id); }
      }
      cursor=rows[rows.length-1]!.id;
    }
    return {processed,unresolved,errors};
  }
}
