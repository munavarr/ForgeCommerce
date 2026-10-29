import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { InventoryError } from '../inventory/inventory.error';
import { stringifyCommerce } from './money';

/** Caller owns the transaction. Failed work rolls back the claim and replay response together. */
export async function idempotentCommand<T>(manager: EntityManager, schema: string, scope: string,
  operation: string, command: { key: string }, work: () => Promise<T>): Promise<T> {
  const hash = createHash('sha256').update(stringifyCommerce({ operation, command })).digest('hex');
  const inserted = await manager.query(`INSERT INTO ${schema}.idempotency_records
    (scope,key,request_hash) VALUES ($1,$2,$3) ON CONFLICT (scope,key) DO NOTHING RETURNING id`, [scope,command.key,hash]);
  const [record] = await manager.query(`SELECT * FROM ${schema}.idempotency_records
    WHERE scope=$1 AND key=$2 FOR UPDATE`, [scope,command.key]);
  if (record.request_hash !== hash) throw new InventoryError('IDEMPOTENCY_CONFLICT','Request key was used for a different command');
  if (record.state === 'completed') return record.response_body as T;
  if (!inserted.length) throw new InventoryError('IDEMPOTENCY_IN_PROGRESS','Request key has an incomplete record');
  const result = JSON.parse(stringifyCommerce(await work())) as T;
  await manager.query(`UPDATE ${schema}.idempotency_records SET state='completed',response_status=200,
    response_body=$2::jsonb WHERE id=$1`, [record.id,JSON.stringify(result)]);
  return result;
}
