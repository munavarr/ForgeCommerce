const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { passwordInput, hashPassword, verifyPassword } = require('../dist/auth/password');
const { AuthService, credentials, tokenDigest } = require('../dist/auth/auth.service');
const { CommerceAccess, PaymentResultVerifier } = require('../dist/commerce/access');
const { InventoryService } = require('../dist/inventory/inventory.service');
const { OrdersService } = require('../dist/commerce/orders.service');
const { SafeLogger } = require('../dist/common/safe-logger');
const password = 'a long private passphrase';

test('credentials validate before hashing and reject role, verification, ownership and unknown fields', () => {
  assert.deepEqual(credentials({email:'Person@MNV.invalid',password}),{email:'person@mnv.invalid',password});
  for (const extra of [{role:'administrator'},{id:'forged'},{userId:'forged'},{email_verified_at:new Date()},{password_hash:'forged'}])
    assert.throws(()=>credentials({email:'person@mnv.invalid',password,...extra}));
  for (const email of ['',null,1,'x',' a@b.invalid','a@b.invalid ','a@@b.invalid','a @b.invalid','x'.repeat(255)+'@a.invalid'])
    assert.throws(()=>credentials({email,password}));
});
test('passwords enforce character and UTF-8 byte limits without truncation or normalization', () => {
  for (const value of [null,1,'x'.repeat(14),'😀'.repeat(257),'a'.repeat(1025),'a'.repeat(15)+'\ud800']) assert.throws(()=>passwordInput(value));
  for (const value of ['a'.repeat(15),'a'.repeat(1024),'😀'.repeat(256),'  deliberately spaced password  ']) assert.equal(passwordInput(value),value);
});
test('Argon2id uses random salts, secure costs and compares all bytes including beyond bcrypt limits', async () => {
  const long = 'é'.repeat(64)+'suffix';
  const [a,b] = await Promise.all([hashPassword(long),hashPassword(long)]);
  assert.notEqual(a,b); assert.match(a,/^\$argon2id\$v=19\$/);
  assert.deepEqual(a.split('$')[3].split(',').sort(),['m=65536','p=1','t=3']);
  assert.equal(await verifyPassword(a,long),true);
  assert.equal(await verifyPassword(a,'é'.repeat(64)+'changed'),false);
  assert.equal(await verifyPassword(a,long+' '),false);
  assert.equal(await verifyPassword('legacy-invalid-hash',long),false);
  assert.equal(await verifyPassword(a,'a'.repeat(1025)),false);
});
test('native hashing accepts the full maximum input and preserves embedded NUL bytes', async () => {
  const maximum='😀'.repeat(256), hash=await hashPassword(maximum);
  assert.equal(await verifyPassword(hash,maximum),true);
  assert.equal(await verifyPassword(hash,'😀'.repeat(255)+'😁'),false);
  const nul='long private password\0suffix', nulHash=await hashPassword(nul);
  assert.equal(await verifyPassword(nulHash,nul),true);
  assert.equal(await verifyPassword(nulHash,nul.split('\0')[0]),false);
});
test('bearer parser accepts canonical opaque tokens and hashes only the token', () => {
  const token=Buffer.alloc(32,17).toString('base64url');
  assert.equal(tokenDigest(`Bearer ${token}`),createHash('sha256').update(token).digest('hex'));
  for (const value of [null,{},['Bearer '+token],{userId:'id',role:'administrator'},token,'Basic '+token,'Bearer '+token+'=', 'Bearer  '+token,'Bearer '+token+'\n'])
    assert.throws(()=>tokenDigest(value),e=>e.getStatus()===401);
});
test('login rejects incorrect, missing and archived credentials with the same public response', async () => {
  const hash=await hashPassword(password);let rows=[{id:'id',email:'unit@mnv.invalid',role:'customer',password_hash:hash,archived_at:null}];
  const auth=new AuthService({options:{},query:async()=>rows,createQueryRunner(){throw Error('Invalid credentials must never issue a session');}});
  let response;
  for(const fixture of [rows,[],[{...rows[0],archived_at:new Date()}]]) {
    rows=fixture;
    await assert.rejects(auth.login({email:'unit@mnv.invalid',password:fixture.length && fixture[0].archived_at ? password : password+'wrong'}),error=>{
      assert.equal(error.getStatus(),401);
      response ??= error.getResponse();assert.deepEqual(error.getResponse(),response);return true;
    });
  }
});
test('sessions reject expired, revoked, archived or unknown results and sanitize database errors', async () => {
  const context='Bearer '+Buffer.alloc(32,18).toString('base64url');
  const auth=new AuthService({options:{},manager:{query:async()=>[]}});
  await assert.rejects(auth.authenticate(context),e=>e.getStatus()===401);
  const broken=new AuthService({options:{},manager:{query:async()=>{throw Error('password and bearer secret');}}});
  await assert.rejects(broken.authenticate(context),e=>e.getStatus()===503 && !JSON.stringify(e).includes('secret'));
});
test('roles cannot be supplied by callers and authenticated customers cannot administer catalog/inventory', async () => {
  const access=new CommerceAccess({authenticate:async context=>{
    if(context!=='trusted') throw Error('invalid context');
    return {userId:'customer-id',role:'customer'};
  }});
  assert.deepEqual(await access.customer('trusted'),{userId:'customer-id'});
  await assert.rejects(access.catalogManager('trusted'),e=>e.getStatus()===403);
  const inventory=new InventoryService({},access,{});
  for (const action of ['createLocation','manageLocation','initializeStock','adjustStock'])
    await assert.rejects(inventory[action]('trusted',{actor:'administrator',role:'administrator'}),e=>e.getStatus()===403);
  const admin=new CommerceAccess({authenticate:async()=>({userId:'admin-id',role:'administrator'})});
  assert.deepEqual(await admin.catalogManager('trusted'),{actor:'admin-id'});
  await assert.rejects(admin.customer('trusted'),e=>e.getStatus()===403);
});
test('no identity object can access orders and no ordinary evidence can confirm payment', async () => {
  const db={options:{}}, access=new CommerceAccess();
  const orders=new OrdersService(db,access,{}, {}, {}, new PaymentResultVerifier());
  for(const context of [null,{}, {role:'administrator',userId:'owner'}]) {
    await assert.rejects(orders.createDraft(context,{key:'x'}),e=>e.getStatus()===403);
    await assert.rejects(orders.read(context,'forged'),e=>e.getStatus()===403);
  }
  await assert.rejects(orders.recordPayment({key:'x',evidence:{paid:true,outcome:'succeeded',verified:true}}),e=>e.code==='PAYMENT_VERIFIER_UNAVAILABLE');
});
test('registration returns an allowlisted user projection and binds no privilege or plaintext columns', async () => {
  let params,query;
  const auth=new AuthService({options:{},query:async(sql,args)=>{query=sql;params=args;return [{id:'id',email:'unit@mnv.invalid',role:'customer',email_verified_at:null}];}});
  const user=await auth.register({email:'unit@mnv.invalid',password});
  assert.equal(params[0],'unit@mnv.invalid');assert.notEqual(params[1],password);assert.match(params[1],/^\$argon2id/);
  assert.match(query,/RETURNING id,email,role,email_verified_at/);assert.equal(user.email_verified_at,null);
  assert.equal(user.password_hash,undefined);
});
test('sensitive structured headers, cookies, errors and authentication payloads are redacted', () => {
  const writes=[],original=process.stdout.write;process.stdout.write=value=>{writes.push(value);return true;};
  try {new SafeLogger().error({headers:{authorization:'secret-a',cookie:'secret-b'},password:'secret-c',token:'secret-d',parameters:['secret-e']});}
  finally {process.stdout.write=original;}
  assert.doesNotMatch(writes.join(''),/secret-[abcde]/);
});
