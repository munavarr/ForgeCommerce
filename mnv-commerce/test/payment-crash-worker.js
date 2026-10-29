// Test-only subprocess. No HTTP route or production module imports this worker.
const { createDataSource } = require('../dist/database/options');
const { verifyDatabaseIdentity } = require('../dist/database/safety');
const { AuthService } = require('../dist/auth/auth.service');
const { CommerceAccess } = require('../dist/commerce/access');
const { InventoryEngine } = require('../dist/inventory/inventory.engine');
const { PaymentsService } = require('../dist/payments/payments.service');
const { DevelopmentPaymentProvider } = require('../dist/payments/provider');

process.once('message', async ({ context, command }) => {
  const db = createDataSource();
  try {
    await db.initialize();
    const identity = await verifyDatabaseIdentity(db, true);
    if (identity.role !== process.env.DB_USER || identity.role === identity.owner) throw Error('Unsafe worker identity');
    // Use the deterministic simulator's lookup result to reach finalization even for a
    // key that normally simulates a lost response. This worker never contacts a provider.
    class ResponseProvider extends DevelopmentPaymentProvider {
      charge(request) { return this.lookup(request); }
    }
    const original = db.createQueryRunner.bind(db);
    let commits = 0;
    db.createQueryRunner = (...args) => {
      const runner = original(...args), commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        if (++commits === 2) {
          const [{ pid }] = await runner.query('SELECT pg_backend_pid() pid');
          process.send({ stage: 'before-finalization-commit', pid });
          // Parent kills this process. Uncommitted local writes must roll back in PostgreSQL.
          await new Promise(() => {});
        }
        return commit();
      };
      return runner;
    };
    await new PaymentsService(db, new CommerceAccess(new AuthService(db)), new InventoryEngine(db), new ResponseProvider()).start(context, command);
    throw Error('Worker unexpectedly completed');
  } catch {
    process.stderr.write('Isolated payment crash worker failed before its checkpoint.\n');
    process.exitCode = 1;
    if (db.isInitialized) await db.destroy();
    process.disconnect();
  }
});
