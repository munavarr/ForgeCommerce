import { InventoryError } from '../inventory/inventory.error';
export { object, text, uuid, boolean, quantity } from '../inventory/inventory.dto';
export const MAX_MONEY = (1n << 63n) - 1n;
export function invalid(field: string): never { throw new InventoryError('INVALID_COMMERCE_INPUT', `Invalid ${field}`,400); }
/** JSON money is a canonical nonnegative decimal string, never a floating point number. */
export function money(value: unknown, field = 'price'): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value)>MAX_MONEY) return invalid(field);
  return value;
}
export function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return invalid('currency');
  return value;
}
export function description(value: unknown): string {
  if (typeof value !== 'string' || value.length>10000) return invalid('description');
  return value;
}
export interface ProductInput { key: string; name: string; description: string; active: boolean; archived: boolean }
export interface VariantInput { key: string; sku: string; name: string; price: string; currency: string; active: boolean; archived: boolean }
export interface OrderCommand { key: string; orderId: string }
export interface LineInput extends OrderCommand { variantId: string; quantity: number }
