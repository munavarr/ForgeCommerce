const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createDataSource } = require('../dist/database/options');
const { verifyDatabaseIdentity, migrationStatus, quoteIdentifier } = require('../dist/database/safety');
const { commerceTables } = require('../dist/database/tables');
const { ProductVariants, Orders, OrderLines, PaymentAttempts } = require('../dist/database/entities/commerce.entity');
const { stringifyCommerce } = require('../dist/common/money');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { migrationNames } = require('../dist/database/migration-names');
const { InitialCommerce1793145600000 } = require('../dist/database/migrations/1793145600000-initial-commerce');

test('initial PostgreSQL migration on an explicitly identified empty disposable database', async t => {
  const admin = createDataSource(true);
  const runtime = createDataSource();
  let app;
  await admin.initialize();
  try {
    const identity = await verifyDatabaseIdentity(admin, true);
    console.log(JSON.stringify({ verifiedIdentity: identity }));
    const schema = quoteIdentifier(process.env.DB_SCHEMA);
    const q = name => `${schema}.${quoteIdentifier(name)}`;
    const [{ count }] = await admin.query(`SELECT count(*)::int FROM information_schema.tables WHERE table_schema = $1`, [process.env.DB_SCHEMA]);
    assert.equal(count, 0, 'Requires a NEW empty disposable database; will not erase existing data');
    await runtime.initialize();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const requestReady = () => fetch(`${base}/health/ready`);
    const cli = (command, extra = {}, success = true) => {
      const result = spawnSync(process.execPath, ['dist/database/migrate.js', command], {
        env: { ...process.env, MNV_ALLOW_DESTRUCTIVE_ROLLBACK: '', ...extra }, encoding: 'utf8',
      });
      assert.equal(result.status, success ? 0 : 1, 'Migration command result must match expectation');
      assert.doesNotMatch((result.stdout ?? '') + (result.stderr ?? ''), new RegExp(process.env.DB_PASSWORD));
      assert.doesNotMatch((result.stdout ?? '') + (result.stderr ?? ''), new RegExp(process.env.DB_MIGRATION_PASSWORD));
      if (!success) return []; // TypeORM may print its expected migration-failure diagnostic.
      return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    };
    const snapshot = async () => JSON.stringify(await admin.query(`
 SELECT 'constraint' AS kind, conname AS name, pg_get_constraintdef(c.oid) AS definition
 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1
 UNION ALL SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = $1
 UNION ALL SELECT 'column', table_name || '.' || column_name, data_type || ':' || is_nullable || ':' || coalesce(column_default, '')
 FROM information_schema.columns WHERE table_schema = $1 ORDER BY kind, name`, [process.env.DB_SCHEMA]));

    await t.test('read-only status and readiness before migration; fail closed for missing/incorrect identity', async () => {
      assert.equal((await requestReady()).status, 503);
      assert.deepEqual(await migrationStatus(runtime), { ready: false, applied: [], pending: migrationNames });
      cli('show');
      assert.equal((await admin.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1`, [process.env.DB_SCHEMA]))[0].count, 0);
      cli('run', { DB_MIGRATION_PASSWORD: '' }, false);
      cli('run', { DB_NAME: 'vendure_unidentified' }, false);
      await admin.query(`COMMENT ON DATABASE ${quoteIdentifier(identity.database)} IS NULL`);
      try { cli('run', {}, false); } finally {
        await admin.query(`COMMENT ON DATABASE ${quoteIdentifier(identity.database)} IS 'mnv-commerce:disposable-test'`);
      }
      await admin.query(`CREATE TABLE ${q('unidentified_vendure_table')} (id integer)`);
      try { cli('run', {}, false); } finally { await admin.query(`DROP TABLE ${q('unidentified_vendure_table')}`); }
    });

    await t.test('apply explicit migration, inspect schema, repeat without changes, and report ready', async () => {
      // Exercise a real upgrade from an already-applied Phase 1 schema, including retained history.
      const legacy = new (require('typeorm').DataSource)({ ...admin.options, migrations: [InitialCommerce1793145600000] });
      await legacy.initialize();
      try { await legacy.runMigrations(); } finally { await legacy.destroy(); }
      const legacyToken=require('node:crypto').randomBytes(32).toString('base64url');
      const [legacyUser]=await admin.query(`INSERT INTO ${q('users')}(email,password_hash) VALUES ('upgrade@mnv.invalid','legacy-placeholder') RETURNING *`);
      const [legacySession]=await admin.query(`INSERT INTO ${q('sessions')}(user_id,token_hash,expires_at)
        VALUES ($1,$2,clock_timestamp()+interval '1 day') RETURNING *`,[legacyUser.id,require('node:crypto').createHash('sha256').update(legacyToken).digest('hex')]);
      const [p] = await admin.query(`INSERT INTO ${q('products')} (name) VALUES ('Upgrade fixture') RETURNING id`);
      const [v] = await admin.query(`INSERT INTO ${q('product_variants')} (product_id,sku,name,price,currency)
        VALUES ($1,'UPGRADE','Upgrade',1,'INR') RETURNING id`,[p.id]);
      const [loc] = await admin.query(`INSERT INTO ${q('stock_locations')} (code,name) VALUES ('UPGRADE','Upgrade') RETURNING id`);
      const [s] = await admin.query(`INSERT INTO ${q('stock_levels')} (variant_id,location_id,on_hand) VALUES ($1,$2,1) RETURNING id`,[v.id,loc.id]);
      const [o] = await admin.query(`INSERT INTO ${q('orders')} (code,currency,total) VALUES ('UPGRADE','INR',2) RETURNING id`);
      const [l] = await admin.query(`INSERT INTO ${q('order_lines')} (order_id,variant_id,sku,product_name,variant_name,quantity,unit_price)
        VALUES ($1,$2,'UPGRADE','Upgrade','Upgrade',2,1) RETURNING id`,[o.id,v.id]);
      await admin.query(`INSERT INTO ${q('stock_reservations')} (order_line_id,stock_level_id,quantity,expires_at)
        VALUES ($1,$2,2,now()+interval '1 hour')`,[l.id,s.id]);
      const [history] = await admin.query(`INSERT INTO ${q('stock_movements')} (stock_level_id,quantity_delta,reason)
        VALUES ($1,1,'original opening stock') RETURNING *`,[s.id]);
      const legacyPayments=await admin.query(`INSERT INTO ${q('payment_attempts')}
        (order_id,provider,provider_reference,idempotency_key,amount,currency,state) VALUES
        ($1,'legacy','success','upgrade-success',2,'INR','succeeded'),
        ($1,'legacy','failure','upgrade-failure',2,'INR','failed'),
        ($1,'legacy',NULL,'upgrade-pending',2,'INR','pending') RETURNING *`,[o.id]);
      // Oversubscribed legacy data must abort DDL and bookkeeping, preserving the original schema.
      cli('run',{},false);
      assert.deepEqual((await admin.query(`SELECT name FROM ${q('mnv_migrations')} ORDER BY id`)).map(r=>r.name),[migrationNames[0]]);
      assert.equal((await admin.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='stock_levels' AND column_name='reserved'`,[process.env.DB_SCHEMA])).length,0);
      assert.deepEqual((await admin.query(`SELECT * FROM ${q('stock_movements')} WHERE id=$1`,[history.id]))[0],history);
      // Explicit fixture reconciliation under the old schema, never an automatic migration repair.
      await admin.query(`UPDATE ${q('stock_levels')} SET on_hand=2 WHERE id=$1`,[s.id]);
      assert.equal(cli('run').at(-1).ready, true);
      for(const payment of legacyPayments){
        const [upgraded]=await admin.query(`SELECT * FROM ${q('payment_attempts')} WHERE id=$1`,[payment.id]);
        for(const field of Object.keys(payment))assert.deepEqual(upgraded[field],payment[field]);
        assert.equal(upgraded.request_hash,null,'Legacy attempts are retained for explicit review, not silently adopted');
      }
      const [upgradedUser]=await admin.query(`SELECT * FROM ${q('users')} WHERE id=$1`,[legacyUser.id]);
      for(const field of Object.keys(legacyUser)) assert.deepEqual(upgradedUser[field],legacyUser[field]);
      assert.equal(upgradedUser.role,'customer');assert.equal(upgradedUser.email_verified_at,null);
      const [upgradedSession]=await admin.query(`SELECT * FROM ${q('sessions')} WHERE id=$1`,[legacySession.id]);
      for(const field of Object.keys(legacySession).filter(k=>k!=='revoked_at')) assert.deepEqual(upgradedSession[field],legacySession[field]);
      assert.ok(upgradedSession.revoked_at instanceof Date,'Pre-authentication sessions are revoked without deleting history');
      await assert.rejects(app.get(require('../dist/auth/auth.service').AuthService).authenticate('Bearer '+legacyToken),e=>e.getStatus()===401);
      assert.equal((await admin.query(`SELECT reserved FROM ${q('stock_levels')} WHERE id=$1`,[s.id]))[0].reserved,2);
      const [retained] = await admin.query(`SELECT * FROM ${q('stock_movements')} WHERE id=$1`,[history.id]);
      for (const key of Object.keys(history)) assert.deepEqual(retained[key],history[key]);
      assert.equal(retained.kind,'legacy');
      const before = await snapshot();
      assert.equal(cli('run').at(-1).ready, true);
      assert.equal(await snapshot(), before);
      assert.equal(cli('show').at(-1).pending.length, 0);
      assert.equal((await requestReady()).status, 200);
      await admin.query(`ALTER TABLE ${q('idempotency_records')} RENAME TO temporarily_missing`);
      try { assert.equal((await requestReady()).status, 503); } finally {
        await admin.query(`ALTER TABLE ${q('temporarily_missing')} RENAME TO idempotency_records`);
      }
      const tables = await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [process.env.DB_SCHEMA]);
      assert.deepEqual(tables.map(row => row.table_name), [...commerceTables, 'mnv_migrations'].sort());
      const money = await admin.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
 WHERE table_schema = $1 AND column_name IN ('price','total','unit_price','amount') ORDER BY table_name`, [process.env.DB_SCHEMA]);
      assert.equal(money.length, 4);
      assert.ok(money.every(column => column.data_type === 'bigint'));
      const fks = await admin.query(`SELECT c.conname, c.confdeltype FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
 WHERE c.contype='f' AND n.nspname=$1`, [process.env.DB_SCHEMA]);
      assert.equal(fks.length, 14);
      assert.ok(fks.every(fk => fk.confdeltype === 'r'));
      const missingIndexes = await admin.query(`SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
 WHERE c.contype='f' AND n.nspname=$1 AND NOT EXISTS
 (SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indkey[0]=c.conkey[1])`, [process.env.DB_SCHEMA]);
      assert.deepEqual(missingIndexes, []);
      const [{ checks, uniques, indexes }] = await admin.query(`SELECT
 (SELECT count(*)::int FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='c') AS checks,
 (SELECT count(*)::int FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='u') AS uniques,
 (SELECT count(*)::int FROM pg_indexes WHERE schemaname=$1) AS indexes`, [process.env.DB_SCHEMA]);
      assert.ok(checks >= 30 && uniques >= 8 && indexes >= 30);
      console.log(JSON.stringify({ schemaInspection: { tables: tables.length, foreignKeys: fks.length, checks, uniques, indexes, money } }));
    });

    let product, variant, location, stock, order, line;
    await t.test('runtime CRUD, exact bigint round trips, snapshots and all domain records', async () => {
      [product] = await runtime.query(`INSERT INTO ${q('products')} (name) VALUES ('Shirt') RETURNING *`);
      variant = await runtime.getRepository(ProductVariants).save(runtime.getRepository(ProductVariants).create({
        product_id: product.id, sku: 'MNV-001', name: 'Medium', price: 9007199254740993n, currency: 'INR',
      }));
      const loaded = await runtime.getRepository(ProductVariants).findOneByOrFail({ id: variant.id });
      assert.equal(loaded.price, 9007199254740993n);
      assert.equal(JSON.parse(stringifyCommerce(loaded)).price, '9007199254740993');
      const [user] = await runtime.query(`INSERT INTO ${q('users')} (email,password_hash) VALUES ('test@mnv.invalid','test-only-hash') RETURNING id`);
      const [session] = await runtime.query(`INSERT INTO ${q('sessions')} (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour') RETURNING id`, [user.id, 'a'.repeat(64)]);
      await runtime.query(`UPDATE ${q('sessions')} SET revoked_at=now() WHERE id=$1`, [session.id]);
      [location] = await runtime.query(`INSERT INTO ${q('stock_locations')} (code,name) VALUES ('MAIN','Main') RETURNING id`);
      [stock] = await runtime.query(`INSERT INTO ${q('stock_levels')} (variant_id,location_id,on_hand) VALUES ($1,$2,10) RETURNING id`, [variant.id,location.id]);
      order = await runtime.getRepository(Orders).save({ code: 'ORDER-001', user_id: user.id, subtotal:0n, tax:0n, shipping:0n, total: 9007199254740993n, currency: 'INR' });
      line = await runtime.getRepository(OrderLines).save({ order_id: order.id, variant_id: variant.id,
        sku: 'MNV-001', product_name: 'Shirt', variant_name: 'Medium', quantity: 1, unit_price: 9007199254740993n });
      await runtime.query(`INSERT INTO ${q('stock_reservations')} (order_line_id,stock_level_id,quantity,expires_at) VALUES ($1,$2,1,now()+interval '1 hour')`, [line.id,stock.id]);
      // Legacy ledger insertion is now owner-only; new inventory movements are trigger-generated.
      await admin.query(`INSERT INTO ${q('stock_movements')} (stock_level_id,order_line_id,quantity_delta,reason) VALUES ($1,$2,-1,'legacy fixture')`, [stock.id,line.id]);
      await runtime.query(`UPDATE ${q('orders')} SET state='placed' WHERE id=$1`, [order.id]);
      const payment = await runtime.getRepository(PaymentAttempts).save({ order_id: order.id, provider: 'test', idempotency_key: 'pay-001', amount: 9007199254740993n, currency: 'INR' });
      for (const [entity,field,id] of [[Orders,'total',order.id],[OrderLines,'unit_price',line.id],[PaymentAttempts,'amount',payment.id]]) {
        const row = await runtime.getRepository(entity).findOneByOrFail({ id });
        assert.equal(row[field], 9007199254740993n);
      }
    });

    await t.test('constraints reject invalid quantities, money, states, duplicates and missing references', async () => {
      const rejected = (sql, params, code) => assert.rejects(runtime.query(sql,params), error => error.code === code);
      await rejected(`INSERT INTO ${q('product_variants')} (product_id,sku,name,price,currency) VALUES ($1,'MNV-001','Copy',1,'INR')`,[product.id],'23505');
      await rejected(`INSERT INTO ${q('stock_levels')} (variant_id,location_id) VALUES ($1,$2)`,[variant.id,location.id],'23505');
      await rejected(`UPDATE ${q('stock_levels')} SET on_hand=-1 WHERE id=$1`,[stock.id],'23514');
      await rejected(`UPDATE ${q('order_lines')} SET quantity=0 WHERE id=$1`,[line.id],'23514');
      await rejected(`UPDATE ${q('orders')} SET total=-1 WHERE id=$1`,[order.id],'23514');
      await rejected(`UPDATE ${q('orders')} SET state='bogus' WHERE id=$1`,[order.id],'23514');
      await rejected(`UPDATE ${q('orders')} SET currency='inr' WHERE id=$1`,[order.id],'23514');
      await rejected(`UPDATE ${q('product_variants')} SET product_id='00000000-0000-0000-0000-000000000000' WHERE id=$1`,[variant.id],'23503');
      await rejected(`INSERT INTO ${q('stock_movements')} (stock_level_id,quantity_delta,reason) VALUES ($1,0,'bad')`,[stock.id],'42501');
      await assert.rejects(admin.query(`INSERT INTO ${q('stock_movements')} (stock_level_id,quantity_delta,reason) VALUES ($1,0,'bad')`,[stock.id]),e=>e.code==='23514');
      await rejected(`UPDATE ${q('payment_attempts')} SET amount=9223372036854775808`,[],'22003');
      await rejected(`INSERT INTO ${q('payment_attempts')} (order_id,provider,idempotency_key,amount,currency) VALUES ($1,'test','pay-001',1,'INR')`,[order.id],'23505');
      await rejected(`INSERT INTO ${q('idempotency_records')} (scope,key,request_hash,state) VALUES ('checkout','bad',$1,'completed')`,['b'.repeat(64)],'23514');
      const results = await Promise.allSettled([1,2].map(() => runtime.query(`INSERT INTO ${q('idempotency_records')} (scope,key,request_hash) VALUES ('checkout','same-key',$1)`,['b'.repeat(64)])));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'23505');
      await runtime.query(`UPDATE ${q('idempotency_records')} SET state='completed',response_status=200,response_body=$1 WHERE key='same-key'`, [stringifyCommerce({total:9007199254740993n})]);
    });

    await t.test('history survives archive; referenced catalog deletes and ledger mutations are blocked', async () => {
      await runtime.query(`UPDATE ${q('products')} SET name='Renamed', archived_at=now() WHERE id=$1`,[product.id]);
      await runtime.query(`UPDATE ${q('product_variants')} SET archived_at=now() WHERE id=$1`,[variant.id]);
      await assert.rejects(runtime.query(`DELETE FROM ${q('product_variants')} WHERE id=$1`,[variant.id]), e=>['23503','23001'].includes(e.code));
      await assert.rejects(runtime.query(`DELETE FROM ${q('products')} WHERE id=$1`,[product.id]), e=>['23503','23001'].includes(e.code));
      assert.equal((await runtime.query(`SELECT product_name FROM ${q('order_lines')} WHERE id=$1`,[line.id]))[0].product_name,'Shirt');
      for (const table of ['stock_movements','order_transitions']) {
        for (const sql of [`UPDATE ${q(table)} SET created_at=now()`, `DELETE FROM ${q(table)}`, `TRUNCATE ${q(table)}`]) {
          await assert.rejects(admin.query(sql),e=>e.code==='23514');
          await assert.rejects(runtime.query(sql),e=>e.code==='42501');
        }
        const counts = await runtime.query(`SELECT count(*)::int AS count FROM ${q(table)} ${table==='stock_movements'?'WHERE stock_level_id=$1':''}`,table==='stock_movements'?[stock.id]:[]);
        assert.equal(counts[0].count,table==='stock_movements'?3:1);
      }
      for (const sql of [`CREATE TABLE ${q('must_fail')} (id integer)`, `TRUNCATE ${q('products')} CASCADE`, `DELETE FROM ${q('orders')}`]) {
        await assert.rejects(runtime.query(sql),e=>e.code==='42501');
      }
    });

    await t.test('readiness rejects unknown migration history and rollback requires exact disposable confirmation', async () => {
      await admin.query(`INSERT INTO ${q('mnv_migrations')} (timestamp,name) VALUES (1,'UnknownMigration')`);
      assert.equal((await requestReady()).status,503);
      cli('run',{},false);
      await admin.query(`DELETE FROM ${q('mnv_migrations')} WHERE name='UnknownMigration'`);
      cli('revert',{},false);
      assert.equal((await requestReady()).status,200);
      cli('revert',{MNV_ALLOW_DESTRUCTIVE_ROLLBACK:identity.database});
      assert.equal((await requestReady()).status,503);
      assert.ok((await admin.query(`SELECT count(*)::int AS count FROM ${q('stock_movements')}`))[0].count>0,'Inventory rollback retains original ledger rows');
      for (let i=1;i<migrationNames.length;i++) cli('revert',{MNV_ALLOW_DESTRUCTIVE_ROLLBACK:identity.database});
      assert.deepEqual((await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=$1`,[process.env.DB_SCHEMA])).map(r=>r.table_name),['mnv_migrations']);
      cli('run');
      assert.equal((await requestReady()).status,200);
      for(const table of commerceTables) assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${q(table)}`))[0].count,0);
    });
  } finally {
    if (app) {
      await app.close();
      const appDb = app.get(require('typeorm').DataSource);
      if (appDb.isInitialized) await appDb.destroy();
    }
    if(runtime.isInitialized) await runtime.destroy();
    await admin.destroy();
  }
});
