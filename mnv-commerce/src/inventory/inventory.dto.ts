import { InventoryError } from './inventory.error';

export interface Mutation { key: string; actor: string; reason: string }
export interface CreateLocation extends Mutation { code: string; name: string }
export interface ManageLocation extends Mutation { locationId: string; name: string; archived: boolean }
export interface InitializeStock extends Mutation { variantId: string; locationId: string; quantity: number }
export interface AdjustStock extends Mutation { variantId: string; locationId: string; delta: number }
export interface Allocation { lineId: string; variantId: string; locationId: string; quantity: number }
export interface ReserveStock extends Mutation { orderId: string; expiresAt: string; items: Allocation[] }
export interface FinishReservation extends Mutation { orderId: string; reservationIds: string[] }

function invalid(field: string): never {
  throw new InventoryError('INVALID_INVENTORY_INPUT', `Invalid ${field}`, 400);
}
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('command');
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid('command fields');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) return invalid(field);
  return value;
}
export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) return invalid(field);
  return value.toLowerCase();
}
export function quantity(value: unknown, field: string, mode: 'positive' | 'initial' | 'delta' = 'positive'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 2147483647
    || (mode === 'delta' ? value === 0 : value < (mode === 'initial' ? 0 : 1))) return invalid(field);
  return value;
}
export function mutation(value: unknown, fields: string[]): Record<string, unknown> & Mutation {
  const input = object(value, ['key','actor','reason', ...fields]);
  return { ...input, key: text(input['key'], 'key'), actor: text(input['actor'], 'actor'), reason: text(input['reason'], 'reason', 1000) };
}
export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return invalid(field);
  return value;
}
export function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) return invalid(field);
  return value;
}
export function expiry(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid('expiresAt');
  return value;
}

export function allocationOrder(a: Allocation, b: Allocation): number {
  const left = `${a.variantId}:${a.locationId}:${a.lineId}`;
  const right = `${b.variantId}:${b.locationId}:${b.lineId}`;
  return left < right ? -1 : left > right ? 1 : 0;
}
