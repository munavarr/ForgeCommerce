import * as argon2 from 'argon2';
import { InventoryError } from '../inventory/inventory.error';

// Argon2id: 64 MiB, three passes, one lane; each hash gets a library-generated random salt.
const options = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 } as const;
export function passwordInput(value: unknown): string {
  // Do not trim, normalize, truncate, or silently replace invalid Unicode before hashing.
  if (typeof value !== 'string' || [...value].length < 15 || Buffer.byteLength(value, 'utf8') > 1024
      || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new InventoryError('INVALID_PASSWORD', 'Password must contain at least 15 characters and at most 1024 UTF-8 bytes', 400);
  }
  return value;
}
export const hashPassword = (password: string) => argon2.hash(passwordInput(password), options);
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try { return await argon2.verify(hash, passwordInput(password)); } catch { return false; }
}
