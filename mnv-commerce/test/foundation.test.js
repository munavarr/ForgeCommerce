const assert = require('node:assert/strict');
const test = require('node:test');
const { validateEnvironment } = require('../dist/config/env.validation.js');
const { SafeLogger } = require('../dist/common/safe-logger.js');

const valid = { NODE_ENV: 'test', PORT: '3100', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'mnv_commerce',
  DB_USER: 'mnv_commerce', DB_PASSWORD: 'test-secret', DB_SCHEMA: 'public', DB_POOL_SIZE: '4' };

test('rejects missing required environment values without printing their values', () => {
  assert.throws(() => validateEnvironment({ ...valid, DB_PASSWORD: '' }), /DB_PASSWORD is required/);
});

test('accepts a complete environment', () => {
  assert.doesNotThrow(() => validateEnvironment(valid));
});

test('redacts structured sensitive fields', () => {
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = value => { writes.push(value); return true; };
  try { new SafeLogger().log({ password: 'secret', token: 'secret', sql: 'SELECT $1', paymentPayload: { card: 'secret' } }); }
  finally { process.stdout.write = original; }
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /secret|SELECT/);
  assert.match(writes[0], /REDACTED/);
});

test('redacts credential URLs, error details, traces and logger context', () => {
  const writes = [], original = process.stdout.write;
  // Construct a synthetic URL without storing a credential-bearing literal in source.
  const value = ['postgresql://fixture:', 'opaque-value', '@localhost/example'].join('');
  process.stdout.write = value => { writes.push(value); return true; };
  try {
    const logger = new SafeLogger();
    logger.log({ diagnostic: value }, value);
    logger.error(new Error(value), 'opaque-value', value);
  } finally { process.stdout.write = original; }
  assert.ok(writes.every(line => !line.includes('opaque-value')));
  assert.ok(writes.every(line => JSON.parse(line).timestamp));
});
