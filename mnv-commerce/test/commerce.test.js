const assert = require('node:assert/strict');
const test = require('node:test');
const { PricingPolicy } = require('../dist/commerce/pricing');
const dto = require('../dist/commerce/commerce.dto');
const { CommerceAccess, PaymentResultVerifier } = require('../dist/commerce/access');
const { CatalogService } = require('../dist/commerce/catalog.service');
const { OrdersService } = require('../dist/commerce/orders.service');
const { InventoryEngine: InventoryService } = require('../dist/inventory/inventory.engine');

test('canonical minor-unit prices reject coercion, negative values, fractions and overflow', () => {
  for (const value of [-1, 1, 1.5, '1.5', '-1', '01', ' 1', '', '9223372036854775808', null]) assert.throws(()=>dto.money(value));
  for (const value of ['0', '9007199254740993', '9223372036854775807']) assert.equal(dto.money(value),value);
  for (const value of ['usd', 'US', 123]) assert.throws(()=>dto.currency(value));
});
test('exclusive aggregate tax rounds half-up exactly; shipping is flat and untaxed', () => {
  const policy = new PricingPolicy({currency:'INR',taxBasisPoints:500,shipping:'7',reservationSeconds:60});
  const calc = n=>policy.calculate([{unit_price:String(n),quantity:1}]);
  assert.equal(calc(9).tax,'0'); assert.equal(calc(10).tax,'1'); assert.equal(calc(11).tax,'1');
  assert.equal(calc(10).total,'18');
  assert.equal(policy.calculate([{unit_price:'5',quantity:1},{unit_price:'5',quantity:1}]).tax,'1');
  assert.equal(policy.calculate([]).total,'0');
  assert.equal(new PricingPolicy().calculate([{unit_price:'9007199254740993',quantity:1}]).total,'9007199254740993');
  assert.throws(()=>policy.calculate([{unit_price:'9223372036854775807',quantity:1}]));
  for (const config of [{taxBasisPoints:1.5},{taxBasisPoints:-1},{taxBasisPoints:10001},{shipping:'-1'},{reservationSeconds:0}]) {
    assert.throws(()=>new PricingPolicy({currency:'INR',taxBasisPoints:0,shipping:'0',reservationSeconds:60,...config}));
  }
});
test('production access and payment verification fail closed before database access', async () => {
  const db={options:{schema:'public'},query:()=>{throw Error('Database must not be accessed');}};
  const access=new CommerceAccess(), catalog=new CatalogService(db,access);
  const orders=new OrdersService(db,access,catalog,new InventoryService(db),new PricingPolicy(),new PaymentResultVerifier());
  for (const context of [null,{}, {userId:'00000000-0000-0000-0000-000000000001',role:'admin'}]) {
    await assert.rejects(catalog.createProduct(context,{}),e=>e.code==='FORBIDDEN');
    await assert.rejects(orders.createDraft(context,{key:'x'}),e=>e.code==='FORBIDDEN');
  }
  await assert.rejects(orders.recordPayment({key:'x',evidence:{outcome:'succeeded'}}),e=>e.code==='PAYMENT_VERIFIER_UNAVAILABLE');
});
test('transaction-scoped inventory rejects unbound or inactive managers', async () => {
  const db={options:{schema:'public'}};
  const service=new InventoryService(db);
  await assert.rejects(service.reserveStock({key:'x',actor:'actor',reason:'test',orderId:'00000000-0000-0000-0000-000000000001',
    expiresAt:new Date(Date.now()+60000).toISOString(),items:[{lineId:'00000000-0000-0000-0000-000000000002',variantId:'00000000-0000-0000-0000-000000000003',locationId:'00000000-0000-0000-0000-000000000004',quantity:1}]},
  {connection:db,queryRunner:{isTransactionActive:false}}),e=>e.code==='INVALID_TRANSACTION');
});
test('initial lifecycle permits only guarded forward and cancellation paths', () => {
  const {assertOrderTransition,lifecycleName}=require('../dist/commerce/states');
  const allowed=new Set(['draft:placed','draft:cancelled','placed:paid','placed:cancelled']);
  for(const from of ['draft','placed','paid','cancelled','fulfilled','unknown'])
    for(const to of ['draft','placed','paid','cancelled','fulfilled','unknown']) {
      if(allowed.has(`${from}:${to}`)) assert.doesNotThrow(()=>assertOrderTransition(from,to));
      else assert.throws(()=>assertOrderTransition(from,to),e=>e.code==='ORDER_STATE');
    }
  assert.equal(lifecycleName('placed'),'PaymentPending');
});
test('catalog DTOs reject unknown fields and invalid SKUs before starting a transaction', async () => {
  const db={options:{schema:'public'},createQueryRunner:()=>{throw Error('No transaction should start');}};
  class Access extends CommerceAccess { async catalogManager(){return {actor:'unit:catalog'};} }
  const service=new CatalogService(db,new Access());
  const productId='00000000-0000-0000-0000-000000000001';
  const valid={key:'key',sku:'SKU',name:'Variant',price:'10',currency:'INR',active:true,archived:false};
  for(const extra of [{sku:''},{sku:' SKU'},{sku:'SKU '},{sku:'x'.repeat(201)},{sku:1},{price:10},{quantity:2}])
    await assert.rejects(service.createVariant(null,productId,{...valid,...extra}),e=>e.getStatus()===400);
});
