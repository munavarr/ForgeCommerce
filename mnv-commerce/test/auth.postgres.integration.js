const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { createDataSource } = require('../dist/database/options');
const { verifyDatabaseIdentity, migrationStatus, quoteIdentifier } = require('../dist/database/safety');
const { commerceTables } = require('../dist/database/tables');
const { AuthService } = require('../dist/auth/auth.service');
const { createAdministrator } = require('../dist/auth/create-admin');
const { OrdersService } = require('../dist/commerce/orders.service');
const { CatalogService } = require('../dist/commerce/catalog.service');
const { InventoryService } = require('../dist/inventory/inventory.service');
const { Users, Sessions } = require('../dist/database/entities/commerce.entity');

test('real authentication and authorization on isolated PostgreSQL', {timeout:60000}, async t=>{
  const owner=createDataSource(true),runtime=createDataSource(); let app;
  const password='Phase four private passphrase '+randomUUID();
  const key=()=>randomUUID();
  const q=n=>`${quoteIdentifier(process.env.DB_SCHEMA)}.${quoteIdentifier(n)}`;
  const bearer=s=>`Bearer ${s.token}`;
  const reject=(promise,code)=>assert.rejects(promise,e=>e.code===code);
  try {
    await owner.initialize(); const identity=await verifyDatabaseIdentity(owner,true);
    assert.equal(identity.owner,process.env.DB_MIGRATION_USER);assert.equal((await migrationStatus(owner)).ready,true);
    for(const table of commerceTables) assert.equal((await owner.query(`SELECT count(*)::int n FROM ${q(table)}`))[0].n,0,'Fresh migrated auth database required');
    await runtime.initialize();
    app=await NestFactory.create(AppModule,{logger:false});await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const auth=app.get(AuthService),orders=app.get(OrdersService),catalog=app.get(CatalogService),inventory=app.get(InventoryService);
    const request=async(path,method='GET',body,session)=>{
      const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(session?{authorization:bearer(session)}:{})},...(body?{body:JSON.stringify(body)}:{})});
      return {status:response.status,body:await response.json(),headers:response.headers};
    };
    const pinput=()=>({key:key(),name:'Secured product',description:'Phase four',active:true,archived:false});
    let customer,other,manager,session,otherSession,adminSession,location,product,variant,order;
    await t.test('registers only customers, normalizes email, never verifies email or returns hashes',async()=>{
      const result=await request('/auth/register','POST',{email:'Customer@MNV.invalid',password});assert.equal(result.status,201);customer=result.body;
      assert.equal(customer.role,'customer');assert.equal(customer.email,'customer@mnv.invalid');assert.equal(customer.email_verified_at,null);
      assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(customer.password_hash,undefined);
      const [stored]=await owner.query(`SELECT * FROM ${q('users')} WHERE id=$1`,[customer.id]);assert.match(stored.password_hash,/^\$argon2id\$/);assert.notEqual(stored.password_hash,password);
      other=await auth.register({email:'other@mnv.invalid',password});
      await reject(auth.register({email:customer.email,password}),'ACCOUNT_CONFLICT');
      assert.equal((await request('/auth/register','POST',{email:customer.email,password})).status,409);
      for(const extra of [{role:'administrator'},{role:'admin'},{email_verified_at:new Date().toISOString()},{password_hash:'forged'},{userId:customer.id}])
        assert.equal((await request('/auth/register','POST',{email:key()+'@mnv.invalid',password,...extra})).status,400);
      for(const value of ['short','a'.repeat(1025),'😀'.repeat(257)]) assert.equal((await request('/auth/register','POST',{email:key()+'@mnv.invalid',password:value})).status,400);
      const [repoUser]=await runtime.getRepository(Users).find();assert.equal(repoUser.password_hash,undefined);
    });
    await t.test('login stores only token digests, returns distinct opaque tokens and hides invalid credentials',async()=>{
      const result=await request('/auth/login','POST',{email:'CUSTOMER@mnv.invalid',password});assert.equal(result.status,201);session=result.body;
      assert.equal(result.headers.get('cache-control'),'no-store');assert.match(session.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(session.user.password_hash,undefined);
      assert.equal(session.user.email_verified_at,null);assert.equal(session.tokenType,'Bearer');
      const second=await auth.login({email:customer.email,password});assert.notEqual(second.token,session.token);
      const [stored]=await owner.query(`SELECT * FROM ${q('sessions')} WHERE token_hash=$1`,[createHash('sha256').update(session.token).digest('hex')]);
      assert.equal(stored.user_id,customer.id);assert.notEqual(stored.token_hash,session.token);
      assert.ok(stored.expires_at-stored.created_at>=8*3600000-1000);assert.ok(stored.expires_at-stored.created_at<=8*3600000+1000);
      assert.ok(!JSON.stringify(await owner.query(`SELECT * FROM ${q('sessions')}`)).includes(session.token));
      assert.equal((await runtime.getRepository(Sessions).find())[0].token_hash,undefined);
      const wrong=await request('/auth/login','POST',{email:customer.email,password:password+'wrong'});
      const missing=await request('/auth/login','POST',{email:'absent@mnv.invalid',password});
      assert.equal(wrong.status,401);assert.deepEqual(missing.body,wrong.body);
      otherSession=await auth.login({email:other.email,password});
      assert.equal((await request('/auth/me','GET',undefined,session)).body.userId,customer.id);
      const legacy=await owner.query(`INSERT INTO ${q('users')}(email,password_hash) VALUES ('legacy@mnv.invalid','not-a-real-hash') RETURNING id`);
      await reject(auth.login({email:'legacy@mnv.invalid',password}),'UNAUTHENTICATED');
      assert.equal(legacy.length,1);
    });
    await t.test('administrator provisioning requires owner access and never promotes or overwrites an account',async()=>{
      await createAdministrator({email:'administrator@mnv.invalid',password});
      [manager]=await owner.query(`SELECT id,role,email_verified_at FROM ${q('users')} WHERE email='administrator@mnv.invalid'`);
      assert.equal(manager.role,'administrator');assert.equal(manager.email_verified_at,null);
      adminSession=await auth.login({email:'administrator@mnv.invalid',password});
      await assert.rejects(createAdministrator({email:customer.email,password}));
      assert.equal((await owner.query(`SELECT role FROM ${q('users')} WHERE id=$1`,[customer.id]))[0].role,'customer');
      const cli=spawnSync(process.execPath,['dist/auth/create-admin.js'],{input:'not accepted\n',encoding:'utf8'});
      assert.equal(cli.status,1);assert.doesNotMatch(cli.stdout+cli.stderr,/not accepted|argon2/);
      const args=spawnSync(process.execPath,['dist/auth/create-admin.js','--password='+password],{encoding:'utf8'});
      assert.equal(args.status,1);assert.ok(!(args.stdout+args.stderr).includes(password));
      for(const sql of [`UPDATE ${q('users')} SET role='administrator' WHERE id=$1`, `UPDATE ${q('users')} SET email_verified_at=now() WHERE id=$1`])
        await assert.rejects(runtime.query(sql,[customer.id]),e=>e.code==='42501');
      await assert.rejects(runtime.query(`INSERT INTO ${q('users')}(email,password_hash,role) VALUES ('forged@mnv.invalid','x','administrator')`),e=>e.code==='42501');
      await assert.rejects(owner.query(`UPDATE ${q('users')} SET role='superadmin' WHERE id=$1`,[customer.id]),e=>e.code==='23514');
    });
    await t.test('all order/cart reads and commands require a session, including direct service calls',async()=>{
      assert.equal((await request('/orders','POST',{key:key()})).status,401);
      assert.equal((await request('/orders/'+key())).status,401);
      for(const route of ['/orders/checkout','/orders/cancel','/orders/lines/remove']) assert.equal((await request(route,'POST',{})).status,401);
      assert.equal((await request('/orders/lines','PUT',{})).status,401);
      for(const context of [null,{}, {userId:customer.id,role:'administrator'},'Bearer invalid'])
        await reject(orders.createDraft(context,{key:key()}),'UNAUTHENTICATED');
      assert.equal((await request('/orders','POST',{key:key()},adminSession)).status,403);
      const result=await request('/orders','POST',{key:key()},session);assert.equal(result.status,201);order=result.body;
      assert.equal(order.user_id,customer.id);
    });
    await t.test('catalog and inventory require administrators; client audit actors are rejected',async()=>{
      assert.equal((await request('/catalog')).status,200);
      for(const s of [undefined,session,otherSession]) {
        const status=s?403:401;
        assert.equal((await request('/admin/catalog/products','POST',pinput(),s)).status,status);
        assert.equal((await request('/admin/inventory/adjust','POST',{},s)).status,status);
        assert.equal((await request('/admin/inventory/initialize','POST',{},s)).status,status);
        assert.equal((await request('/admin/inventory/locations','POST',{},s)).status,status);
        assert.equal((await request('/admin/inventory/locations','PUT',{},s)).status,status);
        assert.equal((await request('/admin/inventory/locations','GET',undefined,s)).status,status);
      }
      for(const action of ['createLocation','manageLocation','initializeStock','adjustStock'])
        await reject(inventory[action](bearer(session),{}),'FORBIDDEN');
      await reject(catalog.createProduct(bearer(session),pinput()),'FORBIDDEN');
      const made=await request('/admin/catalog/products','POST',pinput(),adminSession);assert.equal(made.status,201);product=made.body;
      const variantInput={key:key(),sku:key(),name:'Variant',price:'100',currency:'INR',active:true,archived:false};
      const madeVariant=await request(`/admin/catalog/products/${product.id}/variants`,'POST',variantInput,adminSession);assert.equal(madeVariant.status,201);variant=madeVariant.body;
      const loc=await request('/admin/inventory/locations','POST',{key:key(),reason:'Provision',code:'MAIN',name:'Main'},adminSession);assert.equal(loc.status,201);location=loc.body;
      const stock=await request('/admin/inventory/initialize','POST',{key:key(),reason:'Opening',variantId:variant.id,locationId:location.id,quantity:10},adminSession);assert.equal(stock.status,201);
      const adjustment={key:key(),reason:'Counted',variantId:variant.id,locationId:location.id,delta:2};
      const adjusted=await request('/admin/inventory/adjust','POST',adjustment,adminSession);assert.equal(adjusted.status,201);assert.equal(adjusted.body.on_hand,12);
      assert.deepEqual((await request('/admin/inventory/adjust','POST',adjustment,adminSession)).body,adjusted.body);
      assert.equal((await request('/admin/inventory/adjust','POST',{...adjustment,key:key(),actor:customer.id},adminSession)).status,400);
      const ledger=await owner.query(`SELECT actor FROM ${q('stock_movements')}`);assert.ok(ledger.every(r=>r.actor===manager.id));
    });
    await t.test('customers cannot read/edit/check out/cancel foreign orders, change ownership or forge state',async()=>{
      const line={key:key(),orderId:order.id,variantId:variant.id,quantity:2};
      assert.equal((await request('/orders/lines','PUT',line,session)).status,200);
      const foreign=await request('/orders/'+order.id,'GET',undefined,otherSession),missing=await request('/orders/'+key(),'GET',undefined,otherSession);
      assert.equal(foreign.status,404);assert.deepEqual(foreign.body,missing.body);
      for(const action of [()=>orders.read(bearer(otherSession),order.id),()=>orders.setLine(bearer(otherSession),{...line,key:key()}),
        ()=>orders.removeLine(bearer(otherSession),{key:key(),orderId:order.id,variantId:variant.id}),()=>orders.checkout(bearer(otherSession),{key:key(),orderId:order.id}),()=>orders.cancel(bearer(otherSession),{key:key(),orderId:order.id})])
        await reject(action(),'ORDER_NOT_FOUND');
      assert.equal((await request('/orders/lines','PUT',{...line,key:key()},otherSession)).status,404);
      for(const extra of [{userId:other.id},{user_id:other.id},{state:'paid'},{total:'0'},{role:'administrator'}])
        assert.equal((await request('/orders','POST',{key:key(),...extra},session)).status,400);
      assert.equal((await request('/orders/lines','PUT',{...line,key:key(),userId:other.id},session)).status,400);
      await assert.rejects(runtime.query(`UPDATE ${q('orders')} SET user_id=$2 WHERE id=$1`,[order.id,other.id]),e=>e.code==='23514');
      assert.equal((await owner.query(`SELECT user_id FROM ${q('orders')} WHERE id=$1`,[order.id]))[0].user_id,customer.id);
    });
    await t.test('real customer checkout/cancellation preserves atomic stock, snapshots and replay',async()=>{
      const command={key:key(),orderId:order.id};
      const [a,b]=await Promise.all([orders.checkout(bearer(session),command),orders.checkout(bearer(session),command)]);
      assert.deepEqual(a,b);assert.equal(a.state,'placed');assert.equal(a.total,'200');
      assert.equal((await inventory.readStock(bearer(adminSession),variant.id,location.id)).reserved,2);
      const cancelled=await request('/orders/cancel','POST',{key:key(),orderId:order.id},session);assert.equal(cancelled.status,201);assert.equal(cancelled.body.state,'cancelled');
      const stock=await inventory.readStock(bearer(adminSession),variant.id,location.id);assert.equal(stock.reserved,0);assert.equal(stock.on_hand,12);
      assert.equal((await owner.query(`SELECT count(*)::int n FROM ${q('order_transitions')} WHERE order_id=$1`,[order.id]))[0].n,2);
    });
    await t.test('global commerce key conflicts across principals without replaying another customers response',async()=>{
      const command={key:key()},saved=await orders.createDraft(bearer(session),command);
      await reject(orders.createDraft(bearer(otherSession),command),'IDEMPOTENCY_CONFLICT');
      assert.deepEqual(await orders.createDraft(bearer(session),command),saved);
      const [count]=await owner.query(`SELECT count(*)::int n FROM ${q('orders')} WHERE id=$1 AND user_id=$2`,[saved.id,customer.id]);
      assert.equal(count.n,1);
    });
    await t.test('payment remains internal and rejects customer/admin forged confirmation without any stock mutation',async()=>{
      const pending=await orders.createDraft(bearer(session),{key:key()});
      await orders.setLine(bearer(session),{key:key(),orderId:pending.id,variantId:variant.id,quantity:1});
      await orders.checkout(bearer(session),{key:key(),orderId:pending.id});
      for(const s of [undefined,session,adminSession]) for(const path of ['/payments','/orders/payment','/orders/'+pending.id+'/confirm-payment','/admin/payments/confirm','/admin/inventory/commit'])
        assert.equal((await request(path,'POST',{key:key(),orderId:pending.id,paid:true,verified:true,outcome:'succeeded'},s)).status,404);
      await reject(orders.recordPayment({key:key(),evidence:{orderId:pending.id,amount:'100',currency:'INR',paid:true,verified:true,outcome:'succeeded'}}),'PAYMENT_VERIFIER_UNAVAILABLE');
      assert.equal((await orders.read(bearer(session),pending.id)).state,'placed');
      assert.equal((await inventory.readStock(bearer(adminSession),variant.id,location.id)).reserved,1);
      assert.equal((await owner.query(`SELECT count(*)::int n FROM ${q('payment_attempts')}`))[0].n,0);
      await orders.cancel(bearer(session),{key:key(),orderId:pending.id});
    });
    await t.test('logout serializes with an already-authorized transaction and blocks subsequent access',async()=>{
      const concurrent=await auth.login({email:customer.email,password});
      const runner=runtime.createQueryRunner();await runner.connect();await runner.startTransaction();
      let pending;
      try {
        await auth.authenticate(bearer(concurrent),runner.manager);
        pending=auth.logout(bearer(concurrent));
        // Observe an actual PostgreSQL lock wait, rather than assuming a promise has overlapped.
        let blocked=false;
        for(let i=0;i<100;i++) {
          const [{n}]=await owner.query(`SELECT count(*)::int n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid','tuple')`);
          if(n>0) {blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.ok(blocked,'Revocation waits for the authorized transaction session lock');
        await runner.commitTransaction();
      } finally {if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();if(pending)await pending;}
      await reject(auth.authenticate(bearer(concurrent)),'UNAUTHENTICATED');
      await reject(orders.createDraft(bearer(concurrent),{key:key()}),'UNAUTHENTICATED');
    });
    await t.test('expired and revoked sessions fail immediately, including idempotent result replay',async()=>{
      const command={key:key()};await orders.createDraft(bearer(session),command);
      const expired=await auth.login({email:customer.email,password});
      await owner.query(`UPDATE ${q('sessions')} SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE token_hash=$1`,[createHash('sha256').update(expired.token).digest('hex')]);
      assert.equal((await request('/auth/me','GET',undefined,expired)).status,401);
      await reject(orders.createDraft(bearer(expired),{key:key()}),'UNAUTHENTICATED');
      assert.equal((await request('/auth/logout','POST',{},session)).status,201);
      assert.equal((await request('/auth/logout','POST',{},session)).status,201);
      assert.equal((await request('/auth/me','GET',undefined,session)).status,401);
      await reject(orders.createDraft(bearer(session),command),'UNAUTHENTICATED');
      const adminCommand={...pinput()};await catalog.createProduct(bearer(adminSession),adminCommand);await auth.logout(bearer(adminSession));
      await reject(catalog.createProduct(bearer(adminSession),adminCommand),'UNAUTHENTICATED');
      await reject(inventory.adjustStock(bearer(adminSession),{key:key(),reason:'Revoked',variantId:variant.id,locationId:location.id,delta:1}),'UNAUTHENTICATED');
      assert.equal((await request('/auth/me')).status,401);
      assert.equal((await request('/auth/me','GET',undefined,{token:require('node:crypto').randomBytes(32).toString('base64url')})).status,401);
      assert.equal((await request('/auth/logout','POST',{})).status,401);
    });
    await t.test('archival and role changes invalidate authorization without token caches',async()=>{
      await runtime.query(`UPDATE ${q('users')} SET archived_at=clock_timestamp() WHERE id=$1`,[other.id]);
      await reject(auth.authenticate(bearer(otherSession)),'UNAUTHENTICATED');
      await reject(auth.login({email:other.email,password}),'UNAUTHENTICATED');
      const active=await auth.login({email:customer.email,password});
      const command={key:key()};await orders.createDraft(bearer(active),command);
      await owner.query(`UPDATE ${q('users')} SET role='administrator' WHERE id=$1`,[customer.id]);
      await reject(orders.createDraft(bearer(active),command),'FORBIDDEN');
      await owner.query(`UPDATE ${q('users')} SET role='customer' WHERE id=$1`,[customer.id]);
      const mismatch=await owner.query(`SELECT id FROM ${q('stock_levels')} s WHERE reserved<0 OR reserved>on_hand OR reserved<>(SELECT coalesce(sum(quantity),0) FROM ${q('stock_reservations')} WHERE stock_level_id=s.id AND state='active')`);
      assert.deepEqual(mismatch,[]);
    });
  } finally {
    if(app){await app.close();const db=app.get(require('typeorm').DataSource);if(db.isInitialized)await db.destroy();}
    if(runtime.isInitialized)await runtime.destroy();if(owner.isInitialized)await owner.destroy();
  }
});
