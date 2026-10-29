const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DataSource } = require('typeorm');
const { createDataSource, databaseOptions } = require('../dist/database/options');
const { verifyDatabaseIdentity, migrationStatus, quoteIdentifier } = require('../dist/database/safety');
const { commerceTables } = require('../dist/database/tables');
const { InventoryEngine: InventoryService } = require('../dist/inventory/inventory.engine');
const { inventoryTransaction } = require('../dist/inventory/transaction');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');

test('inventory correctness on verified isolated live PostgreSQL', { timeout: 60000 }, async t => {
  const admin = createDataSource(true);
  const options = databaseOptions();
  const runtime = new DataSource({ ...options, extra: { ...options.extra, max: 2, application_name: 'mnv_inventory_tests' } });
  let app;
  try {
    await admin.initialize();
    const identity = await verifyDatabaseIdentity(admin,true);
    assert.equal(identity.role,process.env.DB_MIGRATION_USER);
    assert.equal(identity.owner,process.env.DB_MIGRATION_USER);
    assert.equal((await migrationStatus(admin)).ready,true,'Requires both migrations applied');
    const q = table => `${quoteIdentifier(process.env.DB_SCHEMA)}.${quoteIdentifier(table)}`;
    for (const table of commerceTables) {
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q(table)}`))[0].n,0,
        'Requires an empty migrated disposable database; existing data will never be cleared');
    }
    await runtime.initialize();
    assert.equal((await runtime.query('SELECT current_user AS role'))[0].role,process.env.DB_USER);
    console.log(JSON.stringify({ inventoryIdentity: identity, runtimeRole: process.env.DB_USER, poolSize: 2 }));
    const inventory = new InventoryService(runtime);
    const audit = (overrides = {}) => ({ key: randomUUID(), actor: 'internal:inventory-test', reason: 'verified test operation', ...overrides });
    const future = () => new Date(Date.now()+3600000).toISOString();
    const reject = (promise, code) => assert.rejects(promise,e=>e.code===code);
    const snapshot = async () => {
      const result = {};
      for (const table of ['stock_levels','stock_reservations','stock_movements','idempotency_records']) {
        result[table] = await admin.query(`SELECT * FROM ${q(table)} ORDER BY id`);
      }
      return result;
    };
    async function catalog(quantity = 10) {
      const tag = randomUUID();
      const [product] = await runtime.query(`INSERT INTO ${q('products')} (name) VALUES ('Inventory test') RETURNING id`);
      const [variant] = await runtime.query(`INSERT INTO ${q('product_variants')} (product_id,sku,name,price,currency)
        VALUES ($1,$2,'Variant',100,'INR') RETURNING id`,[product.id,tag]);
      const location = await inventory.createLocation({ ...audit(), code:tag,name:'Warehouse' });
      const pair = { variantId: variant.id, locationId: location.id };
      if (quantity !== null) await inventory.initializeStock({ ...audit(), ...pair, quantity });
      return pair;
    }
    async function order(items) {
      const [order] = await runtime.query(`INSERT INTO ${q('orders')} (code,currency,total) VALUES ($1,'INR',100) RETURNING id`,[randomUUID()]);
      const lines = [];
      for (const item of items) {
        const [line] = await runtime.query(`INSERT INTO ${q('order_lines')}
          (order_id,variant_id,sku,product_name,variant_name,quantity,unit_price)
          VALUES ($1,$2,'Snapshot','Product','Variant',$3,100) RETURNING id`,[order.id,item.variantId,item.quantity]);
        lines.push({ ...item,lineId:line.id });
      }
      return { orderId:order.id, items:lines };
    }
    const reserve = (o, extra = {}) => inventory.reserveStock({ ...audit(),...o,expiresAt:future(),...extra });
    const finish = (o, rows, extra = {}) => ({ ...audit(),orderId:o.orderId,reservationIds:rows.map(r=>r.id),...extra });
    // Phase 2 fixtures supply authoritative evidence explicitly; production uses OrdersService.
    const paid = async o => {
      await runtime.query(`UPDATE ${q('orders')} SET state='placed' WHERE id=$1`,[o.orderId]);
      await runtime.query(`INSERT INTO ${q('payment_attempts')}(order_id,provider,provider_reference,idempotency_key,amount,currency,state)
        SELECT id,'inventory-test',$2,$2,total,currency,'succeeded' FROM ${q('orders')} WHERE id=$1`,[o.orderId,randomUUID()]);
      await runtime.query(`UPDATE ${q('orders')} SET state='paid' WHERE id=$1`,[o.orderId]);
    };
    const ledger = pair => runtime.query(`SELECT m.* FROM ${q('stock_movements')} m JOIN ${q('stock_levels')} s
      ON s.id=m.stock_level_id WHERE s.variant_id=$1 AND s.location_id=$2 ORDER BY m.created_at,m.id`,[pair.variantId,pair.locationId]);

    await t.test('initialization, signed adjustments, zero opening stock, location management and audit history',async () => {
      const pair = await catalog(null);
      const command = { ...audit(),...pair,quantity:10 };
      const first = await inventory.initializeStock(command);
      assert.deepEqual(await inventory.initializeStock(command),first);
      await reject(inventory.initializeStock({ ...audit(),...pair,quantity:99 }),'STOCK_ALREADY_INITIALIZED');
      await reject(inventory.initializeStock({ ...command,quantity:99 }),'IDEMPOTENCY_CONFLICT');
      const adjustment = { ...audit(),...pair,delta:5 };
      const results = await Promise.all([inventory.adjustStock(adjustment),inventory.adjustStock(adjustment)]);
      assert.deepEqual(results[0],results[1]);
      const stock = await inventory.adjustStock({ ...audit(),...pair,delta:-3 });
      assert.equal(stock.on_hand,12); assert.equal(stock.reserved,0); assert.equal(stock.available,12); assert.equal(stock.sold,'0');
      const rows = await ledger(pair);
      assert.deepEqual(rows.map(row=>[row.kind,row.on_hand_delta,row.reserved_delta]),[['initialization',10,0],['adjustment',5,0],['adjustment',-3,0]]);
      assert.ok(rows.every(row=>row.actor===command.actor && row.request_key && row.reason));
      const zero = await catalog(0);
      assert.equal((await ledger(zero)).length,0,'Zero initialization changes no quantity');
      await inventory.adjustStock({ ...audit(),...zero,delta:1 });
      assert.equal((await ledger(zero))[0].kind,'adjustment');
      const location = await inventory.manageLocation({ ...audit(),locationId:zero.locationId,name:'Renamed',archived:true });
      assert.ok(location.archived_at);
      await reject(inventory.adjustStock({ ...audit(),...zero,delta:1 }),'LOCATION_NOT_FOUND');
      assert.equal((await inventory.readStock(zero.variantId,zero.locationId)).on_hand,1);
      assert.ok((await inventory.listLocations()).some(row=>row.id===zero.locationId && row.name==='Renamed'));
      await inventory.manageLocation({ ...audit(),locationId:zero.locationId,name:'Renamed',archived:false });
    });

    await t.test('invalid quantities, references, insufficient stock and overflow preserve the original ledger',async () => {
      const pair = await catalog(4), before = await snapshot();
      for (const delta of [-5,2147483647]) await reject(inventory.adjustStock({ ...audit(),...pair,delta }),'INSUFFICIENT_STOCK');
      await reject(inventory.readStock(randomUUID(),pair.locationId),'STOCK_NOT_INITIALIZED');
      const o = await order([{ ...pair,quantity:5 }]);
      await reject(reserve(o),'INSUFFICIENT_STOCK');
      await assert.rejects(runtime.query(`UPDATE ${q('stock_levels')} SET on_hand=-1 WHERE variant_id=$1`,[pair.variantId]),e=>e.code==='23514');
      await assert.rejects(runtime.query(`UPDATE ${q('stock_levels')} SET reserved=1 WHERE variant_id=$1`,[pair.variantId]),e=>e.code==='42501');
      assert.deepEqual(await snapshot(),before);
    });

    await t.test('reserve/replay/release exactly once, including concurrent release attempts',async () => {
      const pair = await catalog(10), o = await order([{ ...pair,quantity:4 }]);
      const command = { ...audit(),...o,expiresAt:future() };
      const [a,b] = await Promise.all([inventory.reserveStock(command),inventory.reserveStock(command)]);
      assert.deepEqual(a,b);
      let stock = await inventory.readStock(pair.variantId,pair.locationId);
      assert.equal(stock.on_hand,10); assert.equal(stock.reserved,4); assert.equal(stock.available,6);
      await reject(inventory.adjustStock({ ...audit(),...pair,delta:-7 }),'INSUFFICIENT_STOCK');
      const release = finish(o,a);
      const released = await inventory.releaseReservations(release);
      assert.equal(released[0].id,a[0].id); assert.equal(released[0].state,'released');
      assert.deepEqual(await inventory.releaseReservations(release),released);
      const before = await snapshot();
      await reject(inventory.releaseReservations(finish(o,a)),'RESERVATION_FINALIZED');
      await paid(o);
      await reject(inventory.commitReservations(finish(o,a)),'RESERVATION_FINALIZED');
      assert.deepEqual(await snapshot(),before);
      stock = await inventory.readStock(pair.variantId,pair.locationId);
      assert.equal(stock.on_hand,10); assert.equal(stock.reserved,0); assert.equal(stock.available,10);
      assert.deepEqual((await ledger(pair)).map(row=>row.kind),['initialization','reservation','release']);

      const other = await order([{ ...pair,quantity:2 }]), rows = await reserve(other);
      const result = await Promise.allSettled([inventory.releaseReservations(finish(other,rows)),inventory.releaseReservations(finish(other,rows))]);
      assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(result.find(r=>r.status==='rejected').reason.code,'RESERVATION_FINALIZED');
    });

    await t.test('paid-only consumption once, release-versus-consume race and sold quantity semantics',async () => {
      const pair = await catalog(8), o = await order([{ ...pair,quantity:3 }]), rows = await reserve(o);
      await reject(inventory.commitReservations(finish(o,rows)),'ORDER_STATE');
      await paid(o);
      const command = finish(o,rows);
      const sold = await inventory.commitReservations(command);
      assert.equal(sold[0].id,rows[0].id); assert.equal(sold[0].state,'consumed');
      assert.deepEqual(await inventory.commitReservations(command),sold);
      const before = await snapshot();
      await reject(inventory.commitReservations(finish(o,rows)),'RESERVATION_FINALIZED');
      await reject(inventory.releaseReservations(finish(o,rows)),'RESERVATION_FINALIZED');
      assert.deepEqual(await snapshot(),before);
      const stock = await inventory.readStock(pair.variantId,pair.locationId);
      assert.equal(stock.on_hand,5); assert.equal(stock.reserved,0); assert.equal(stock.available,5); assert.equal(stock.sold,'3');
      const sale = (await ledger(pair)).find(row=>row.kind==='sale');
      assert.deepEqual([sale.quantity_delta,sale.on_hand_delta,sale.reserved_delta],[-3,-3,-3]);
      const racing = await order([{ ...pair,quantity:2 }]), active = await reserve(racing);
      await paid(racing);
      const results = await Promise.allSettled([inventory.commitReservations(finish(racing,active)),inventory.releaseReservations(finish(racing,active))]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'RESERVATION_FINALIZED');
      const final = await inventory.readStock(pair.variantId,pair.locationId);
      assert.equal(final.reserved,0); assert.equal(final.on_hand,results[0].status==='fulfilled'?3:5);
    });

    await t.test('order/variant matching, line limits, terminal immutability and explicit expiry release',async () => {
      const pair = await catalog(10), another = await catalog(10);
      const o = await order([{ ...pair,quantity:2 }]), foreign = await order([{ ...pair,quantity:2 }]);
      const before = await snapshot();
      await reject(reserve({ ...o,items:foreign.items }),'ORDER_LINE_MISMATCH');
      await reject(reserve({ ...o,items:[{ ...o.items[0],...another }] }),'VARIANT_MISMATCH');
      await reject(reserve({ ...o,items:[{ ...o.items[0],quantity:3 }] }),'LINE_QUANTITY_EXCEEDED');
      await reject(reserve(o,{ expiresAt:'2020-01-01T00:00:00.000Z' }),'INVENTORY_INVARIANT');
      assert.deepEqual(await snapshot(),before);
      const rows = await reserve(o);
      await reject(inventory.releaseReservations(finish(foreign,rows)),'RESERVATION_MISMATCH');
      await assert.rejects(runtime.query(`UPDATE ${q('stock_reservations')} SET quantity=1 WHERE id=$1`,[rows[0].id]),e=>e.code==='23514');
      await assert.rejects(runtime.query(`UPDATE ${q('order_lines')} SET variant_id=$2 WHERE id=$1`,[o.items[0].lineId,another.variantId]),e=>e.code==='23514');
      await assert.rejects(runtime.query(`DELETE FROM ${q('stock_reservations')} WHERE id=$1`,[rows[0].id]),e=>e.code==='42501');
      await inventory.releaseReservations(finish(o,rows));
      await assert.rejects(admin.query(`UPDATE ${q('stock_reservations')} SET state='active' WHERE id=$1`,[rows[0].id]),e=>e.code==='23514');

      const expiring = await order([{ ...pair,quantity:1 }]);
      const exp = await reserve(expiring,{ expiresAt:new Date(Date.now()+1000).toISOString() });
      await paid(expiring);
      await delay(1100);
      assert.equal((await inventory.readStock(pair.variantId,pair.locationId)).reserved,1,'Expired timestamp alone never frees held stock');
      await reject(inventory.commitReservations(finish(expiring,exp)),'INVENTORY_INVARIANT');
      await inventory.releaseReservations(finish(expiring,exp));
    });

    // Inject server errors at the ledger boundary, after row/counter changes. Never disable triggers.
    await admin.query(`CREATE FUNCTION ${q('inventory_test_movement_failure')}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_key LIKE 'fail-%' THEN RAISE EXCEPTION 'test ledger insertion failure' USING ERRCODE='23514'; END IF;
        IF NEW.request_key LIKE 'retry-serialization-%' THEN RAISE EXCEPTION 'test retry exhaustion' USING ERRCODE='40001'; END IF;
        IF NEW.request_key LIKE 'retry-deadlock-%' THEN RAISE EXCEPTION 'test retry exhaustion' USING ERRCODE='40P01'; END IF;
        RETURN NEW;
      END $$`);
    await admin.query(`CREATE TRIGGER inventory_test_movement_failure BEFORE INSERT ON ${q('stock_movements')}
      FOR EACH ROW EXECUTE FUNCTION ${q('inventory_test_movement_failure')}()`);
    try {
      await t.test('movement insertion failure rolls back initialization, adjustment, reserve, release and sale atomically',async () => {
        const pair = await catalog(10), empty = await catalog(null), o = await order([{ ...pair,quantity:3 }]);
        const failure = () => ({ key:`fail-${randomUUID()}` });
        for (const action of [
          () => inventory.initializeStock({ ...audit(failure()),...empty,quantity:5 }),
          () => inventory.adjustStock({ ...audit(failure()),...pair,delta:1 }),
          () => reserve(o,failure()),
        ]) {
          const before = await snapshot(); await reject(action(),'INVENTORY_INVARIANT'); assert.deepEqual(await snapshot(),before);
        }
        const rows = await reserve(o);
        let before = await snapshot();
        await reject(inventory.releaseReservations(finish(o,rows,failure())),'INVENTORY_INVARIANT');
        assert.deepEqual(await snapshot(),before);
        await paid(o); before = await snapshot();
        await reject(inventory.commitReservations(finish(o,rows,failure())),'INVENTORY_INVARIANT');
        assert.deepEqual(await snapshot(),before);
        await inventory.commitReservations(finish(o,rows));
        assert.equal((await inventory.readStock(pair.variantId,pair.locationId)).on_hand,7);
      });

      await t.test('SQLSTATE retry exhaustion rolls back all four transactions and releases pool connections',async () => {
        const pair = await catalog(10), original = runtime.createQueryRunner.bind(runtime);
        const runners = [];
        runtime.createQueryRunner = (...args) => { const runner=original(...args); runners.push(runner); return runner; };
        try {
          for (const key of ['retry-serialization-','retry-deadlock-']) {
            const before = await snapshot(), start = runners.length;
            await reject(inventory.adjustStock({ ...audit({ key:`${key}${randomUUID()}` }),...pair,delta:1 }),'INVENTORY_BUSY');
            assert.equal(runners.length-start,4);
            assert.ok(runners.slice(start).every(r=>r.isReleased && !r.isTransactionActive));
            assert.deepEqual(await snapshot(),before);
            await Promise.all(Array.from({ length:8 },()=>runtime.query('SELECT 1')));
          }
        } finally { runtime.createQueryRunner=original; }
      });
    } finally {
      await admin.query(`DROP TRIGGER inventory_test_movement_failure ON ${q('stock_movements')}`);
      await admin.query(`DROP FUNCTION ${q('inventory_test_movement_failure')}()`);
    }

    async function waitForBlocked(count) {
      for (let i=0;i<150;i++) {
        const [{ n }] = await admin.query(`SELECT count(DISTINCT a.pid)::int AS n FROM pg_stat_activity a
          JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database()
          AND a.application_name='mnv_inventory_tests' AND NOT l.granted`);
        if (n>=count) return n;
        await delay(20);
      }
      assert.fail(`Expected ${count} real PostgreSQL sessions waiting on row locks`);
    }
    async function compete(lockSql, params, operations) {
      const blocker = admin.createQueryRunner(); let pending;
      try {
        await blocker.connect(); await blocker.startTransaction(); await blocker.query(lockSql,params);
        pending = Promise.allSettled(operations.map(operation=>operation()));
        await waitForBlocked(2);
        await blocker.commitTransaction();
        return await pending;
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        await blocker.release();
        if (pending) await pending;
      }
    }
    await t.test('two checkout sessions genuinely overlap and cannot oversell insufficient stock',async () => {
      const pair = await catalog(5), a = await order([{ ...pair,quantity:4 }]), b = await order([{ ...pair,quantity:4 }]);
      const result = await compete(`SELECT id FROM ${q('stock_levels')} WHERE variant_id=$1 FOR UPDATE`,[pair.variantId],[()=>reserve(a),()=>reserve(b)]);
      assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(result.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_STOCK');
      const stock = await inventory.readStock(pair.variantId,pair.locationId);
      assert.equal(stock.on_hand,5); assert.equal(stock.reserved,4); assert.equal(stock.available,1);
      assert.equal((await ledger(pair)).filter(row=>row.kind==='reservation').length,1);
      console.log(JSON.stringify({ concurrentCheckout:{ blockedSessions:2,requested:8,onHand:5,reserved:4,available:1 } }));
    });
    await t.test('last-unit contention reserves once and failed key can succeed after release',async () => {
      const pair=await catalog(1), a=await order([{...pair,quantity:1}]), b=await order([{...pair,quantity:1}]);
      const commands=[a,b].map(o=>({...audit(),...o,expiresAt:future()}));
      const results=await compete(`SELECT id FROM ${q('stock_levels')} WHERE variant_id=$1 FOR UPDATE`,[pair.variantId],
        commands.map(c=>()=>inventory.reserveStock(c)));
      const winner=results.findIndex(r=>r.status==='fulfilled'),loser=1-winner;
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results[loser].reason.code,'INSUFFICIENT_STOCK');
      assert.equal((await inventory.readStock(pair.variantId,pair.locationId)).available,0);
      assert.equal((await admin.query(`SELECT id FROM ${q('idempotency_records')} WHERE scope='inventory' AND key=$1`,[commands[loser].key])).length,0);
      await inventory.releaseReservations(finish([a,b][winner],results[winner].value));
      const recovered=await inventory.reserveStock(commands[loser]);
      assert.deepEqual(await inventory.reserveStock(commands[loser]),recovered);
      const stock=await inventory.readStock(pair.variantId,pair.locationId);
      assert.equal(stock.on_hand,1);assert.equal(stock.reserved,1);assert.equal(stock.available,0);
      assert.equal((await ledger(pair)).filter(r=>r.kind==='reservation').length,2);
    });
    await t.test('concurrent initialization creates one balance and one movement for the same pair',async () => {
      const pair = await catalog(null);
      const result = await compete(`SELECT id FROM ${q('product_variants')} WHERE id=$1 FOR UPDATE`,[pair.variantId],
        [()=>inventory.initializeStock({ ...audit(),...pair,quantity:7 }),()=>inventory.initializeStock({ ...audit(),...pair,quantity:7 })]);
      assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(result.find(r=>r.status==='rejected').reason.code,'STOCK_ALREADY_INITIALIZED');
      assert.equal((await inventory.readStock(pair.variantId,pair.locationId)).on_hand,7);
      assert.equal((await ledger(pair)).length,1);
    });
    await t.test('PostgreSQL itself prevents overselling and mismatched reservations when service prechecks are bypassed',async () => {
      const pair=await catalog(5), other=await catalog(5);
      const a=await order([{ ...pair,quantity:4 }]), b=await order([{ ...pair,quantity:4 }]);
      const stock=await inventory.readStock(pair.variantId,pair.locationId);
      const insert = o => runtime.query(`INSERT INTO ${q('stock_reservations')}
        (order_line_id,stock_level_id,quantity,expires_at) VALUES ($1,$2,4,now()+interval '1 hour') RETURNING id`,
      [o.items[0].lineId,stock.id]);
      const results=await compete(`SELECT id FROM ${q('stock_levels')} WHERE id=$1 FOR UPDATE`,[stock.id],[()=>insert(a),()=>insert(b)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'23514');
      assert.equal((await inventory.readStock(pair.variantId,pair.locationId)).available,1);
      const foreign=await order([{ ...other,quantity:1 }]), before=await snapshot();
      for (const [lineId,quantity] of [[foreign.items[0].lineId,1],[a.items[0].lineId,-1],[a.items[0].lineId,0]]) {
        await assert.rejects(runtime.query(`INSERT INTO ${q('stock_reservations')}
          (order_line_id,stock_level_id,quantity,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,[lineId,stock.id,quantity]),e=>e.code==='23514');
      }
      await assert.rejects(admin.query(`UPDATE ${q('stock_levels')} SET reserved=0 WHERE id=$1`,[stock.id]),e=>e.code==='23514');
      await assert.rejects(runtime.query(`UPDATE ${q('stock_levels')} SET on_hand=3 WHERE id=$1`,[stock.id]),e=>e.code==='23514');
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('reverse-input multi-variant checkouts acquire deterministic stock locks and commit atomically',async () => {
      const pairs = [await catalog(2),await catalog(2)].sort((a,b)=>a.variantId.localeCompare(b.variantId));
      const a = await order(pairs.map(pair=>({ ...pair,quantity:1 })));
      const b = await order([...pairs].reverse().map(pair=>({ ...pair,quantity:1 })));
      const firstCommand={ ...audit(),...a,expiresAt:future() };
      let firstResult;
      const original = runtime.createQueryRunner.bind(runtime), lockSequences = [];
      runtime.createQueryRunner = (...args) => {
        const runner=original(...args), query=runner.query.bind(runner), locks=[];
        lockSequences.push(locks);
        runner.query = (sql,params,...rest) => {
          if (sql.includes('FOR UPDATE OF s')) locks.push(`${params[0]}:${params[1]}`);
          return query(sql,params,...rest);
        };
        return runner;
      };
      try {
        const results = await compete(`SELECT id FROM ${q('stock_levels')} WHERE variant_id=$1 FOR UPDATE`,[pairs[0].variantId],[()=>inventory.reserveStock(firstCommand),()=>reserve(b)]);
        assert.ok(results.every(r=>r.status==='fulfilled'));
        assert.equal(lockSequences.length,2);
        const expected = pairs.map(p=>`${p.variantId}:${p.locationId}`);
        assert.deepEqual(lockSequences,[expected,expected]);
        firstResult=results[0].value;
        console.log(JSON.stringify({ deterministicLockSequences:lockSequences }));
      } finally { runtime.createQueryRunner=original; }
      assert.deepEqual(await inventory.reserveStock({ ...firstCommand,items:[...firstCommand.items].reverse() }),firstResult,
        'Canonical allocation order makes a reversed-input retry the same request');
      for (const pair of pairs) assert.equal((await inventory.readStock(pair.variantId,pair.locationId)).available,0);
      const c = await order(pairs.map(pair=>({ ...pair,quantity:1 }))), before=await snapshot();
      await reject(reserve(c),'INSUFFICIENT_STOCK'); assert.deepEqual(await snapshot(),before);
      // Fail on the second item after the first reservation has already been inserted.
      const sorted = [await catalog(0),await catalog(0)].sort((a,b)=>a.variantId.localeCompare(b.variantId));
      await inventory.adjustStock({ ...audit(),...sorted[0],delta:1 });
      const multi=await order(sorted.map(pair=>({ ...pair,quantity:1 }))), originalStock=await snapshot();
      await reject(reserve(multi),'INSUFFICIENT_STOCK'); assert.deepEqual(await snapshot(),originalStock);
    });

    await t.test('a real serialization conflict restarts the entire transaction on a fresh manager',async () => {
      const location = await inventory.createLocation({ ...audit(),code:randomUUID(),name:'Before' });
      let readResolve, continueResolve;
      const read = new Promise(resolve=>{ readResolve=resolve; }), resume = new Promise(resolve=>{ continueResolve=resolve; });
      const attempts=[];
      const pending = inventoryTransaction(runtime,async manager=>{
        await manager.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const [row] = await manager.query(`SELECT name,txid_current()::text AS tx FROM ${q('stock_locations')} WHERE id=$1`,[location.id]);
        attempts.push({ manager,tx:row.tx,name:row.name });
        if (attempts.length===1) { readResolve(); await resume; }
        await manager.query(`UPDATE ${q('stock_locations')} SET name='Retried' WHERE id=$1`,[location.id]);
      });
      await read;
      try { await admin.query(`UPDATE ${q('stock_locations')} SET name='Concurrent' WHERE id=$1`,[location.id]); }
      finally { continueResolve(); }
      await pending;
      assert.equal(attempts.length,2); assert.notEqual(attempts[0].manager,attempts[1].manager);
      assert.notEqual(attempts[0].tx,attempts[1].tx); assert.equal(attempts[1].name,'Concurrent');
    });
    await t.test('a real deadlock retries the complete transaction without partial stock or ledger writes',async () => {
      const pairs=[await catalog(5),await catalog(5)];
      const rows=await Promise.all(pairs.map(p=>inventory.readStock(p.variantId,p.locationId)));
      const attempts=[[],[]];let reached=0,release;
      const gate=new Promise(resolve=>release=resolve);
      const run=side=>inventoryTransaction(runtime,async manager=>{
        const [{tx}]=await manager.query('SELECT txid_current()::text tx');
        attempts[side].push({manager,tx});
        // Intentionally violate normal ordering only in this test to force PostgreSQL's detector.
        await manager.query(`UPDATE ${q('stock_levels')} SET on_hand=on_hand+1 WHERE id=$1`,[rows[side].id]);
        if(attempts[side].length===1){if(++reached===2)release();await gate;}
        await manager.query(`UPDATE ${q('stock_levels')} SET on_hand=on_hand+1 WHERE id=$1`,[rows[1-side].id]);
      });
      await Promise.all([run(0),run(1)]);
      assert.deepEqual(attempts.map(a=>a.length).sort(),[1,2]);
      const retried=attempts.find(a=>a.length===2);
      assert.notEqual(retried[0].tx,retried[1].tx);assert.notEqual(retried[0].manager,retried[1].manager);
      for(const pair of pairs){
        const stock=await inventory.readStock(pair.variantId,pair.locationId);
        assert.equal(stock.on_hand,7);assert.equal(stock.reserved,0);
        assert.deepEqual((await ledger(pair)).filter(r=>r.kind==='adjustment').map(r=>r.on_hand_delta),[1,1]);
      }
    });
    await t.test('rollback failure evicts the actual PostgreSQL connection instead of reusing its open transaction',async () => {
      const pair=await catalog(5), before=await snapshot(), original=runtime.createQueryRunner.bind(runtime);
      let captured, pid;
      runtime.createQueryRunner=(...args)=>{
        const runner=original(...args); captured=runner;
        runner.rollbackTransaction=async()=>{ throw Error('injected rollback transport failure'); };
        return runner;
      };
      try {
        await assert.rejects(inventoryTransaction(runtime,async manager=>{
          [{ pid }]=await manager.query('SELECT pg_backend_pid() AS pid');
          await manager.query(`UPDATE ${q('stock_levels')} SET on_hand=on_hand+1 WHERE variant_id=$1`,[pair.variantId]);
          throw { code:'40001' };
        }),/injected rollback transport failure/);
        assert.equal(captured.isReleased,true);
      } finally { runtime.createQueryRunner=original; }
      for (let i=0;i<100;i++) {
        const [{ connected }]=await admin.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS connected',[pid]);
        if (!connected) break;
        if (i===99) assert.fail('Failed-rollback backend must be disconnected');
        await delay(10);
      }
      assert.deepEqual(await snapshot(),before);
      await Promise.all(Array.from({ length:6 },()=>runtime.query('SELECT 1')));
    });
    await t.test('history, counters and routes remain protected after all successes and failures',async () => {
      const before=await snapshot();
      for (const statement of ['UPDATE','DELETE','TRUNCATE']) {
        const sql=statement==='UPDATE'?`UPDATE ${q('stock_movements')} SET reason='tamper'`:
          statement==='DELETE'?`DELETE FROM ${q('stock_movements')}`:`TRUNCATE ${q('stock_movements')}`;
        await assert.rejects(admin.query(sql),e=>e.code==='23514');
        await assert.rejects(runtime.query(sql),e=>e.code==='42501');
      }
      await assert.rejects(runtime.query(`INSERT INTO ${q('stock_movements')} (stock_level_id,quantity_delta,reason)
        SELECT id,1,'fake' FROM ${q('stock_levels')} LIMIT 1`),e=>e.code==='42501');
      const mismatches=await admin.query(`SELECT s.id FROM ${q('stock_levels')} s WHERE s.reserved<0 OR s.on_hand<s.reserved
        OR s.reserved<>(SELECT coalesce(sum(r.quantity),0) FROM ${q('stock_reservations')} r WHERE r.stock_level_id=s.id AND r.state='active')`);
      assert.deepEqual(mismatches,[]);
      assert.deepEqual(await snapshot(),before);
      app=await NestFactory.create(AppModule,{ logger:false }); await app.listen(0,'127.0.0.1');
      const base=await app.getUrl();
      assert.equal((await fetch(`${base}/health/ready`)).status,200);
      for (const route of ['/inventory','/inventory/adjust','/inventory/reserve','/stock-locations']) {
        assert.equal((await fetch(`${base}${route}`,{ method:'POST',headers:{ 'content-type':'application/json' },body:'{}' })).status,404);
      }
    });
  } finally {
    if (app) { const db=app.get(DataSource); await app.close(); if(db.isInitialized) await db.destroy(); }
    if(runtime.isInitialized) await runtime.destroy();
    if(admin.isInitialized) await admin.destroy();
  }
});
