import { HttpException } from '@nestjs/common';

export class InventoryError extends HttpException {
  constructor(readonly code: string, message: string, status = 409) {
    super({ code, message }, status);
  }
}

export function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: string; driverError?: { code?: string } };
  return value.driverError?.code ?? value.code;
}

export function inventoryFailure(error: unknown): never {
  if (error instanceof InventoryError) throw error;
  switch (sqlState(error)) {
    case '23505': throw new InventoryError('INVENTORY_CONFLICT', 'Inventory record already exists');
    case '23503': throw new InventoryError('INVENTORY_REFERENCE', 'Inventory reference is invalid', 404);
    case '23514': case '22003':
      throw new InventoryError('INVENTORY_INVARIANT', 'Stock or reservation invariant rejected the operation');
    case '40001': case '40P01':
      throw new InventoryError('INVENTORY_BUSY', 'Transaction retry limit reached; retry with the same request key', 503);
    default: throw new InventoryError('INVENTORY_UNAVAILABLE', 'Inventory operation failed', 503);
  }
}
