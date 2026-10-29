import 'reflect-metadata';
import { createDataSource } from '../database/options';
import { migrationStatus, verifyDatabaseIdentity } from '../database/safety';
import { CommerceAccess } from '../commerce/access';
import { InventoryEngine } from '../inventory/inventory.engine';
import { DevelopmentPaymentProvider } from './provider';
import { PaymentsService } from './payments.service';

export async function reconcilePayments() {
  if(process.env['NODE_ENV']==='production') throw new Error('No production payment adapter is configured');
  const db=createDataSource();
  try {
    await db.initialize();
    const identity=await verifyDatabaseIdentity(db);
    if(identity.role!==process.env['DB_USER']||identity.role===identity.owner||!(await migrationStatus(db)).ready)
      throw new Error('Reconciliation requires migrated database and runtime role');
    return await new PaymentsService(db,new CommerceAccess(),new InventoryEngine(db),new DevelopmentPaymentProvider()).reconcile();
  } finally { if(db.isInitialized) await db.destroy(); }
}
if(require.main===module) void (async()=>{
  if(process.argv.length!==2) throw new Error('No arguments accepted');
  const result=await reconcilePayments();
  process.stdout.write(`${JSON.stringify({provider:'development-v1',...result})}\n`);
  if(result.errors.length||result.unresolved) process.exitCode=2;
})().catch(()=>{
  process.stderr.write('Payment reconciliation failed. Check database identity, migration state and provider configuration.\n');
  process.exitCode=1;
});
