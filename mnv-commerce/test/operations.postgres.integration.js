const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { NestFactory } = require('@nestjs/core');
const { DataSource } = require('typeorm');
const { AppModule } = require('../dist/app.module');
const { createDataSource } = require('../dist/database/options');
const { verifyDatabaseIdentity, migrationStatus, quoteIdentifier } = require('../dist/database/safety');
const { commerceTables } = require('../dist/database/tables');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function within(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Child process did not exit in time')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test('operational lifecycle on verified isolated PostgreSQL', { timeout: 60000 }, async t => {
  const owner = createDataSource(true);
  let app;
  try {
    await owner.initialize();
    const identity = await verifyDatabaseIdentity(owner, true);
    assert.equal(identity.owner, process.env.DB_MIGRATION_USER);
    assert.equal(identity.role, identity.owner);
    assert.equal((await migrationStatus(owner)).ready, true);
    const q = name => `${quoteIdentifier(process.env.DB_SCHEMA)}.${quoteIdentifier(name)}`;
    for (const table of commerceTables) assert.equal((await owner.query(`SELECT count(*)::int n FROM ${q(table)}`))[0].n, 0, 'Fresh operations database required');
    console.log(JSON.stringify({ operationalIdentity: identity }));
    const connections = async () => (await owner.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND usename=$1`, [process.env.DB_USER]))[0].n;

    await t.test('app.close destroys the actual pool and closes its PostgreSQL backend', async () => {
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      const db = app.get(DataSource), [{ pid }] = await db.query('SELECT pg_backend_pid() pid');
      assert.equal((await fetch((await app.getUrl()) + '/health/ready')).status, 200);
      await app.close(); app = undefined;
      assert.equal(db.isInitialized, false, 'Nest lifecycle must destroy the DataSource without manual test cleanup');
      for (let i = 0; i < 100; i++) {
        const [{ connected }] = await owner.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1) connected', [pid]);
        if (!connected) break;
        if (i === 99) assert.fail('Closed pool backend still connected');
        await delay(10);
      }
    });

    async function processCheck(signal, unavailable = false, source = false) {
      const port = await unusedPort();
      const env = { ...process.env, PORT: String(port) };
      delete env.DB_MIGRATION_USER; delete env.DB_MIGRATION_PASSWORD;
      // Before the HTTP listener starts, this freshly probed port has no database server.
      if (unavailable) env.DB_PORT = String(port);
      const child = spawn(process.execPath, source ? ['--require', 'ts-node/register', 'src/main.ts'] : ['dist/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', bytes => output += bytes);
      child.stderr.on('data', bytes => output += bytes);
      const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      try {
        let live = false;
        for (let i = 0; i < 150; i++) {
          if (child.exitCode !== null || child.signalCode !== null) assert.fail('Application exited before health check');
          try { live = (await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(300) })).status === 200; } catch {}
          if (live) break;
          await delay(50);
        }
        assert.ok(live, 'Actual entry point must expose liveness');
        const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
        assert.equal(ready.status, unavailable ? 503 : 200);
        if (unavailable) {
          assert.deepEqual(await ready.json(), { status: 'unready', database: 'unavailable' });
          assert.equal((await fetch(`http://127.0.0.1:${port}/catalog`)).status, 503);
        } else assert.ok(await connections() > 0);
        child.kill(signal);
        const result = await within(exited, 8000);
        assert.ok(result.code === 0 || result.signal === signal, 'Expected graceful signal termination');
        assert.equal(await connections(), 0, 'Entry point must release all runtime connections');
        for (const secret of [process.env.DB_PASSWORD, process.env.DB_MIGRATION_PASSWORD]) assert.ok(!output.includes(secret), 'Logs must exclude configured credentials');
        assert.doesNotMatch(output, /QueryFailedError|SELECT .*FROM/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await within(exited, 8000);
      }
    }
    await t.test('SIGTERM drains the actual entry point and closes its pool', () => processCheck('SIGTERM'));
    await t.test('SIGINT drains the actual entry point and closes its pool', () => processCheck('SIGINT'));
    await t.test('source entry point starts through ts-node and closes on SIGTERM', () => processCheck('SIGTERM', false, true));
    await t.test('unavailable startup database leaves live=200 ready=503 with sanitized failures', () => processCheck('SIGTERM', true));
  } finally {
    if (app) await app.close();
    if (owner.isInitialized) await owner.destroy();
  }
});
