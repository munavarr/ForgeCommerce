import { DataSource, EntityManager } from 'typeorm';
import { quoteIdentifier } from '../database/safety';
import { inventoryTransaction } from '../inventory/transaction';
import { InventoryError, inventoryFailure, sqlState } from '../inventory/inventory.error';
import { idempotentCommand } from '../common/idempotency';

export class CommerceStore {
  protected readonly schema: string;
  constructor(protected readonly db: DataSource) {
    this.schema=quoteIdentifier((db.options as {schema?:string}).schema ?? 'public');
  }
  protected table(name: string) { return `${this.schema}.${quoteIdentifier(name)}`; }
  protected async mutate<T>(operation: string, command: { key:string }, work: (tx:EntityManager)=>Promise<T>, authorize?: (tx:EntityManager)=>Promise<void>): Promise<T> {
    try { return await inventoryTransaction(this.db, async tx=>{
      if(authorize) await authorize(tx);
      return idempotentCommand(tx,this.schema,'commerce',operation,command,()=>work(tx));
    }); }
    catch (error) {
      if (error instanceof InventoryError) throw error;
      if (sqlState(error)==='23505') throw new InventoryError('COMMERCE_CONFLICT','A unique commerce value is already in use');
      if (sqlState(error)==='23514' || sqlState(error)==='22003') throw new InventoryError('COMMERCE_INVARIANT','Commerce invariant rejected the operation');
      return inventoryFailure(error);
    }
  }
}
