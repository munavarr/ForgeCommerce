const assert=require('node:assert/strict');
const test=require('node:test');
const {createHash}=require('node:crypto');
const {DevelopmentPaymentProvider}=require('../dist/payments/provider');
const {validateResult}=require('../dist/payments/payments.service');
const request={attemptId:'00000000-0000-0000-0000-000000000001',orderId:'00000000-0000-0000-0000-000000000002',amount:'9007199254740993',currency:'INR',idempotencyKey:'test'};
function scenario(n){for(let i=0;;i++){const key=`development-test-${i}`;if(createHash('sha256').update(key).digest()[0]%3===n)return {...request,idempotencyKey:key};}}
test('deterministic development success, decline and lost response survive provider restart',async()=>{
  const p=new DevelopmentPaymentProvider();
  for(const [mode,state] of [[0,'declined'],[1,'succeeded'],[2,'succeeded']]){
    const r=scenario(mode),expected=await p.lookup(r);
    assert.equal(expected.state,state);
    if(mode===2)await assert.rejects(p.charge(r));
    else assert.deepEqual(await p.charge(r),expected);
    assert.deepEqual(await new DevelopmentPaymentProvider().lookup(r),expected);
    assert.equal(expected.amount,'9007199254740993');
  }
});
test('provider validation rejects mismatched identities, amounts, currency and invalid result states',()=>{
  const result={...request,provider:'test',state:'succeeded',reference:'ref'};
  assert.doesNotThrow(()=>validateResult(result,request,'test'));
  for(const extra of [{attemptId:'wrong'},{orderId:'wrong'},{idempotencyKey:'wrong'},{amount:'1'},{currency:'USD'},
    {provider:'other'},{state:'failed'},{state:'not_found'},{reference:null},{reference:''},{reference:42}])
    assert.throws(()=>validateResult({...result,...extra},request,'test'),e=>e.code==='PAYMENT_MISMATCH');
  for(const state of ['pending','unknown'])assert.doesNotThrow(()=>validateResult({...result,state,reference:null},request,'test'));
});
test('development notifications always reject, including forged success flags and test tokens',async()=>{
  const p=new DevelopmentPaymentProvider();
  for(const evidence of [null,{verified:true,...request,state:'succeeded'},{signature:'development',secret:'test'}])
    await assert.rejects(p.verifyNotification(evidence),e=>e.code==='PAYMENT_NOTIFICATION_REJECTED');
});
test('development provider refuses execution in production',async()=>{
  const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';
  try{
    const p=new DevelopmentPaymentProvider();assert.throws(()=>p.assertAvailable());
    await assert.rejects(p.charge(request));await assert.rejects(p.lookup(request));
  }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});

const {PaymentsService}=require('../dist/payments/payments.service');
const attempt={id:request.attemptId,order_id:request.orderId,amount:request.amount,currency:request.currency,
  idempotency_key:request.idempotencyKey,provider:'test',provider_reference:null,state:'pending'};
// Exercise orchestration independently of SQL; live tests verify the actual transaction/stock
// boundaries. No production test hook, signing secret or in-memory authority is installed.
function orchestrator(provider){
  let saved={...attempt},finalizations=0,uncertainties=0;
  const s=new PaymentsService({options:{schema:'public'}},{},{},provider);
  s.attempt=async()=>({...saved});
  s.unknown=async()=>{uncertainties++;if(!['succeeded','declined'].includes(saved.state))saved.state='unknown';return {...saved};};
  s.finalize=async(id,result)=>{finalizations++;saved={...saved,state:result.state,provider_reference:result.reference};return {...saved};};
  return {s,get saved(){return saved;},get finalizations(){return finalizations;},get uncertainties(){return uncertainties;}};
}
for(const state of ['succeeded','declined','pending','unknown'])test(`orchestration finalizes provider ${state} through a separate database boundary`,async()=>{
  const provider={name:'test',charge:async r=>({...r,provider:'test',reference:'ref',state})};
  const f=orchestrator(provider);assert.equal((await f.s.execute(attempt.id,'charge')).state,state);assert.equal(f.finalizations,1);
  assert.equal(f.uncertainties,0);
});
test('provider exceptions and lookup errors retain unknown outcomes without finalizing failure',async()=>{
  const provider={name:'test',charge:async()=>{throw Error('timeout');},lookup:async()=>{throw Error('unavailable');}};
  const f=orchestrator(provider);
  assert.equal((await f.s.execute(attempt.id,'charge')).state,'unknown');
  assert.equal((await f.s.reconcileAttempt(attempt.id)).state,'unknown');assert.equal(f.finalizations,0);assert.equal(f.uncertainties,2);
});
test('terminal retries do not call provider, while authoritative not-found resubmits the persisted key',async()=>{
  let charges=0,lookups=0;
  const provider={name:'test',lookup:async()=>{lookups++;return {state:'not_found'};},charge:async r=>{
    charges++;assert.deepEqual(r,request);return {...r,provider:'test',reference:'ref',state:'succeeded'};
  }};
  const f=orchestrator(provider);await f.s.reconcileAttempt(attempt.id);assert.equal(charges,1);assert.equal(lookups,1);
  await f.s.execute(attempt.id,'charge');await f.s.reconcileAttempt(attempt.id);assert.equal(charges,1);assert.equal(lookups,1);
});
test('a mismatched provider response records uncertainty and never reaches finalization',async()=>{
  const f=orchestrator({name:'test',charge:async r=>({...r,provider:'test',amount:'1',reference:'ref',state:'succeeded'})});
  await assert.rejects(f.s.execute(attempt.id,'charge'),e=>e.code==='PAYMENT_MISMATCH');assert.equal(f.saved.state,'unknown');assert.equal(f.finalizations,0);
});
test('failure after provider response leaves the durable attempt recoverable by lookup',async()=>{
  let charges=0;
  const result={...request,provider:'test',reference:'ref',state:'succeeded'};
  const f=orchestrator({name:'test',charge:async()=>{charges++;return result;},lookup:async()=>result});
  const finalize=f.s.finalize;f.s.finalize=async()=>{throw Error('Database unavailable after charge');};
  await assert.rejects(f.s.execute(attempt.id,'charge'));assert.equal(f.saved.state,'pending');assert.equal(charges,1);
  f.s.finalize=finalize;assert.equal((await f.s.reconcileAttempt(attempt.id)).state,'succeeded');assert.equal(charges,1);
});
test('notification authentication precedes all database access',async()=>{
  const s=new PaymentsService({options:{schema:'public'},query:()=>{throw Error('Database must not be accessed');}},{},{},
    {name:'test',verifyNotification:async()=>{throw Error('Signature rejected');}});
  await assert.rejects(s.notification({state:'succeeded'}),/Signature rejected/);
});
test('reconciliation continues after an item failure and reports unresolved attempts',async()=>{
  let queries=0;
  const db={options:{schema:'public'},query:async()=>queries++===0?[{id:'a'},{id:'b'},{id:'c'}]:[]};
  const s=new PaymentsService(db,{},{},{});const seen=[];
  s.reconcileAttempt=async id=>{seen.push(id);if(id==='a')throw Error('Local failure');return {state:id==='b'?'unknown':'succeeded'};};
  assert.deepEqual(await s.reconcile(),{processed:2,unresolved:1,errors:['a']});assert.deepEqual(seen,['a','b','c']);
});
