import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { CommerceStore } from '../commerce/store';
import { object } from '../commerce/commerce.dto';
import { InventoryError, sqlState } from '../inventory/inventory.error';
import { inventoryTransaction } from '../inventory/transaction';
import { hashPassword, passwordInput, verifyPassword } from './password';

export type Role = 'customer' | 'administrator';
export interface Principal { userId: string; email: string; role: Role }
export function credentials(input: unknown) {
  const v = object(input, ['email', 'password']);
  const email = v['email'];
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new InventoryError('INVALID_EMAIL', 'A valid email address is required', 400);
  }
  return { email: email.toLowerCase(), password: passwordInput(v['password']) };
}
export function tokenDigest(context: unknown): string {
  if (typeof context !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(context)) return unauthorized();
  const token = context.slice(7);
  if (Buffer.from(token, 'base64url').toString('base64url') !== token) return unauthorized();
  return createHash('sha256').update(token).digest('hex');
}
export function unauthorized(): never { throw new InventoryError('UNAUTHENTICATED', 'A valid bearer session is required', 401); }

@Injectable()
export class AuthService extends CommerceStore {
  // Fixed absolute expiry; no client-controlled lifetime and no bearer-token cache.
  static readonly sessionSeconds = 8 * 60 * 60;
  private dummyHash?: Promise<string>;
  constructor(db: DataSource) { super(db); }
  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof InventoryError) throw error;
      if (sqlState(error) === '23505') throw new InventoryError('ACCOUNT_CONFLICT', 'Account could not be created', 409);
      // Driver errors can include SQL parameters, including hashes: never allow Nest to log them.
      throw new InventoryError('AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable', 503);
    }
  }
  async register(input: unknown) {
    const v = credentials(input);
    return this.safe(async () => {
      const hash = await hashPassword(v.password);
      const [user] = await this.db.query(`INSERT INTO ${this.table('users')}(email,password_hash)
        VALUES ($1,$2) RETURNING id,email,role,email_verified_at`, [v.email,hash]);
      return user;
    });
  }
  async login(input: unknown) {
    const v = credentials(input);
    return this.safe(async () => {
      const [user] = await this.db.query(`SELECT id,email,role,password_hash,archived_at FROM ${this.table('users')} WHERE email=$1`, [v.email]);
      const fallback = await (this.dummyHash ??= hashPassword(randomBytes(32).toString('hex')));
      const valid = await verifyPassword(user?.password_hash ?? fallback, v.password);
      if (!valid || !user || user.archived_at) return unauthorized();
      const token = randomBytes(32).toString('base64url');
      const digest = tokenDigest(`Bearer ${token}`);
      // Recheck under lock so archival or credential changes cannot race session issuance.
      return inventoryTransaction(this.db, async tx => {
        const [current] = await tx.query(`SELECT id,email,role,email_verified_at FROM ${this.table('users')}
          WHERE id=$1 AND archived_at IS NULL AND password_hash=$2 FOR SHARE`, [user.id,user.password_hash]);
        if (!current) return unauthorized();
        const [session] = await tx.query(`INSERT INTO ${this.table('sessions')}(user_id,token_hash,expires_at)
          VALUES ($1,$2,clock_timestamp()+$3*interval '1 second') RETURNING expires_at`, [user.id,digest,AuthService.sessionSeconds]);
        return { token, tokenType: 'Bearer', expiresAt: session.expires_at, user: current };
      });
    });
  }
  async authenticate(context: unknown, tx?: EntityManager): Promise<Principal> {
    const digest = tokenDigest(context);
    return this.safe(async () => {
      const [user] = await (tx ?? this.db.manager).query(`SELECT u.id AS "userId",u.email,u.role
        FROM ${this.table('sessions')} s JOIN ${this.table('users')} u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND u.archived_at IS NULL ${tx ? 'FOR SHARE OF s,u' : ''}`, [digest]);
      if (!user) return unauthorized();
      return user;
    });
  }
  async logout(context: unknown) {
    const digest = tokenDigest(context);
    return this.safe(async () => {
      await this.db.query(`UPDATE ${this.table('sessions')} SET revoked_at=coalesce(revoked_at,clock_timestamp())
        WHERE token_hash=$1`, [digest]);
      return { revoked: true };
    });
  }
}
