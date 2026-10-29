# Phase 1 migration review and verification

Completed 28 October 2026. Scope: the existing `mnv-commerce/` application only. No Git repository was initialized, nothing was published, no Vendure package was removed, and no existing database or Docker volume was modified.

## Exact migration and supporting files

The single migration is **`src/database/migrations/1793145600000-initial-commerce.ts`**, class/name `InitialCommerce1793145600000`. Its explicit `up()` creates 13 tables, indexes and append-only triggers; `down()` reverses them in dependency order without CASCADE.

| Files | Purpose |
| --- | --- |
| `src/database/entities/commerce.entity.ts` | All 13 domain scalar mappings; bigint monetary properties. |
| `src/database/options.ts`, `src/database/data-source.ts` | Shared runtime/tooling options, explicit class registration, separate migration credentials; synchronization and automatic migrations disabled. |
| `src/database/migrate.ts`, `src/database/safety.ts`, `src/database/tables.ts` | Explicit commands, database identity/known-object guards, advisory lock, transactional migration/grants, status, least-privilege runtime grants and rollback gates. |
| `src/common/money.ts`, `src/common/bigint-serialization.interceptor.ts`, `src/common/safe-logger.ts` | Strict bigint transformations and decimal-string JSON serialization. |
| `src/config/configuration.ts`, `src/config/env.validation.ts`, `.env.example` | Shared validation, safe identifiers and paired migration credentials. |
| `src/app.module.ts`, `src/health.controller.ts` | Connection initialization without schema writes; readiness reflects migration history and table existence. |
| `package.json` | Explicit compiled migration commands, environment loading and PostgreSQL integration commands. Development uses ts-node so Nest decorator metadata is preserved. |
| `scripts/test-postgres-isolated.js`, `test/postgres.integration.js`, `test/schema.test.js` | Isolated provisioning and live/static verification. Existing `test/foundation.test.js` retained. |
| `README.md`, `MIGRATION_REVIEW.md` | Operations, schema decisions, destructive rollback restrictions and evidence. |

`package-lock.json` was inspected and retained without dependency changes: lockfile v3, TypeORM 0.3.28, pg 8.16.3. `npm ls --depth=0` resolved all pinned dependencies successfully. The foundation contained no domain entities and only a migration-directory `.gitkeep`; its CLI pointed at compiled globs while accepting a source data source. Explicit class registration now gives the app and migration commands the same schema model. The existing Docker Compose file/volume was retained and not started; its bootstrap user is not suitable as the runtime role. Provision distinct roles before using any newly identified Docker database.

Final checks also compared the package manifest's dependency/dev-dependency/engine fields to the lockfile root (identical), loaded the TypeScript health controller with `node --env-file-if-exists=.env --require ts-node/register` and verified its reflected DataSource injection metadata, and ran `pg_ctl ... status` for the preliminary and final clusters (both reported no server running). The optional environment-file flag is available at the existing Node 20.19 minimum, as documented in the [Node 20.19 CLI reference](https://nodejs.org/download/release/v20.19.0/docs/api/cli.html#--env-file-if-existsconfig); live tests used Node 26.5.0.

## Static review

- UUID primary keys, timezone-aware timestamps, JSONB replay bodies, integer stock quantities, uppercase currency format checks and explicit state checks. No extension, speculative feature tables or payment-card data added.
- Four monetary columns use PostgreSQL bigint: variant `price`, order `total`, line `unit_price`, payment `amount`. Repository properties use TypeScript bigint and reject unsafe numeric coercion; HTTP/log serialization emits decimal strings. Raw SQL bigint results remain driver strings.
- Unique SKU, email, session token hash, stock-location code, variant/location pair, order code, payment idempotency key/provider reference, and scoped request-idempotency key constraints. Session tokens and idempotency request hashes require 64-character lowercase hex digests.
- Every FK is ON DELETE RESTRICT with a leading-column supporting index. Archiving preserves references. Deleting a referenced catalog entity fails; deleting an unreferenced entity is permitted. Order lines retain catalog name/SKU/price snapshots. Stock movements and order transitions reject UPDATE, DELETE and TRUNCATE using statement triggers.
- Runtime role has no schema creation privileges or administrative ownership. It cannot truncate, write migration metadata, delete orders/lines/payments, or mutate/delete movement/transition history. Migration credentials are never used by application startup.
- Name guard runs before connection. Before mutation, identity checks read actual database name, database comment, owner, login role, server address/port and all user table/view/sequence names; unknown targets/objects are rejected. Commands log only non-secret identity/status fields and sanitize failures.
- Forward migration, bookkeeping and runtime grants share a transaction; supported commands share a session advisory lock. `migration:show` does not create a bookkeeping table. Startup never synchronizes or migrates.
- `down()` destroys commerce data and is intentionally limited to a uniquely suffixed, purpose-marked disposable test database plus exact environment confirmation. It leaves the bookkeeping table/schema and does not restore prior schema ACLs. No destructive operational rollback is offered for development data.

