// Creates only new databases in a brand-new local cluster. Never attaches to an existing server.
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const net = require('node:net');

async function main() {
  // Select a version using PATH; fail before starting a cluster if tools are mixed.
  const versions = {};
  for (const tool of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    const result = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    const match = result.stdout?.match(/\(PostgreSQL\) (\d+)\./);
    if (result.status !== 0 || !match) throw new Error('PostgreSQL tools unavailable');
    versions[tool] = match[1];
  }
  const expected = process.env.MNV_TEST_POSTGRES_MAJOR ?? versions.postgres;
  if (!/^\d+$/.test(expected) || Object.values(versions).some(version => version !== expected)) {
    throw new Error('PostgreSQL tool versions do not match the requested major');
  }
  const root = mkdtempSync(join(tmpdir(), 'mnv-postgres-'));
  const data = join(root, 'data');
  const socket = join(root, 'socket');
  mkdirSync(socket, { mode: 0o700 });
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  function run(file, args, options = {}) {
    const result = spawnSync(file, args, { encoding: 'utf8', ...options });
    if (result.status !== 0) throw new Error(`${file} failed; isolated verification did not pass`);
    return result.stdout;
  }
  const suffix = randomBytes(6).toString('hex');
  const development = `mnv_commerce_dev_${suffix}`;
  const disposable = `mnv_commerce_test_${suffix}`;
  const workflow = `${disposable}_workflow`;
  const authentication = `${disposable}_auth`;
  const payments = `${disposable}_payments`;
  const operations = `${disposable}_operations`;
  const runtimePassword = randomBytes(32).toString('hex');
  const migrationPassword = randomBytes(32).toString('hex');
  let started = false;
  try {
    run('initdb', ['-D', data, '--username=mnv_cluster_admin', '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start']);
    started = true;
    const [identity] = JSON.parse(run('psql', ['-X', '-h', socket, '-p', String(port), '-U', 'mnv_cluster_admin', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], {
      input: `SELECT json_agg(x) FROM (SELECT current_setting('data_directory') AS data,
        current_setting('port')::int AS port, current_user AS role, current_database() AS database,
        current_setting('server_version_num')::int / 10000 AS major) x;`,
    }));
    if (realpathSync(identity.data) !== realpathSync(data) || identity.port !== port || identity.role !== 'mnv_cluster_admin' ||
        identity.database !== 'postgres' || String(identity.major) !== expected) throw new Error('Fresh cluster identity mismatch');
    run('psql', ['-X', '-h', socket, '-p', String(port), '-U', 'mnv_cluster_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: `
CREATE ROLE mnv_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE mnv_migrator LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE ${development} OWNER mnv_migrator;
COMMENT ON DATABASE ${development} IS 'mnv-commerce:development';
CREATE DATABASE ${disposable} OWNER mnv_migrator;
COMMENT ON DATABASE ${disposable} IS 'mnv-commerce:disposable-test';
CREATE DATABASE ${workflow} OWNER mnv_migrator;
COMMENT ON DATABASE ${workflow} IS 'mnv-commerce:disposable-test';
CREATE DATABASE ${authentication} OWNER mnv_migrator;
COMMENT ON DATABASE ${authentication} IS 'mnv-commerce:disposable-test';
CREATE DATABASE ${payments} OWNER mnv_migrator;
COMMENT ON DATABASE ${payments} IS 'mnv-commerce:disposable-test';
CREATE DATABASE ${operations} OWNER mnv_migrator;
COMMENT ON DATABASE ${operations} IS 'mnv-commerce:disposable-test';
` });
    const baseEnv = { ...process.env, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: String(port),
      DB_NAME: development, DB_USER: 'mnv_runtime', DB_PASSWORD: runtimePassword, DB_SCHEMA: 'public',
      DB_MIGRATION_USER: 'mnv_migrator', DB_MIGRATION_PASSWORD: migrationPassword,
      MNV_ALLOW_DESTRUCTIVE_ROLLBACK: '', MNV_ISOLATED_DEV_DATABASE: development };
    for (const command of ['show', 'run', 'run', 'show']) {
      const output = run(process.execPath, ['dist/database/migrate.js', command], { env: baseEnv });
      process.stdout.write(output);
    }
    // Verify that even explicit confirmation cannot roll back a development database.
    const rejected = spawnSync(process.execPath, ['dist/database/migrate.js', 'revert'], {
      encoding: 'utf8', env: { ...baseEnv, MNV_ALLOW_DESTRUCTIVE_ROLLBACK: development },
    });
    if (rejected.status !== 1) throw new Error('Development rollback safety check failed');
    for (const database of [disposable,workflow,authentication,payments,operations]) run('psql', ['-X', '-h', socket, '-p', String(port), '-U', 'mnv_cluster_admin', '-d', database, '-v', 'ON_ERROR_STOP=1'], {
      input: 'CREATE SCHEMA mnv AUTHORIZATION mnv_migrator;',
    });
    // Separate sequential processes: migration tests leave a migrated, empty schema for inventory.
    for (const suite of ['test/postgres.integration.js','test/inventory.postgres.integration.js']) {
      const result = spawnSync(process.execPath, ['--test', suite], {
        env: { ...baseEnv, DB_NAME: disposable, DB_SCHEMA: 'mnv' }, encoding: 'utf8',
      });
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      if (result.status !== 0) throw new Error('PostgreSQL integration suite failed');
    }
    const workflowEnv={...baseEnv,DB_NAME:workflow,DB_SCHEMA:'mnv'};
    process.stdout.write(run(process.execPath,['dist/database/migrate.js','run'],{env:workflowEnv}));
    const commerce=spawnSync(process.execPath,['--test','test/commerce.postgres.integration.js'],{env:workflowEnv,encoding:'utf8'});
    process.stdout.write(commerce.stdout??''); process.stderr.write(commerce.stderr??'');
    if(commerce.status!==0) throw new Error('Commerce PostgreSQL suite failed');
    const authEnv={...baseEnv,DB_NAME:authentication,DB_SCHEMA:'mnv'};
    process.stdout.write(run(process.execPath,['dist/database/migrate.js','run'],{env:authEnv}));
    const auth=spawnSync(process.execPath,['--test','test/auth.postgres.integration.js'],{env:authEnv,encoding:'utf8'});
    process.stdout.write(auth.stdout??''); process.stderr.write(auth.stderr??'');
    if(auth.status!==0) throw new Error('Authentication PostgreSQL suite failed');
    const paymentEnv={...baseEnv,DB_NAME:payments,DB_SCHEMA:'mnv'};
    process.stdout.write(run(process.execPath,['dist/database/migrate.js','run'],{env:paymentEnv}));
    const payment=spawnSync(process.execPath,['--test','test/payments.postgres.integration.js'],{env:paymentEnv,encoding:'utf8'});
    process.stdout.write(payment.stdout??''); process.stderr.write(payment.stderr??'');
    if(payment.status!==0) throw new Error('Payments PostgreSQL suite failed');
    const operationsEnv={...baseEnv,DB_NAME:operations,DB_SCHEMA:'mnv'};
    process.stdout.write(run(process.execPath,['dist/database/migrate.js','run'],{env:operationsEnv}));
    const operational=spawnSync(process.execPath,['--test','test/operations.postgres.integration.js'],{env:operationsEnv,encoding:'utf8'});
    process.stdout.write(operational.stdout??''); process.stderr.write(operational.stderr??'');
    if(operational.status!==0) throw new Error('Operational PostgreSQL suite failed');
    writeFileSync(join(root, 'verification.json'), JSON.stringify({ postgres: run('postgres', ['--version']).trim(),
      development, disposable, workflow, authentication, payments, operations, host: '127.0.0.1', port, result: 'passed' }, null, 2));
    process.stdout.write(`Isolated PostgreSQL verification passed. Evidence: ${join(root, 'verification.json')}\n`);
  } finally {
    // A failed/timed-out start can still leave a running server. Inspect only our fresh data directory.
    const status = spawnSync('pg_ctl', ['-D', data, 'status'], { encoding: 'utf8' });
    if (started || status.status === 0) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    process.stdout.write(`Isolated cluster stopped; files retained at ${root}\n`);
  }
}
main().catch(() => {
  process.stderr.write('Isolated PostgreSQL verification failed or could not start. Check local PostgreSQL binaries and permissions. Execution is not claimed as passed.\n');
  process.exitCode = 1;
});
