const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {spawnSync,fork}=require('node:child_process');
const {createDataSource}=require('../dist/database/options');
const {verifyDatabaseIdentity,migrationStatus,quoteIdentifier}=require('../dist/database/safety');
const {commerceTables}=require('../dist/database/tables');
const {AuthService}=require('../dist/auth/auth.service');
const {hashPassword}=require('../dist/auth/password');
const {CommerceAccess,PaymentResultVerifier}=require('../dist/commerce/access');
const {CatalogService}=require('../dist/commerce/catalog.service');
const {OrdersService}=require('../dist/commerce/orders.service');
const {PricingPolicy}=require('../dist/commerce/pricing');
const {InventoryEngine}=require('../dist/inventory/inventory.engine');
const {PaymentProvider,DevelopmentPaymentProvider}=require('../dist/payments/provider');
const {PaymentsService}=require('../dist/payments/payments.service');
const {NestFactory}=require('@nestjs/core');
const {AppModule}=require('../dist/app.module');

test('durable payments and reconciliation on isolated PostgreSQL',{timeout:90000},async t=>{
  const owner=createDataSource(true),db=createDataSource();let app;
  const key=()=>randomUUID(),q=n=>`${quoteIdentifier(process.env.DB_SCHEMA)}.${quoteIdentifier(n)}`;
  const reject=(promise,code)=>assert.rejects(promise,e=>e.code===code);
  try{
    await owner.initialize();const identity=await verifyDatabaseIdentity(owner,true);
    assert.equal(identity.owner,process.env.DB_MIGRATION_USER);assert.equal((await migrationStatus(owner)).ready,true);
    for(const table of commerceTables)assert.equal((await owner.query(`SELECT count(*)::int n FROM ${q(table)}`))[0].n,0,'Fresh migrated payments database required');
    await db.initialize();console.log(JSON.stringify({paymentIdentity:identity,runtimeRole:(await db.query('SELECT current_user role'))[0].role}));
    const password='Phase five test passphrase '+key(),hash=await hashPassword(password);
    const [customer,administrator,stranger]=await owner.query(`INSERT INTO ${q('users')}(email,password_hash,role) VALUES
      ('pay@mnv.invalid',$1,'customer'),('admin@mnv.invalid',$1,'administrator'),('other@mnv.invalid',$1,'customer') RETURNING id,email`,[hash]);
    const auth=new AuthService(db),access=new CommerceAccess(auth),inventory=new InventoryEngine(db),catalog=new CatalogService(db,access);
    const login=async u=>'Bearer '+(await auth.login({email:u.email,password})).token;
    const context=await login(customer),admin=await login(administrator),other=await login(stranger);
    const policy=new PricingPolicy({currency:'INR',taxBasisPoints:0,shipping:'0',reservationSeconds:900});
    const orders=new OrdersService(db,access,catalog,inventory,policy,new PaymentResultVerifier());
    const audit=()=>({key:key(),actor:'payment-test',reason:'fixture'});
    const location=await inventory.createLocation({...audit(),code:'MAIN',name:'Main'});
    async function fixture(options={}){
      const p=await catalog.createProduct(admin,{key:key(),name:'Payment product',description:'frozen',active:true,archived:false});
      const variant=await catalog.createVariant(admin,p.id,{key:key(),name:'Payment variant',sku:key(),price:options.price??'125',currency:'INR',active:true,archived:false});
      await inventory.initializeStock({...audit(),variantId:variant.id,locationId:location.id,quantity:10});
      let o=await orders.createDraft(context,{key:key()});o=await orders.setLine(context,{key:key(),orderId:o.id,variantId:variant.id,quantity:2});
      const service=options.short?new OrdersService(db,access,catalog,inventory,new PricingPolicy({currency:'INR',taxBasisPoints:0,shipping:'0',reservationSeconds:1}),new PaymentResultVerifier()):orders;
      o=await service.checkout(context,{key:key(),orderId:o.id});return {o,variant};
    }
    const command=f=>({key:key(),orderId:f.o.id});
    const order=id=>owner.query(`SELECT * FROM ${q('orders')} WHERE id=$1`,[id]).then(r=>r[0]);
    const attempts=id=>owner.query(`SELECT * FROM ${q('payment_attempts')} WHERE order_id=$1`,[id]);
    const holds=id=>owner.query(`SELECT r.* FROM ${q('stock_reservations')} r JOIN ${q('order_lines')} l ON l.id=r.order_line_id WHERE l.order_id=$1`,[id]);
    const stock=f=>inventory.readStock(f.variant.id,location.id);
    const snapshot=async()=>{
      const result={};for(const table of ['orders','stock_levels','stock_reservations','stock_movements','order_transitions','payment_attempts','idempotency_records'])
        result[table]=await owner.query(`SELECT * FROM ${q(table)} ORDER BY id`);return result;
    };
    // Only this fixture recognizes opaque notification objects. No test verifier or secret is
    // registered in AppModule, production source, HTTP routes or the development provider.
    class Provider extends PaymentProvider{
      name='test-v1';mode='succeeded';requests=[];records=new Map();effects=0;notifications=new WeakMap();hook;
      async charge(request){
        this.requests.push({...request});
        const [saved]=await owner.query(`SELECT * FROM ${q('payment_attempts')} WHERE id=$1`,[request.attemptId]);
        assert.ok(saved,'Attempt committed and visible to independent connection BEFORE provider I/O');
        assert.equal(saved.idempotency_key,request.idempotencyKey);assert.equal(saved.amount,request.amount);assert.equal(saved.currency,request.currency);
        if(!this.records.has(request.idempotencyKey)){
          this.effects++;this.records.set(request.idempotencyKey,{...request,provider:this.name,reference:'ref:'+request.idempotencyKey,state:this.mode==='timeout'?'succeeded':this.mode});
        }
        if(this.hook)await this.hook(request);
        if(this.mode==='timeout')throw Error('Lost response');
        return {...this.records.get(request.idempotencyKey)};
      }
      async lookup(request){return {...this.records.get(request.idempotencyKey)??{state:'not_found'}};}
      async verifyNotification(token){if(!this.notifications.has(token))throw Error('Unauthenticated notification');return {...this.notifications.get(token)};}
      token(result){const token=Object.freeze({});this.notifications.set(token,result);return token;}
      result(a,state='succeeded',extra={}){return {attemptId:a.id,idempotencyKey:a.idempotency_key,orderId:a.order_id,amount:a.amount,currency:a.currency,provider:this.name,reference:'ref:'+a.idempotency_key,state,...extra};}
    }
    const service=(provider,engine=inventory)=>new PaymentsService(db,access,engine,provider);
    async function failure(table,event,body,work){
      await owner.query(`CREATE FUNCTION ${q('phase5_failure')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`);
      await owner.query(`CREATE TRIGGER phase5_failure BEFORE ${event} ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION ${q('phase5_failure')}()`);
      try{await work();}finally{await owner.query(`DROP TRIGGER phase5_failure ON ${q(table)}`);await owner.query(`DROP FUNCTION ${q('phase5_failure')}()`);}
    }
    await t.test('authenticated ownership, strict DTOs and public routes prevent client-declared success',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p),c=command(f),before=await snapshot();
      await reject(s.start(null,c),'UNAUTHENTICATED');await reject(s.start(other,c),'ORDER_NOT_FOUND');await reject(s.start(admin,c),'FORBIDDEN');
      for(const extra of [{state:'succeeded'},{amount:'0'},{currency:'USD'},{provider:'development-v1'},{verified:true},{userId:customer.id}])
        await assert.rejects(s.start(context,{...c,...extra}),e=>e.getStatus()===400);
      await assert.rejects(s.notification({...p.result({id:key()}),verified:true}));
      assert.deepEqual(await snapshot(),before);assert.equal(p.requests.length,0);
      app=await NestFactory.create(AppModule,{logger:false});await app.listen(0,'127.0.0.1');const base=await app.getUrl();
      for(const route of ['/payments','/payments/start','/payments/confirm','/payments/webhook','/payments/development','/orders/payment','/admin/payments/confirm']){
        const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',authorization:context},body:JSON.stringify({...c,state:'succeeded'})});assert.equal(r.status,404);
      }
      await assert.rejects(app.get(PaymentsService).notification({verified:true,state:'succeeded'}),e=>e.code==='PAYMENT_NOTIFICATION_REJECTED');
    });
    await t.test('cancelled and draft orders reject new provider execution',async()=>{
      const p=new Provider(),s=service(p),draft=await orders.createDraft(context,{key:key()});
      await reject(s.start(context,{key:key(),orderId:draft.id}),'ORDER_STATE');
      const f=await fixture();await orders.cancel(context,{key:key(),orderId:f.o.id});
      await reject(s.start(context,command(f)),'ORDER_STATE');assert.equal(p.requests.length,0);assert.equal((await attempts(f.o.id)).length,0);
    });
    await t.test('success uses frozen snapshot and duplicate keys return one charge and one stock consumption',async()=>{
      const f=await fixture({price:'9007199254740993'}),p=new Provider(),s=service(p),c=command(f);
      await catalog.updateVariant(admin,(await owner.query(`SELECT product_id FROM ${q('product_variants')} WHERE id=$1`,[f.variant.id]))[0].product_id,f.variant.id,
        {key:key(),name:'changed',sku:f.variant.sku,price:'1',currency:'USD',active:false,archived:true});
      const a=await s.start(context,c);assert.equal(a.state,'succeeded');assert.equal(a.amount,'18014398509481986');
      assert.equal((await order(f.o.id)).state,'paid');assert.equal((await stock(f)).on_hand,8);assert.equal((await stock(f)).reserved,0);
      const b=await s.start(context,c);assert.equal(a.id,b.id);assert.equal(p.effects,1);assert.equal(p.requests.length,1);
      assert.equal((await attempts(f.o.id)).length,1);assert.equal((await holds(f.o.id))[0].state,'consumed');
      assert.equal((await owner.query(`SELECT count(*)::int n FROM ${q('stock_movements')} WHERE kind='sale' AND stock_level_id=$1`,[(await holds(f.o.id))[0].stock_level_id]))[0].n,1);
      await reject(s.start(context,{...c,orderId:key()}),'IDEMPOTENCY_CONFLICT');
      await reject(s.start(context,{...c,key:key()}),'ORDER_STATE');
      await reject(orders.cancel(context,{key:key(),orderId:f.o.id}),'ORDER_STATE');
    });
    await t.test('definitive decline releases reservations, cancels and rejects late success',async()=>{
      const f=await fixture(),p=new Provider();p.mode='declined';const s=service(p),a=await s.start(context,command(f));
      assert.equal(a.state,'declined');assert.equal((await order(f.o.id)).state,'cancelled');
      assert.equal((await stock(f)).reserved,0);assert.equal((await stock(f)).on_hand,10);assert.equal((await holds(f.o.id))[0].state,'released');
      const before=await snapshot();await reject(s.notification(p.token(p.result(a,'succeeded'))),'PAYMENT_CONFLICT');assert.deepEqual(await snapshot(),before);
      assert.equal((await s.notification(p.token(p.result(a,'unknown')))).state,'declined');
    });
    await t.test('timeout preserves reservations and key; same logical request retries provider idempotently',async()=>{
      const f=await fixture(),p=new Provider();p.mode='timeout';const s=service(p),c=command(f),a=await s.start(context,c);
      assert.equal(a.state,'unknown');assert.equal((await order(f.o.id)).state,'placed');assert.equal((await stock(f)).reserved,2);
      assert.equal((await holds(f.o.id))[0].state,'active');
      await reject(orders.cancel(context,{key:key(),orderId:f.o.id}),'PAYMENT_UNRESOLVED');
      const before=await snapshot();
      await assert.rejects(inventory.releaseReservations({...audit(),orderId:f.o.id,reservationIds:(await holds(f.o.id)).map(r=>r.id)}));
      await assert.rejects(owner.query(`UPDATE ${q('orders')} SET state='cancelled' WHERE id=$1`,[f.o.id]),e=>e.code==='23514');
      assert.deepEqual(await snapshot(),before);
      await reject(s.start(context,{key:key(),orderId:f.o.id}),'PAYMENT_EXISTS');
      p.mode='succeeded';const b=await s.start(context,c);assert.equal(b.id,a.id);assert.equal(b.state,'succeeded');
      assert.equal(p.effects,1);assert.equal(p.requests.length,2);assert.equal(p.requests[0].idempotencyKey,p.requests[1].idempotencyKey);
    });
    await t.test('unknown lookup and out-of-order pending retain uncertainty; authoritative decline releases',async()=>{
      const f=await fixture(),p=new Provider();p.mode='pending';const s=service(p),a=await s.start(context,command(f));
      assert.equal(a.state,'pending');
      const unknown=await s.notification(p.token(p.result(a,'unknown')));assert.equal(unknown.state,'unknown');
      assert.equal((await s.notification(p.token(p.result(a,'pending')))).state,'unknown');
      p.records.set(a.idempotency_key,p.result(a,'unknown'));assert.equal((await s.reconcileAttempt(a.id)).state,'unknown');
      assert.equal((await stock(f)).reserved,2);assert.equal((await order(f.o.id)).state,'placed');
      p.records.set(a.idempotency_key,p.result(a,'declined'));assert.equal((await s.reconcileAttempt(a.id)).state,'declined');
      assert.equal((await stock(f)).reserved,0);assert.equal((await order(f.o.id)).state,'cancelled');
    });
    await t.test('provider amount/currency/order/key/reference mismatches cannot finalize',async()=>{
      const f=await fixture(),p=new Provider();p.mode='pending';const s=service(p),a=await s.start(context,command(f));
      for(const extra of [{amount:'1'},{currency:'USD'},{orderId:key()},{idempotencyKey:key()},{provider:'forged'},{reference:'changed'}]){
        const before=await snapshot();await reject(s.notification(p.token(p.result(a,'succeeded',extra))),extra.reference?'PAYMENT_CONFLICT':'PAYMENT_MISMATCH');assert.deepEqual(await snapshot(),before);
      }
      p.records.set(a.idempotency_key,p.result(a,'succeeded',{amount:'1'}));
      await reject(s.reconcileAttempt(a.id),'PAYMENT_MISMATCH');assert.equal((await attempts(f.o.id))[0].state,'unknown');
      assert.equal((await stock(f)).reserved,2);p.records.set(a.idempotency_key,p.result(a));await s.reconcileAttempt(a.id);
    });
    await t.test('duplicate concurrent confirmations and stale notifications never consume twice or reopen paid',async()=>{
      const f=await fixture(),p=new Provider();p.mode='pending';const s=service(p),a=await s.start(context,command(f));
      const token=p.token(p.result(a));const results=await Promise.all(Array.from({length:6},()=>s.notification(token)));
      assert.ok(results.every(r=>r.state==='succeeded'));assert.equal((await stock(f)).on_hand,8);assert.equal((await stock(f)).sold,'2');
      const before=await snapshot();
      for(const state of ['pending','unknown','succeeded'])assert.equal((await s.notification(p.token(p.result(a,state)))).state,'succeeded');
      await reject(s.notification(p.token(p.result(a,'declined'))),'PAYMENT_CONFLICT');assert.deepEqual(await snapshot(),before);
    });
    await t.test('concurrent same-key requests share one persisted provider key and reject another logical key',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p),c=command(f);
      const results=await Promise.all([s.start(context,c),s.start(context,c),s.start(context,c)]);
      assert.ok(results.every(r=>r.id===results[0].id));assert.equal(p.effects,1);
      assert.equal(new Set(p.requests.map(r=>r.idempotencyKey)).size,1);assert.equal((await attempts(f.o.id)).length,1);assert.equal((await stock(f)).on_hand,8);
      const g=await fixture(),provider=new Provider();provider.mode='pending';const svc=service(provider);
      const competing=await Promise.allSettled([svc.start(context,command(g)),svc.start(context,command(g))]);
      assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);assert.equal(competing.find(r=>r.status==='rejected').reason.code,'PAYMENT_EXISTS');
      const a=(await attempts(g.o.id))[0];await svc.notification(provider.token(provider.result(a,'declined')));
    });
    await t.test('provider I/O holds no database transaction locks; cancellation cannot race an admitted attempt',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p);let admitted,release;
      const waiting=new Promise(r=>admitted=r),gate=new Promise(r=>release=r);
      p.hook=async()=>{admitted();await gate;};const paying=s.start(context,command(f));
      try{
        await waiting;
        const runner=owner.createQueryRunner();await runner.connect();await runner.startTransaction();
        try{await runner.query(`SELECT id FROM ${q('orders')} WHERE id=$1 FOR UPDATE NOWAIT`,[f.o.id]);await runner.query(`SELECT id FROM ${q('payment_attempts')} WHERE order_id=$1 FOR UPDATE NOWAIT`,[f.o.id]);}
        finally{await runner.rollbackTransaction();await runner.release();}
        await reject(orders.cancel(context,{key:key(),orderId:f.o.id}),'PAYMENT_UNRESOLVED');
      }finally{release();}
      assert.equal((await paying).state,'succeeded');assert.equal((await stock(f)).on_hand,8);
    });
    await t.test('crash after durable attempt before provider call resumes by lookup then same-key submission',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p),c=command(f),original=s.execute;
      s.execute=async()=>{throw Error('Simulated process exit before I/O');};
      try{await assert.rejects(s.start(context,c));}finally{s.execute=original;}
      const a=(await attempts(f.o.id))[0];assert.equal(a.state,'pending');assert.equal(p.requests.length,0);
      const restarted=service(p);assert.equal((await restarted.reconcileAttempt(a.id)).state,'succeeded');
      assert.equal(p.requests[0].idempotencyKey,a.idempotency_key);assert.equal((await stock(f)).on_hand,8);
    });
    await t.test('crash after provider success before finalization preserves attempt and recovers without charging again',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p),c=command(f),original=s.finalize;
      s.finalize=async()=>{throw Error('Simulated crash after response');};
      try{await assert.rejects(s.start(context,c));}finally{s.finalize=original;}
      const a=(await attempts(f.o.id))[0];assert.equal(a.state,'pending');assert.equal((await order(f.o.id)).state,'placed');assert.equal((await stock(f)).reserved,2);
      assert.equal((await service(p).reconcileAttempt(a.id)).state,'succeeded');assert.equal(p.requests.length,1);assert.equal(p.effects,1);
      assert.equal((await service(p).reconcileAttempt(a.id)).state,'succeeded');assert.equal((await stock(f)).sold,'2');
    });
    await t.test('SIGKILL during uncommitted finalization rolls back and CLI recovers durable state',async()=>{
      const f=await fixture(),c=command(f),env={...process.env};
      delete env.DB_MIGRATION_USER;delete env.DB_MIGRATION_PASSWORD;
      const child=fork(require.resolve('./payment-crash-worker'),[],{env,stdio:['ignore','ignore','pipe','ipc']});
      let stderr='';child.stderr.on('data',data=>stderr+=data);
      const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
      let timer;
      try{
        const message=new Promise(resolve=>child.once('message',resolve));
        child.send({context,command:c});
        const checkpoint=await Promise.race([
          message,
          exited.then(()=>{throw Error('Worker exited before checkpoint');}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker checkpoint timeout')),10000);}),
        ]);
        clearTimeout(timer);assert.equal(checkpoint.stage,'before-finalization-commit');
        const [activity]=await db.query('SELECT datname,usename,state FROM pg_stat_activity WHERE pid=$1',[checkpoint.pid]);
        assert.equal(activity.datname,process.env.DB_NAME);assert.equal(activity.usename,process.env.DB_USER);
        assert.equal(activity.state,'idle in transaction');
        const a=(await attempts(f.o.id))[0];assert.equal(a.state,'pending');
        assert.equal((await order(f.o.id)).state,'placed');assert.equal((await stock(f)).reserved,2);
        const before=await snapshot();
        child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
        for(let i=0;i<100;i++){
          const [{connected}]=await owner.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1) connected',[checkpoint.pid]);
          if(!connected)break;if(i===99)assert.fail('Killed worker backend still connected');await new Promise(r=>setTimeout(r,10));
        }
        assert.deepEqual(await snapshot(),before,'Database discarded all uncommitted finalization effects');
        const dev=new DevelopmentPaymentProvider(),expected=await dev.lookup({attemptId:a.id,idempotencyKey:a.idempotency_key,orderId:a.order_id,amount:a.amount,currency:a.currency});
        for(let i=0;i<2;i++){
          const result=spawnSync(process.execPath,['dist/payments/reconcile.js'],{env,encoding:'utf8'});
          assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout).errors,[]);
        }
        assert.equal((await attempts(f.o.id))[0].state,expected.state);
        assert.equal((await order(f.o.id)).state,expected.state==='succeeded'?'paid':'cancelled');
        assert.equal((await stock(f)).reserved,0);assert.equal((await stock(f)).on_hand,expected.state==='succeeded'?8:10);
        assert.equal((await attempts(f.o.id)).length,1);assert.equal(stderr,'');
      }finally{
        clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;
      }
    });
    await t.test('four whole transaction retries keep provider outside retry and roll back every finalization write',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p);let before;p.hook=async()=>{before=await snapshot();};
      await owner.query(`CREATE SEQUENCE ${q('phase5_retries')}`);
      try{
        await failure('stock_movements','INSERT',`IF NEW.kind='sale' THEN PERFORM nextval('${q('phase5_retries')}'); RAISE EXCEPTION 'injected' USING ERRCODE='40001'; END IF;`,async()=>{
          await assert.rejects(s.start(context,command(f)));assert.deepEqual(await snapshot(),before);
        });
        assert.equal((await owner.query(`SELECT last_value FROM ${q('phase5_retries')}`))[0].last_value,'4');assert.equal(p.requests.length,1);assert.equal(p.effects,1);
      }finally{await owner.query(`DROP SEQUENCE ${q('phase5_retries')}`);}
      await service(p).reconcileAttempt((await attempts(f.o.id))[0].id);assert.equal((await stock(f)).on_hand,8);
    });
    await t.test('order failure and inventory failure atomically roll back payment, order, stock and history',async()=>{
      for(const [table,event,body] of [['orders','UPDATE',`IF NEW.state='paid' THEN RAISE EXCEPTION 'injected' USING ERRCODE='23514'; END IF;`],
        ['stock_movements','INSERT',`IF NEW.kind='sale' THEN RAISE EXCEPTION 'injected' USING ERRCODE='23514'; END IF;`],
        ['stock_movements','INSERT',`IF NEW.kind='release' THEN RAISE EXCEPTION 'injected' USING ERRCODE='23514'; END IF;`]]){
        const f=await fixture(),p=new Provider();if(body.includes("kind='release'"))p.mode='declined';const s=service(p);let before;p.hook=async()=>{before=await snapshot();};
        await failure(table,event,body,async()=>{await assert.rejects(s.start(context,command(f)));assert.deepEqual(await snapshot(),before);});
        assert.equal((await attempts(f.o.id))[0].state,'pending');assert.equal((await order(f.o.id)).state,'placed');assert.equal((await stock(f)).reserved,2);
        await s.reconcileAttempt((await attempts(f.o.id))[0].id);assert.equal((await stock(f)).reserved,0);
      }
    });
    await t.test('failure deferred until COMMIT rolls back finalization and durable attempt recovers',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p);let before;
      p.hook=async()=>{before=await snapshot();};
      await owner.query(`CREATE FUNCTION ${q('phase7_commit_failure')}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state='paid' THEN RAISE EXCEPTION 'deferred failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
      try{
        await owner.query(`CREATE CONSTRAINT TRIGGER phase7_commit_failure AFTER UPDATE ON ${q('orders')}
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${q('phase7_commit_failure')}()`);
        try{await assert.rejects(s.start(context,command(f)),e=>e.code==='23514');assert.deepEqual(await snapshot(),before);}
        finally{await owner.query(`DROP TRIGGER phase7_commit_failure ON ${q('orders')}`);}
      }finally{await owner.query(`DROP FUNCTION ${q('phase7_commit_failure')}()`);}
      const a=(await attempts(f.o.id))[0];assert.equal(a.state,'pending');assert.equal((await stock(f)).reserved,2);
      assert.equal(p.effects,1);assert.equal(p.requests.length,1);
      assert.equal((await service(p).reconcileAttempt(a.id)).state,'succeeded');
      assert.equal(p.requests.length,1);assert.equal((await stock(f)).on_hand,8);assert.equal((await stock(f)).sold,'2');
    });
    await t.test('lost COMMIT acknowledgement preserves committed terminal evidence and same-key replay',async()=>{
      const f=await fixture(),p=new Provider(),s=service(p),c=command(f);
      const original=db.createQueryRunner.bind(db);let commits=0;
      // Simulate transport loss AFTER PostgreSQL accepted COMMIT, rather than a failed write.
      p.hook=async()=>{
        db.createQueryRunner=(...args)=>{
          const runner=original(...args),commit=runner.commitTransaction.bind(runner);
          runner.commitTransaction=async()=>{await commit();commits++;throw Object.assign(Error('Lost acknowledgement'),{code:'08006'});};
          return runner;
        };
      };
      try{await assert.rejects(s.start(context,c),e=>e.code==='08006');}
      finally{db.createQueryRunner=original;p.hook=undefined;}
      assert.equal(commits,1,'An ambiguous commit must never be retried automatically');
      const a=(await attempts(f.o.id))[0];assert.equal(a.state,'succeeded');
      assert.equal((await order(f.o.id)).state,'paid');assert.equal((await stock(f)).on_hand,8);assert.equal((await stock(f)).reserved,0);
      const before=await snapshot();
      assert.equal((await service(p).start(context,c)).id,a.id);
      assert.deepEqual(await service(p).reconcile(),{processed:0,unresolved:0,errors:[]});
      assert.equal(p.effects,1);assert.equal(p.requests.length,1);assert.deepEqual(await snapshot(),before);
    });
    await t.test('expired-but-held uncertain reservations reconcile to success or definitive decline',async()=>{
      for(const outcome of ['succeeded','declined']){
        const f=await fixture({short:true}),p=new Provider();p.mode='timeout';const s=service(p),a=await s.start(context,command(f));
        await new Promise(r=>setTimeout(r,1100));assert.equal((await holds(f.o.id))[0].state,'active');assert.equal((await stock(f)).reserved,2);
        await reject(orders.cancel(context,{key:key(),orderId:f.o.id}),'PAYMENT_UNRESOLVED');
        p.records.set(a.idempotency_key,p.result(a,outcome));assert.equal((await service(p).reconcileAttempt(a.id)).state,outcome);
        assert.equal((await stock(f)).reserved,0);assert.equal((await stock(f)).on_hand,outcome==='succeeded'?8:10);
      }
    });
    await t.test('explicit reconciliation command resumes deterministic lost responses and is repeatable',async()=>{
      const f=await fixture(),dev=new DevelopmentPaymentProvider(),s=service(dev),original=s.finalize;
      s.finalize=async()=>{throw Error('Simulated crash');};
      try{await s.start(context,command(f));}catch{}finally{s.finalize=original;}
      const a=(await attempts(f.o.id))[0],expected=await dev.lookup({attemptId:a.id,idempotencyKey:a.idempotency_key,orderId:a.order_id,amount:a.amount,currency:a.currency});
      for(let i=0;i<2;i++){
        const result=spawnSync(process.execPath,['dist/payments/reconcile.js'],{env:process.env,encoding:'utf8'});
        assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).errors.length,0);
      }
      assert.equal((await attempts(f.o.id))[0].state,expected.state);assert.equal((await order(f.o.id)).state,expected.state==='succeeded'?'paid':'cancelled');
      const production=spawnSync(process.execPath,['dist/payments/reconcile.js'],{env:{...process.env,NODE_ENV:'production'},encoding:'utf8'});assert.equal(production.status,1);
    });
    await t.test('reconciliation reports provider outages and isolates one item failure from later work',async()=>{
      const f=await fixture(),g=await fixture(),p=new Provider();p.mode='pending';const s=service(p);
      const a=await s.start(context,command(f)),b=await s.start(context,command(g));
      const lookup=p.lookup;p.lookup=async request=>{
        if(request.attemptId===a.id)throw Error('Provider outage');return {...p.result(b,'declined')};
      };
      let result=await s.reconcile();assert.equal(result.processed,2);assert.equal(result.unresolved,1);assert.deepEqual(result.errors,[]);
      assert.equal((await attempts(f.o.id))[0].state,'unknown');assert.equal((await stock(f)).reserved,2);assert.equal((await stock(g)).reserved,0);
      p.lookup=lookup;p.records.set(a.idempotency_key,p.result(a,'succeeded'));
      const original=s.finalize;s.finalize=async()=>{throw Error('Finalization unavailable');};
      try{result=await s.reconcile();assert.deepEqual(result.errors,[a.id]);assert.equal((await stock(f)).reserved,2);}
      finally{s.finalize=original;}
      await s.reconcile();assert.equal((await order(f.o.id)).state,'paid');
    });
    await t.test('database guards retain immutable attempts and reject alternative payment paths and unsafe cancellation',async()=>{
      const f=await fixture(),p=new Provider();p.mode='pending';const s=service(p),a=await s.start(context,command(f));
      const before=await snapshot();
      for(const sql of [`UPDATE ${q('payment_attempts')} SET amount=1 WHERE id=$1`,`UPDATE ${q('payment_attempts')} SET currency='USD' WHERE id=$1`,
        `UPDATE ${q('payment_attempts')} SET idempotency_key='changed' WHERE id=$1`,`UPDATE ${q('payment_attempts')} SET request_hash=NULL WHERE id=$1`,
        `DELETE FROM ${q('payment_attempts')} WHERE id=$1`])await assert.rejects(owner.query(sql,[a.id]),e=>e.code==='23514');
      await assert.rejects(db.query(`INSERT INTO ${q('payment_attempts')}(order_id,provider,provider_reference,idempotency_key,amount,currency,state)
        VALUES ($1,'forged','forged',$2,$3,'INR','succeeded')`,[a.order_id,key(),a.amount]),e=>e.code==='23514');
      assert.deepEqual(await snapshot(),before);
      await s.notification(p.token(p.result(a,'declined')));
      const mismatch=await owner.query(`SELECT s.id FROM ${q('stock_levels')} s WHERE reserved<0 OR reserved>on_hand OR reserved<>
        (SELECT coalesce(sum(quantity),0) FROM ${q('stock_reservations')} r WHERE r.stock_level_id=s.id AND state='active')`);assert.deepEqual(mismatch,[]);
      assert.equal((await owner.query(`SELECT count(*)::int n FROM ${q('payment_attempts')} WHERE state IN ('pending','unknown')`))[0].n,0);
    });
  }finally{
    if(app){await app.close();const appDb=app.get(require('typeorm').DataSource);if(appDb.isInitialized)await appDb.destroy();}
    if(db.isInitialized)await db.destroy();if(owner.isInitialized)await owner.destroy();
  }
});