The SQL follows [TypeORM's explicit migration model](https://typeorm.io/docs/migrations/executing/) and PostgreSQL's documented [UPDATE/DELETE/TRUNCATE statement-trigger behavior](https://www.postgresql.org/docs/16/sql-createtrigger.html). These sources informed review; the test results below came from a real local PostgreSQL server.

## Commands actually run

Initial inspection included `git status --short` (the supplied checkout is not a Git repository), source/config/script/lockfile reads, `command -v docker psql postgres pg_ctl initdb node npm`, `postgres --version`, `initdb --version`, `docker info --format '{{.ServerVersion}}'`, and `pg_isready -h 127.0.0.1 -p 5432`.

Docker could not reach its daemon socket. The default local PostgreSQL port reported no response. Neither was treated as a verified database. Local PostgreSQL 18.4 binaries were available. A new preliminary cluster was initialized under `/private/tmp/mnv-phase1/cluster.cwJDlv/` on port 55487, then stopped without migrating or touching any other cluster. Initial sandboxed `initdb` failed because shared memory was prohibited; the authorized run outside that restriction succeeded.

From `mnv-commerce/`:

```sh
npm ls --depth=0
npm run typecheck
npm test
npm run test:postgres:isolated
```

The harness uses explicit `initdb`, `pg_ctl`, and `psql -X ... -v ON_ERROR_STOP=1` commands against its **new** temporary data/socket directory. Role passwords are random, generated in memory and passed to provisioning via stdin; they are not printed. It then invokes:

```sh
node dist/database/migrate.js show
node dist/database/migrate.js run
node dist/database/migrate.js run
node dist/database/migrate.js show
node dist/database/migrate.js revert   # rejected for development
node --test test/postgres.integration.js
```

The integration suite invokes the same migration runner for empty status, application, repeated application, expected safe rejections, confirmed disposable rollback and reapplication. It also starts the compiled Nest application on an ephemeral loopback HTTP port and exercises readiness. No schema synchronization is used.

## Live PostgreSQL evidence

Final passing run: PostgreSQL **18.4 (Homebrew)**, Node **26.5.0**, fresh temporary cluster at `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-AnZPUW/`, listening only on **127.0.0.1:51460** during tests.

| Verified identity | Development | Disposable test |
| --- | --- | --- |
| Database | `mnv_commerce_dev_1001390f0575` | `mnv_commerce_test_1001390f0575` |
| Database owner | `mnv_migrator` | `mnv_migrator` |
| Purpose comment | `mnv-commerce:development` | `mnv-commerce:disposable-test` |
| Schema | `public` | `mnv` |
| Mutation role | `mnv_migrator` | `mnv_migrator` |
| Runtime/status role | `mnv_runtime` | `mnv_runtime` |

Actual server identity queries returned `127.0.0.1/32`, port 51460, the exact expected database names, owners, login roles and purpose comments. The harness created both databases in its own new cluster. The integration suite additionally required zero initial tables and rejected an unmarked database, an unrelated database name and an inserted unidentified table before migration.

| Verification | Result |
| --- | --- |
| TypeScript build/type checking | Passed. |
| Foundation and unit tests | 6 passed, 0 failed. |
| PostgreSQL integration | 7 reported passes (parent plus 6 subtests), 0 failed/skipped. |
| Empty migration and inspection | 13 domain tables + 1 bookkeeping table; 13 restrictive FKs; 40 CHECK constraints; 9 UNIQUE constraints; 38 indexes including PK/unique indexes. No FK missing a leading-column index. |
| Second migration run | No pending migration; schema column/constraint/index snapshot identical. |
| Status/readiness | Empty database 503/pending without DDL; migrated database 200/ready; missing expected table or unknown migration entry 503. Unknown history also blocks migration mutation. |
| Money | All four PostgreSQL column types bigint; exact repository round trips at 9007199254740993; decimal-string serialization; numeric coercion and out-of-range writes rejected. |
| Integrity | Duplicate SKU/stock pair/payment key, invalid references/states/currency/quantities/amounts and incomplete idempotency responses rejected. Concurrent identical idempotency inserts yielded exactly one success and one unique violation. |
| History/privileges | Archive retained line snapshots/history. Referenced catalog deletion rejected. Owner and runtime history mutation/truncation rejected. Runtime schema CREATE and order DELETE rejected. |
| Rollback | Development rollback rejected even with exact name confirmation. Disposable rollback rejected without confirmation; confirmed rollback removed all 13 domain tables. Reapplication restored empty tables and HTTP readiness. |

Machine-readable success evidence remains at `.../mnv-postgres-AnZPUW/verification.json`; cluster files/server log are retained locally. All task-created PostgreSQL clusters have been stopped. Passwords were never printed or written to the review record.

The first live suite exposed an unprivileged pre-migration status lookup and two mistaken test expectations (FK count and PostgreSQL 18 RESTRICT error code). Those were corrected. The full suite then passed and was rerun successfully after adding missing-table and unknown-history checks. Earlier failed executions are not counted as passed.

## Remaining limitations

- Docker/PostgreSQL 16 container execution was unavailable; live verification used local PostgreSQL 18.4. No persistent application-development database was provisioned outside the isolated test cluster.
- Rollback erases data, is disposable-only, and does not restore schema ACLs. Restoring business records requires backups or a forward corrective migration.
- Readiness verifies connectivity, exact known migration history and expected table existence; it does not continuously audit every constraint/index/privilege. Restart the application after an initial database connection failure.
- Scalar entity metadata intentionally omits schema constraints/navigation relations; the reviewed explicit migration is authoritative. Do not run schema generation/synchronization from those mappings.
- Commerce service invariants (stock concurrency, line/stock matching, allowed transitions, totals, payment reconciliation, idempotency ownership/retention) remain outside this migration milestone. Tests establish storage constraints and migration behavior, not complete checkout correctness.
