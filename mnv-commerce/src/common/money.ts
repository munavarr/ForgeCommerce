import { ValueTransformer } from 'typeorm';

const MIN = -(1n << 63n);
const MAX = (1n << 63n) - 1n;

export const minorUnitsTransformer: ValueTransformer = {
  to(value: bigint): string {
    if (typeof value !== 'bigint' || value < MIN || value > MAX) {
      throw new Error('Money must be a TypeScript bigint within the PostgreSQL bigint range');
    }
    return value.toString();
  },
  from(value: string): bigint {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error('Invalid database money value');
    const amount = BigInt(value);
    if (amount < MIN || amount > MAX) throw new Error('Database money exceeds PostgreSQL bigint range');
    return amount;
  },
};

/** JSON boundary: never coerce bigint money through a JavaScript number. Also handles nested jsonb. */
export function stringifyCommerce(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}
