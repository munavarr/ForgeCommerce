const assert = require('node:assert/strict');
const test = require('node:test');
const { InventoryEngine: InventoryService } = require('../dist/inventory/inventory.engine');
const { inventoryTransaction } = require('../dist/inventory/transaction');
const { inventoryFailure, sqlState } = require('../dist/inventory/inventory.error');

const id = '00000000-0000-0000-0000-000000000001';
const audit = { key: 'test-request', actor: 'internal:test', reason: 'unit test' };
test('internal commands reject invalid quantities and DTOs before any database operation', () => {
  const inventory = new InventoryService({ options: { schema: 'public' }, createQueryRunner() { throw Error('database must not be touched'); } });
  for (const quantity of [-1, 0.1, NaN, Infinity, '1', null, 2147483648]) {
    assert.throws(() => inventory.initializeStock({ ...audit, variantId: id, locationId: id, quantity }), e => e.code === 'INVALID_INVENTORY_INPUT');
  }
  for (const delta of [0, -2147483648, 1.1, '2']) {
    assert.throws(() => inventory.adjustStock({ ...audit, variantId: id, locationId: id, delta }), e => e.getStatus() === 400);
  }
  for (const quantity of [0, -1, 0.5]) {
    assert.throws(() => inventory.reserveStock({ ...audit, orderId: id, expiresAt: '2030-01-01T00:00:00.000Z',
      items: [{ lineId: id, variantId: id, locationId: id, quantity }] }), e => e.getStatus() === 400);
  }
  assert.throws(() => inventory.createLocation({ ...audit, actor: '', code: 'MAIN', name: 'Main' }));
  assert.throws(() => inventory.createLocation({ ...audit, code: ' MAIN', name: 'Main' }));
  assert.throws(() => inventory.manageLocation({ ...audit, locationId: id, name: 'Main', archived: 'false' }));
  assert.throws(() => inventory.releaseReservations({ ...audit, orderId: id, reservationIds: [id,id] }));
  assert.throws(() => inventory.commitReservations({ ...audit, orderId: 'invalid', reservationIds: [id] }));
  assert.throws(() => inventory.initializeStock({ ...audit, variantId: id, locationId: id, quantity: 1, bypass: true }));
});

function fakeDatabase(fail = {}) {
  const runners = [], events = [];
  return { runners, events, createQueryRunner() {
    const index = runners.length;
    const runner = { manager: { index }, isTransactionActive: false,
      async connect() { events.push(`connect:${index}`); if (fail.connect) throw Error('connect'); },
      async startTransaction(isolation) { assert.equal(isolation,'READ COMMITTED'); this.isTransactionActive=true; events.push(`begin:${index}`); },
      async commitTransaction() { events.push(`commit:${index}`); if (fail.commit) throw fail.commit; this.isTransactionActive=false; },
      async rollbackTransaction() { events.push(`rollback:${index}`); this.isTransactionActive=false; if (fail.rollback) throw Error('rollback'); },
      async release() { events.push(`release:${index}`); this.released=true; if (fail.release) throw Error('release'); },
      async releasePostgresConnection(error) { this.discarded=error; this.released=true; events.push(`discard:${index}`); },
    };
    runners.push(runner); return runner;
  } };
}
test('retries only complete fresh transactions for 40001/40P01 and releases every runner', async () => {
  const db = fakeDatabase(), managers = [];
  const result = await inventoryTransaction(db, async manager => {
    managers.push(manager);
    if (manager.index === 0) throw { driverError: { code: '40001' } };
    if (manager.index === 1) throw { code: '40P01' };
    return 'committed';
  });
  assert.equal(result,'committed');
  assert.equal(new Set(managers).size,3);
  assert.deepEqual(db.events,['connect:0','begin:0','rollback:0','release:0','connect:1','begin:1','rollback:1','release:1','connect:2','begin:2','commit:2','release:2']);
});
test('retry exhaustion is bounded to four attempts; domain, unique and connection errors are not retried', async () => {
  for (const code of ['40001','40P01','23505','23514','08006']) {
    const db = fakeDatabase();
    await assert.rejects(inventoryTransaction(db, async () => { throw { code }; }), e => e.code===code);
    assert.equal(db.runners.length,['40001','40P01'].includes(code)?4:1);
    assert.ok(db.runners.every(runner => runner.released && !runner.isTransactionActive));
  }
});
test('serialization failures during commit retry the entire callback and release every attempt', async () => {
  const db=fakeDatabase({ commit: { code:'40001' } }), managers=[];
  await assert.rejects(inventoryTransaction(db,async manager=>{ managers.push(manager); return 'pending'; }),e=>e.code==='40001');
  assert.equal(new Set(managers).size,4);
  assert.ok(db.runners.every(r=>r.released && !r.isTransactionActive));
});
test('connection, rollback, commit ambiguity and release failures clean up without unsafe retries', async () => {
  for (const failure of [{ connect: true }, { rollback: true }, { release: true }, { commit: { code: '08006' } }]) {
    const db = fakeDatabase(failure);
    await assert.rejects(inventoryTransaction(db, async () => {
      if (failure.rollback || failure.release) throw { code: '40001' };
      return 'done';
    }));
    assert.equal(db.runners.length,1);
    assert.equal(db.runners[0].released,true);
    if (failure.rollback) assert.ok(db.runners[0].discarded instanceof Error);
  }
});
test('database errors have consistent sanitized domain responses', () => {
  assert.equal(sqlState({ driverError: { code: '40001' } }),'40001');
  for (const code of ['40001','40P01','23505','23503','23514','22003','08006']) {
    assert.throws(() => inventoryFailure({ code, message: 'secret credentials SQL' }), error =>
      error.code.startsWith('INVENTORY_') && !JSON.stringify(error.getResponse()).includes('secret'));
  }
});
