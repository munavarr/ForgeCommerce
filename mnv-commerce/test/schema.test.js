const assert = require('node:assert/strict');
const test = require('node:test');
const { minorUnitsTransformer, stringifyCommerce } = require('../dist/common/money');
const { validateEnvironment } = require('../dist/config/env.validation');
const { quoteIdentifier } = require('../dist/database/safety');
const { BigintSerializationInterceptor } = require('../dist/common/bigint-serialization.interceptor');
const { of, lastValueFrom } = require('rxjs');

test('money preserves values beyond Number.MAX_SAFE_INTEGER and rejects unsafe coercion', () => {
  const max = 9223372036854775807n;
  assert.equal(minorUnitsTransformer.from(minorUnitsTransformer.to(max)), max);
  assert.equal(minorUnitsTransformer.to(0n), '0');
  for (const invalid of [1, '1', undefined, max + 1n, -(1n << 63n) - 1n]) {
    assert.throws(() => minorUnitsTransformer.to(invalid));
  }
  assert.throws(() => minorUnitsTransformer.from(9007199254740992));
  assert.equal(stringifyCommerce({ lines: [{ price: max }] }), '{"lines":[{"price":"9223372036854775807"}]}');
});

test('HTTP interceptor serializes nested bigint amounts as decimal strings', async () => {
  const result = await lastValueFrom(new BigintSerializationInterceptor().intercept({}, {
    handle: () => of({ amount: 9007199254740993n, created: new Date('2026-01-01T00:00:00Z') }),
  }));
  assert.deepEqual(result, { amount: '9007199254740993', created: '2026-01-01T00:00:00.000Z' });
});

test('identifier and environment validation fail before unsafe SQL or incomplete configuration', () => {
  assert.throws(() => quoteIdentifier('public; DROP SCHEMA public'));
  assert.equal(quoteIdentifier('mnv'), '"mnv"');
  const env = { DB_HOST: '127.0.0.1', DB_NAME: 'mnv_commerce_test_a', DB_USER: 'mnv_runtime', DB_PASSWORD: 'secret', DB_SCHEMA: 'mnv' };
  assert.throws(() => validateEnvironment({ ...env, DB_MIGRATION_USER: 'mnv_migrator' }), /both migration credentials/);
  assert.throws(() => validateEnvironment({ ...env, DB_PORT: 'bad' }), /valid port/);
});
