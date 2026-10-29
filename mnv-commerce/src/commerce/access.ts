import { EntityManager } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { Injectable, Optional } from '@nestjs/common';
import { InventoryError } from '../inventory/inventory.error';

/** Only an Authorization bearer header is accepted, never a client identity/role object. */
export type AccessContext = unknown;
@Injectable()
export class CommerceAccess {
  constructor(@Optional() private readonly auth?: AuthService) {}
  async customer(context: AccessContext, tx?: EntityManager): Promise<{userId:string}> {
    const principal = await this.principal(context,tx);
    if (principal.role !== 'customer') return this.denied();
    return {userId:principal.userId};
  }
  async catalogManager(context: AccessContext, tx?: EntityManager): Promise<{actor:string}> {
    const principal = await this.principal(context,tx);
    if (principal.role !== 'administrator') return this.denied();
    return {actor:principal.userId};
  }
  private async principal(context: AccessContext, tx?: EntityManager) {
    if (!this.auth) return this.denied();
    return this.auth.authenticate(context,tx);
  }
  private denied(): never { throw new InventoryError('FORBIDDEN','Required commerce role is unavailable',403); }
}

export interface VerifiedPayment {
  provider: string; reference: string; orderId: string; amount: string; currency: string;
  outcome: 'succeeded' | 'failed';
}
/** Implementations authenticate provider evidence and return a normalized authoritative result.
 * Called once BEFORE a retriable database callback. Must perform no charge/capture side effects.
 */
@Injectable()
export class PaymentResultVerifier {
  async verify(_evidence: unknown): Promise<VerifiedPayment> {
    throw new InventoryError('PAYMENT_VERIFIER_UNAVAILABLE','An authoritative payment adapter is not configured',503);
  }
}
