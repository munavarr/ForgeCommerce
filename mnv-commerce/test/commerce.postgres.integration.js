const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { createDataSource } = require('../dist/database/options');
const { verifyDatabaseIdentity, migrationStatus, quoteIdentifier } = require('../dist/database/safety');
const { commerceTables } = require('../dist/database/tables');
const { CatalogService } = require('../dist/commerce/catalog.service');
const { OrdersService } = require('../dist/commerce/orders.service');
const { CommerceAccess, PaymentResultVerifier } = require('../dist/commerce/access');
const { PricingPolicy } = require('../dist/commerce/pricing');
const { InventoryEngine: InventoryService } = require('../dist/inventory/inventory.engine');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');

test('catalog, checkout and order lifecycle on verified isolated PostgreSQL', {timeout:60000}, async t => {
  const admin=createDataSource(true),runtime=createDataSource(); let app;
  try {
    await admin.initialize();
    const identity=await verifyDatabaseIdentity(admin,true);
    assert.equal(identity.owner,process.env.DB_MIGRATION_USER);
    assert.equal((await migrationStatus(admin)).ready,true);
    const q=n=>`${quoteIdentifier(process.env.DB_SCHEMA)}.${quoteIdentifier(n)}`;
    for(const table of commerceTables) assert.equal((await admin.query(`SELECT count(*)::int n FROM ${q(table)}`))[0].n,0,'Requires fresh migrated test database');
    await runtime.initialize();
    console.log(JSON.stringify({commerceIdentity:identity,runtimeRole:(await runtime.query('SELECT current_user role'))[0].role}));
    const [user,other]=await runtime.query(`INSERT INTO ${q('users')}(email,password_hash) VALUES
      ('customer@mnv.invalid','test-only'),('other@mnv.invalid','test-only') RETURNING id`);
    const customer=Object.freeze({}),stranger=Object.freeze({}),manager=Object.freeze({});
    // Test-only adapter resolves fixture contexts. Production requires database-backed bearer sessions.
    class TestAccess extends CommerceAccess {
      async customer(context) { if(context===customer) return {userId:user.id}; if(context===stranger) return {userId:other.id}; return super.customer(context); }
      async catalogManager(context) { if(context===manager) return {actor:'test:catalog-manager'}; return super.catalogManager(context); }
    }
    let verifications=0;
    const authority=new Map();
    class TestPayments extends PaymentResultVerifier {
      async verify(token) { verifications++; const result=authority.get(token); if(!result) return super.verify(token); return {...result}; }
    }
    const access=new TestAccess(),inventory=new InventoryService(runtime),catalog=new CatalogService(runtime,access);
    const policy=new PricingPolicy({currency:'INR',taxBasisPoints:500,shipping:'7',reservationSeconds:900});
    const orders=new OrdersService(runtime,access,catalog,inventory,policy,new TestPayments());
    const key=()=>randomUUID();
    const audit=()=>({key:key(),actor:'test:inventory',reason:'test fixture'});
    const location=await inventory.createLocation({...audit(),code:'MAIN',name:'Main'});
    const pinput=extra=>({key:key(),name:'Product',description:'Original description',active:true,archived:false,...extra});
    const vinput=extra=>({key:key(),sku:key(),name:'Variant',price:'10',currency:'INR',active:true,archived:false,...extra});
    async function fixture(quantity=10,price='10') {
      const pi=pinput(),p=await catalog.createProduct(manager,pi),vi=vinput({price}),v=await catalog.createVariant(manager,p.id,vi);
      await inventory.initializeStock({...audit(),variantId:v.id,locationId:location.id,quantity});
      return {p,v,pi,vi};
    }
    const draft=()=>orders.createDraft(customer,{key:key()});
    async function populated(f,quantity=1) { const o=await draft(); return orders.setLine(customer,{key:key(),orderId:o.id,variantId:f.v.id,quantity}); }
    const checkout=o=>orders.checkout(customer,{key:key(),orderId:o.id});
    function payment(o,outcome='succeeded',extra={}) {
      const token=Object.freeze({}); authority.set(token,{provider:'test-authority',reference:key(),orderId:o.id,amount:o.total,currency:o.currency,outcome,...extra});
      return {key:key(),evidence:token};
    }
    const reject=(promise,code)=>assert.rejects(promise,e=>e.code===code);
    const snapshot=async()=>{
      const result={};
      for(const table of ['orders','order_lines','stock_levels','stock_reservations','stock_movements','order_transitions','payment_attempts','idempotency_records'])
        result[table]=await admin.query(`SELECT * FROM ${q(table)} ORDER BY id`);
      return result;
    };
    async function failTrigger(table,body,work) {
      await admin.query(`CREATE FUNCTION ${q('phase3_test_failure')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER phase3_test_failure BEFORE INSERT ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION ${q('phase3_test_failure')}()`);
      try { await work(); } finally { await admin.query(`DROP TRIGGER phase3_test_failure ON ${q(table)}`); await admin.query(`DROP FUNCTION ${q('phase3_test_failure')}()`); }
    }

    await t.test('catalog DTO validation, database SKU uniqueness, concurrent duplicates and archive retain history',async()=>{
      const f=await fixture();
      const command=vinput({sku:'UNIQUE-SKU'});
      const rows=await Promise.allSettled([catalog.createVariant(manager,f.p.id,command),catalog.createVariant(manager,f.p.id,{...command,key:key()})]);
      assert.equal(rows.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(rows.find(r=>r.status==='rejected').reason.code,'COMMERCE_CONFLICT');
      const saved=rows.find(r=>r.status==='fulfilled').value;
      await reject(catalog.updateVariant(manager,f.p.id,f.v.id,{...f.vi,key:key(),sku:saved.sku}),'COMMERCE_CONFLICT');
      for(const price of ['-1','1.1',10,Number.MAX_SAFE_INTEGER,'9223372036854775808'])
        await assert.rejects(catalog.createVariant(manager,f.p.id,vinput({price})),e=>e.getStatus()===400);
      for(const extra of [{sku:' '},{name:''},{currency:'inr'},{active:'true'},{unknown:'field'}])
        await assert.rejects(catalog.createVariant(manager,f.p.id,vinput(extra)),e=>e.getStatus()===400);
      await assert.rejects(runtime.query(`UPDATE ${q('product_variants')} SET price=-1 WHERE id=$1`,[f.v.id]),e=>e.code==='23514');
      await assert.rejects(runtime.query(`UPDATE ${q('product_variants')} SET sku=$2 WHERE id=$1`,[f.v.id,saved.sku]),e=>e.code==='23505');
      await catalog.updateVariant(manager,f.p.id,saved.id,{...command,key:key(),archived:true});
      await reject(catalog.createVariant(manager,f.p.id,{...command,key:key()}),'COMMERCE_CONFLICT');
      const o=await populated(f);
      await catalog.updateVariant(manager,f.p.id,f.v.id,{...f.vi,key:key(),active:false});
      assert.ok(!(await catalog.listPublic()).some(v=>v.variant_id===f.v.id));
      await reject(checkout(o),'VARIANT_UNAVAILABLE');
      await catalog.updateVariant(manager,f.p.id,f.v.id,{...f.vi,key:key()});
      await catalog.updateProduct(manager,f.p.id,{...f.pi,key:key(),archived:true});
      assert.ok(!(await catalog.listPublic()).some(v=>v.product_id===f.p.id));
      await reject(checkout(o),'VARIANT_UNAVAILABLE');
      assert.equal((await orders.read(customer,o.id)).lines[0].product_description,f.pi.description);
      await catalog.updateProduct(manager,f.p.id,{...f.pi,key:key(),active:false});
      await reject(checkout(o),'VARIANT_UNAVAILABLE');
    });
    await t.test('ownership derives from trusted context; public reads and privileged mutations remain separate',async()=>{
      const f=await fixture(),o=await populated(f),before=await snapshot();
      await reject(orders.read(stranger,o.id),'ORDER_NOT_FOUND');
      for(const action of [()=>orders.setLine(stranger,{key:key(),orderId:o.id,variantId:f.v.id,quantity:1}),
        ()=>orders.removeLine(stranger,{key:key(),orderId:o.id,variantId:f.v.id}),()=>orders.checkout(stranger,{key:key(),orderId:o.id}),
        ()=>orders.cancel(stranger,{key:key(),orderId:o.id})]) await reject(action(),'ORDER_NOT_FOUND');
      await reject(orders.createDraft({userId:user.id},{key:key()}),'FORBIDDEN');
      await reject(catalog.createProduct(customer,pinput()),'FORBIDDEN');
      for(const extra of [{userId:other.id},{total:'1'},{state:'paid'},{price:'0'}])
        await assert.rejects(orders.checkout(customer,{key:key(),orderId:o.id,...extra}),e=>e.getStatus()===400);
      assert.deepEqual(await snapshot(),before);
      app=await NestFactory.create(AppModule,{logger:false}); await app.listen(0,'127.0.0.1'); const base=await app.getUrl();
      assert.equal((await fetch(`${base}/catalog`)).status,200);
      for(const route of ['/catalog','/checkout','/payments','/inventory/reserve'])
        assert.equal((await fetch(`${base}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
      const production=app.get(OrdersService);
      await reject(production.createDraft({userId:user.id},{key:key()}),'UNAUTHENTICATED');
      await reject(production.recordPayment({key:key(),evidence:{...payment(o),outcome:'succeeded'}}),'PAYMENT_VERIFIER_UNAVAILABLE');
    });
    await t.test('absolute line upsert, removal/re-add, quantity validation and empty checkout are atomic',async()=>{
      const f=await fixture(),o=await draft();
      await reject(checkout(o),'EMPTY_ORDER');
      for(const quantity of [0,-1,1.5,'1',2147483648,null])
        await assert.rejects(orders.setLine(customer,{key:key(),orderId:o.id,variantId:f.v.id,quantity}),e=>e.getStatus()===400);
      const command={key:key(),orderId:o.id,variantId:f.v.id,quantity:2};
      const [a,b]=await Promise.all([orders.setLine(customer,command),orders.setLine(customer,command)]);
      assert.deepEqual(a,b); assert.equal(a.lines.length,1); assert.equal(a.subtotal,'20');assert.equal(a.tax,'1');assert.equal(a.total,'28');
      await reject(orders.setLine(customer,{...command,quantity:3}),'IDEMPOTENCY_CONFLICT');
      await Promise.all([1,2].map(()=>orders.setLine(customer,{...command,key:key(),quantity:3})));
      const changed=await orders.setLine(customer,{...command,key:key(),quantity:3}); assert.equal(changed.lines[0].quantity,3); assert.equal(changed.total,'39');
      const removal={key:key(),orderId:o.id,variantId:f.v.id};
      const removed=await orders.removeLine(customer,removal); assert.equal(removed.total,'0');assert.equal(removed.lines.length,0);
      assert.deepEqual(await orders.removeLine(customer,removal),removed);
      const readded=await orders.setLine(customer,{...command,key:key(),quantity:1});assert.equal(readded.lines[0].id,a.lines[0].id);
      const otherOrder=await draft();
      await reject(orders.setLine(customer,{...command,orderId:otherOrder.id}),'IDEMPOTENCY_CONFLICT');
    });
    await t.test('live rounding boundaries, large exact prices, zero totals and currency validation',async()=>{
      for(const [price,tax,total] of [['9','0','16'],['10','1','18'],['11','1','19']]) {
        const f=await fixture(10,price),o=await checkout(await populated(f));assert.equal(o.tax,tax);assert.equal(o.total,total);
        await orders.cancel(customer,{key:key(),orderId:o.id});
      }
      const large=await fixture(10,'9007199254740993'),largeOrder=await checkout(await populated(large));
      assert.equal(largeOrder.subtotal,'9007199254740993');assert.equal(largeOrder.tax,'450359962737050');assert.equal(largeOrder.total,'9457559217478050');
      await orders.cancel(customer,{key:key(),orderId:largeOrder.id});
      const f=await fixture(10,'0'),freeOrders=new OrdersService(runtime,access,catalog,inventory,new PricingPolicy(),new TestPayments());
      const zero=await freeOrders.checkout(customer,{key:key(),orderId:(await populated(f)).id});assert.equal(zero.total,'0');
      const paid=await freeOrders.recordPayment(payment(zero));assert.equal(paid.state,'paid');
      const foreign=await fixture();await catalog.updateVariant(manager,foreign.p.id,foreign.v.id,{...foreign.vi,key:key(),currency:'USD'});
      const o=await draft();await reject(orders.setLine(customer,{key:key(),orderId:o.id,variantId:foreign.v.id,quantity:1}),'VARIANT_UNAVAILABLE');
      const overflow=await fixture(10,'9223372036854775807');const before=await snapshot();
      await assert.rejects(populated(overflow),e=>e.getStatus()===400);
      // Creating the draft is a separate successful command; failed line mutation leaves it empty.
      const after=await snapshot();assert.equal(after.order_lines.length,before.order_lines.length);assert.equal(after.stock_reservations.length,before.stock_reservations.length);
    });
    await t.test('checkout refreshes stale prices, freezes descriptions/SKU/currency/pricing and records one transition',async()=>{
      const f=await fixture(),o=await populated(f);
      await catalog.updateVariant(manager,f.p.id,f.v.id,{...f.vi,key:key(),price:'11',sku:'NEW-SKU'});
      await catalog.updateProduct(manager,f.p.id,{...f.pi,key:key(),description:'Checkout description'});
      const command={key:'k'.repeat(200),orderId:o.id};
      const [a,b]=await Promise.all([orders.checkout(customer,command),orders.checkout(customer,command)]);
      assert.deepEqual(a,b);assert.equal(a.lifecycle,'PaymentPending');assert.equal(a.subtotal,'11');assert.equal(a.tax,'1');assert.equal(a.total,'19');
      assert.equal(a.lines[0].sku,'NEW-SKU');assert.equal(a.lines[0].product_description,'Checkout description');assert.equal(a.lines[0].currency,'INR');
      assert.deepEqual(a.lines[0].pricing,a.pricing);
      assert.equal((await admin.query(`SELECT * FROM ${q('order_transitions')} WHERE order_id=$1`,[o.id])).length,1);
      await reject(orders.checkout(customer,{...command,key:key()}),'ORDER_STATE');
      await reject(orders.checkout(customer,{...command,orderId:randomUUID()}),'IDEMPOTENCY_CONFLICT');
      await catalog.updateVariant(manager,f.p.id,f.v.id,{...f.vi,key:key(),price:'999',archived:true});
      await catalog.updateProduct(manager,f.p.id,{...f.pi,key:key(),name:'Renamed',archived:true});
      const current=await orders.read(customer,o.id);assert.equal(current.lines[0].unit_price,'11');assert.equal(current.lines[0].product_description,'Checkout description');
      for(const sql of [`UPDATE ${q('order_lines')} SET sku='forged' WHERE order_id=$1`,
        `UPDATE ${q('order_lines')} SET currency='USD' WHERE order_id=$1`,
        `UPDATE ${q('orders')} SET total=1 WHERE id=$1`, `UPDATE ${q('orders')} SET user_id=NULL WHERE id=$1`,
        `UPDATE ${q('orders')} SET state='draft' WHERE id=$1`]) await assert.rejects(runtime.query(sql,[o.id]),e=>e.code==='23514');
    });
    await t.test('different orders contend for inventory; repeated concurrent checkout reserves once',async()=>{
      const f=await fixture(5),a=await populated(f,4),b=await populated(f,4);
      const blocker=admin.createQueryRunner(); await blocker.connect();await blocker.startTransaction();
      await blocker.query(`SELECT id FROM ${q('stock_levels')} WHERE variant_id=$1 FOR UPDATE`,[f.v.id]);
      const commands=[a,b].map(o=>({key:key(),orderId:o.id}));
      const pending=Promise.allSettled(commands.map(c=>orders.checkout(customer,c)));
      try {
        let waiting=false;
        for(let i=0;i<100;i++) {
          const [{n}]=await admin.query(`SELECT count(DISTINCT pid)::int n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid','tuple')`);
          if(n>=2){waiting=true;break;} await new Promise(r=>setTimeout(r,10));
        }
        assert.ok(waiting,'Both real checkout transactions wait on inventory locks');
      } finally {await blocker.rollbackTransaction();await blocker.release();}
      const results=await pending;assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_STOCK');
      const winner=results.find(r=>r.status==='fulfilled').value;
      const replay=await orders.checkout(customer,commands.find(c=>c.orderId===winner.id));assert.deepEqual(replay,winner);
      const stock=await inventory.readStock(f.v.id,location.id);assert.equal(stock.reserved,4);assert.equal(stock.available,1);
      const loser=[a,b].find(o=>o.id!==winner.id);assert.equal((await orders.read(customer,loser.id)).state,'draft');
      assert.equal((await admin.query(`SELECT count(*)::int n FROM ${q('stock_reservations')} r JOIN ${q('order_lines')} l ON l.id=r.order_line_id WHERE l.variant_id=$1`,[f.v.id]))[0].n,1);
    });
    await t.test('any failed checkout step rolls back prices, reservations, movements, transition and request claims',async()=>{
      const f=await fixture(10),o=await populated(f);
      await catalog.updateVariant(manager,f.p.id,f.v.id,{...f.vi,key:key(),price:'25'});
      const before=await snapshot();
      await failTrigger('order_transitions',`RAISE EXCEPTION 'injected transition failure' USING ERRCODE='23514';`,async()=>{
        await reject(checkout(o),'COMMERCE_INVARIANT'); assert.deepEqual(await snapshot(),before);
      });
      await failTrigger('order_transitions',`RAISE EXCEPTION 'injected serialization failure' USING ERRCODE='40001';`,async()=>{
        await reject(checkout(o),'INVENTORY_BUSY'); assert.deepEqual(await snapshot(),before);
      });
      const unavailable=await fixture(0),two=await populated(f,2);
      await orders.setLine(customer,{key:key(),orderId:two.id,variantId:unavailable.v.id,quantity:1});
      const beforeShortage=await snapshot();await reject(checkout(two),'INSUFFICIENT_STOCK');assert.deepEqual(await snapshot(),beforeShortage);
    });
    await t.test('authoritative payment result commits inventory atomically; duplicate evidence cannot repeat sale',async()=>{
      const f=await fixture(),o=await checkout(await populated(f,2)),command=payment(o);
      await reject(orders.recordPayment({key:key(),evidence:{outcome:'succeeded',orderId:o.id}}),'PAYMENT_VERIFIER_UNAVAILABLE');
      await reject(orders.recordPayment(payment(o,'succeeded',{amount:'1'})),'PAYMENT_MISMATCH');
      await reject(orders.recordPayment(payment(o,'succeeded',{currency:'USD'})),'PAYMENT_MISMATCH');
      const before=await snapshot(),count=verifications;
      await admin.query(`CREATE SEQUENCE ${q('phase3_retry_attempts')}`);
      await failTrigger('stock_movements',`IF NEW.kind='sale' THEN PERFORM nextval('${q('phase3_retry_attempts')}'); RAISE EXCEPTION 'sale serialization failure' USING ERRCODE='40001'; END IF;`,async()=>{
        await reject(orders.recordPayment(command),'INVENTORY_BUSY');assert.deepEqual(await snapshot(),before);
      });
      assert.equal((await admin.query(`SELECT last_value FROM ${q('phase3_retry_attempts')}`))[0].last_value,'4','Four complete attempts reached sale insertion');
      await admin.query(`DROP SEQUENCE ${q('phase3_retry_attempts')}`);
      assert.equal(verifications,count+1,'Provider verification runs once across all four database attempts');
      const [a,b]=await Promise.all([orders.recordPayment(command),orders.recordPayment(command)]);
      assert.deepEqual(a,b);assert.equal(a.lifecycle,'Paid');
      assert.deepEqual(await orders.recordPayment({...command,key:key()}),a);
      const conflictingToken=Object.freeze({});authority.set(conflictingToken,{...authority.get(command.evidence),amount:'1'});
      await reject(orders.recordPayment({key:key(),evidence:conflictingToken}),'PAYMENT_CONFLICT');
      await reject(orders.recordPayment({...command,evidence:payment(o,'failed').evidence}),'IDEMPOTENCY_CONFLICT');
      const stock=await inventory.readStock(f.v.id,location.id);assert.equal(stock.on_hand,8);assert.equal(stock.reserved,0);assert.equal(stock.sold,'2');
      assert.equal((await admin.query(`SELECT count(*)::int n FROM ${q('payment_attempts')} WHERE order_id=$1`,[o.id]))[0].n,1);
      assert.deepEqual((await admin.query(`SELECT from_state,to_state FROM ${q('order_transitions')} WHERE order_id=$1 ORDER BY created_at`,[o.id])).map(r=>[r.from_state,r.to_state]),[['draft','placed'],['placed','paid']]);
      for(const action of [()=>orders.setLine(customer,{key:key(),orderId:o.id,variantId:f.v.id,quantity:3}),
        ()=>orders.removeLine(customer,{key:key(),orderId:o.id,variantId:f.v.id}),()=>checkout(o),()=>orders.cancel(customer,{key:key(),orderId:o.id})])
        await reject(action(),'ORDER_STATE');
      for(const sql of [`UPDATE ${q('order_lines')} SET unit_price=0 WHERE order_id=$1`,
        `UPDATE ${q('orders')} SET state='cancelled' WHERE id=$1`, `UPDATE ${q('orders')} SET total=0 WHERE id=$1`])
        await assert.rejects(admin.query(sql,[o.id]),e=>e.code==='23514');
    });
    await t.test('failure, expiry and cancellation paths release holds and reject illegal transitions',async()=>{
      const f=await fixture(),o=await checkout(await populated(f));
      const result=await orders.recordPayment(payment(o,'failed'));assert.equal(result.lifecycle,'Cancelled');
      assert.equal((await inventory.readStock(f.v.id,location.id)).reserved,0);
      await reject(orders.recordPayment(payment(o)),'ORDER_STATE');
      const draftOrder=await populated(f);
      await assert.rejects(runtime.query(`UPDATE ${q('orders')} SET state='paid' WHERE id=$1`,[draftOrder.id]),e=>e.code==='23514');
      await reject(orders.recordPayment(payment(draftOrder)),'ORDER_STATE');
      const cancelled=await orders.cancel(customer,{key:key(),orderId:draftOrder.id});assert.equal(cancelled.state,'cancelled');
      const pendingOrder=await checkout(await populated(f));const cancel={key:key(),orderId:pendingOrder.id};
      const [a,b]=await Promise.all([orders.cancel(customer,cancel),orders.cancel(customer,cancel)]);assert.deepEqual(a,b);
      assert.equal((await inventory.readStock(f.v.id,location.id)).reserved,0);
      const short=new OrdersService(runtime,access,catalog,inventory,new PricingPolicy({currency:'INR',taxBasisPoints:0,shipping:'0',reservationSeconds:1}),new TestPayments());
      const exp=await short.checkout(customer,{key:key(),orderId:(await populated(f)).id});
      await new Promise(r=>setTimeout(r,1100));
      const before=await snapshot();await reject(short.recordPayment(payment(exp)),'RESERVATION_EXPIRED');assert.deepEqual(await snapshot(),before);
      await short.cancel(customer,{key:key(),orderId:exp.id});assert.equal((await inventory.readStock(f.v.id,location.id)).reserved,0);
    });
    await t.test('customer archival and pre-existing draft reservation history cannot bypass checkout',async()=>{
      const f=await fixture(),create={key:key()};
      const o=await orders.createDraft(customer,create);
      await orders.setLine(customer,{key:key(),orderId:o.id,variantId:f.v.id,quantity:1});
      const populatedOrder=await orders.read(customer,o.id);
      await runtime.query(`UPDATE ${q('users')} SET archived_at=now() WHERE id=$1`,[user.id]);
      try {await reject(checkout(o),'FORBIDDEN');await reject(orders.read(customer,o.id),'FORBIDDEN');await reject(orders.createDraft(customer,create),'FORBIDDEN');}
      finally {await runtime.query(`UPDATE ${q('users')} SET archived_at=NULL WHERE id=$1`,[user.id]);}
      await inventory.reserveStock({...audit(),orderId:o.id,expiresAt:new Date(Date.now()+60000).toISOString(),
        items:[{lineId:populatedOrder.lines[0].id,variantId:f.v.id,locationId:location.id,quantity:1}]});
      const before=await snapshot();await reject(checkout(o),'LEGACY_ORDER_REQUIRES_REVIEW');
      await reject(orders.removeLine(customer,{key:key(),orderId:o.id,variantId:f.v.id}),'COMMERCE_INVARIANT');
      assert.deepEqual(await snapshot(),before);
      await orders.cancel(customer,{key:key(),orderId:o.id});
    });
    await t.test('payment and cancellation race finalizes the order and its reservations once',async()=>{
      const f=await fixture(),o=await checkout(await populated(f)),command=payment(o);
      const results=await Promise.allSettled([orders.recordPayment(command),orders.cancel(customer,{key:key(),orderId:o.id})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'ORDER_STATE');
      const final=await orders.read(customer,o.id),stock=await inventory.readStock(f.v.id,location.id);
      assert.equal(stock.reserved,0);assert.equal(stock.on_hand,final.state==='paid'?9:10);
      assert.equal((await admin.query(`SELECT count(*)::int n FROM ${q('order_transitions')} WHERE order_id=$1`,[o.id]))[0].n,2);
    });
    await t.test('final inventory counters agree with reservations and all payment evidence remains immutable',async()=>{
      const mismatches=await admin.query(`SELECT s.id FROM ${q('stock_levels')} s WHERE reserved<0 OR reserved>on_hand OR reserved<>
        (SELECT coalesce(sum(quantity),0) FROM ${q('stock_reservations')} r WHERE r.stock_level_id=s.id AND state='active')`);
      assert.deepEqual(mismatches,[]);
      await assert.rejects(admin.query(`UPDATE ${q('payment_attempts')} SET amount=1`),e=>e.code==='23514');
      await assert.rejects(runtime.query(`INSERT INTO ${q('order_transitions')}(order_id,from_state,to_state) SELECT id,'draft','paid' FROM ${q('orders')} LIMIT 1`),e=>e.code==='42501');
    });
  } finally {
    if(app){await app.close();const db=app.get(require('typeorm').DataSource);if(db.isInitialized)await db.destroy();}
    if(runtime.isInitialized)await runtime.destroy();if(admin.isInitialized)await admin.destroy();
  }
});
