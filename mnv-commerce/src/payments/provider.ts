import { createHash } from 'node:crypto';
import { InventoryError } from '../inventory/inventory.error';

export type PaymentState = 'pending' | 'unknown' | 'succeeded' | 'declined';
export interface PaymentRequest {
  attemptId: string; idempotencyKey: string; orderId: string; amount: string; currency: string;
}
export type PaymentLookup = PaymentResult | { state: 'not_found' };
export interface PaymentResult extends PaymentRequest {
  provider: string; reference: string | null; state: PaymentState;
}
/** A charge retry MUST use the same request/key. Adapters must document their idempotency
 * retention window. A lookup failure is uncertainty, never evidence of a decline.
 * Notification verification authenticates raw bytes, signature and replay context BEFORE parsing.
 */
export abstract class PaymentProvider {
  abstract readonly name: string;
  assertAvailable():void {}
  abstract charge(request: PaymentRequest): Promise<PaymentResult>;
  abstract lookup(request: PaymentRequest): Promise<PaymentLookup>;
  abstract verifyNotification(evidence: unknown): Promise<PaymentResult>;
}

/** Pure simulation: no network, credentials or process-local payment ledger. The stable key
 * selects a decline, success, or lost success response; lookup survives process restarts.
 * Intentionally has NO webhook signature/test token accepted by the application.
 */
export class DevelopmentPaymentProvider extends PaymentProvider {
  readonly name = 'development-v1';
  override assertAvailable():void {
    if (process.env['NODE_ENV'] === 'production') throw new InventoryError('PAYMENT_UNAVAILABLE','Development payments are disabled',503);
  }
  private result(request: PaymentRequest): PaymentResult {
    this.assertAvailable();
    const digest = createHash('sha256').update(request.idempotencyKey).digest('hex');
    return { ...request, provider:this.name, reference:`dev:${digest}`, state:parseInt(digest.slice(0,2),16)%3===0?'declined':'succeeded' };
  }
  async charge(request: PaymentRequest): Promise<PaymentResult> {
    const result=this.result(request);
    const digest=createHash('sha256').update(request.idempotencyKey).digest();
    if (digest[0]!%3===2) throw new Error('Simulated lost provider response');
    return result;
  }
  async lookup(request: PaymentRequest): Promise<PaymentResult> { return this.result(request); }
  async verifyNotification(_evidence: unknown): Promise<PaymentResult> {
    throw new InventoryError('PAYMENT_NOTIFICATION_REJECTED','Development provider has no authenticated notifications',403);
  }
}
