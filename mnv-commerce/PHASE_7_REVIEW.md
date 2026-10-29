# MNV Commerce — Phase 7: Engineering Hardening and Independent Verification

Completed 29 October 2026 in `/Users/munavark/Downloads/vendure-master/mnv-commerce`. The sole application remains this directory. This review reports newly executed checks and source inspection; the Phase 6 statements were comparison evidence, not assumed results. **PostgreSQL 16 compatibility and production readiness remain unverified.** Work stops at Phase 7.

## 1. Verified baseline and final results

Inspected root AGENTS.md, application/source/test/script boundaries, all eight runtime dependency declarations and their lock entries, entry points, configuration, entities, all five migrations, transaction/idempotency/inventory/order/payment/authentication implementations, existing tests, README/runbooks, five historical phase reviews, and `cleanup/REVIEW.md`, `cleanup/deletions.json`, `cleanup/preserved-before.json` and `cleanup/verification.json`.

There is no root package manifest, workspace build requirement, Git repository or configured publication step. The application still declares eight runtime dependencies and three development dependencies, pinned exactly. No dependency or lockfile change was needed.

| Runtime dependency | Verified use |
| --- | --- |
| `@nestjs/common` 12.0.1 | Modules, controllers, injection, HTTP exceptions and lifecycle contract. |
| `@nestjs/core` 12.0.1 | Bootstrap, application providers and HTTP integration tests. |
| `@nestjs/platform-express` 12.3.2 | Nest's runtime HTTP adapter, loaded implicitly by Nest. |
| `argon2` 0.45.1 | Actual password hashing and verification; native implementation exercised after clean installation. |
| `pg` 8.16.3 | TypeORM's explicit PostgreSQL runtime driver. |
| `reflect-metadata` 0.2.2 | Decorator metadata at executable entry points. |
| `rxjs` 7.8.2 | HTTP bigint serialization interceptor. |
| `typeorm` 0.3.31 | DataSource, EntityManager, entities and explicit migration execution. |

Development dependencies remain TypeScript 5.8.2, ts-node 10.9.2 and @types/node 20.19.27. Executed versions: **Node 26.5.0, npm 11.17.0, PostgreSQL 18.4 (Homebrew), macOS arm64**. Minimum supported Node and other native platforms were not executed.

| Check | Unmodified baseline | Final clean-install verification |
| --- | --- | --- |
| Locked clean install | Exit 0; 220 packages installed. | Exit 0; same 220 packages, using the populated integrity-checked npm cache offline. |
| Typecheck | Exit 0. | Exit 0. |
| Build | Exit 0. | Exit 0. |
| Unit tests | **43 passed**, no failures/skips. | **44 passed**, no failures/cancellations/skips. |
| Isolated PostgreSQL | **66 reported passes**: 5 parent tests and 61 subtests. | **78 reported passes**: 6 parent tests and 72 subtests; no failures/cancellations/skips. |
| Repeat migrations | Empty status, run, repeat run and final status passed in the fresh development database. | Same sequence passed; all five migrations applied, no pending migrations; development rollback rejected. |
| Payment reconciliation | Persisted-attempt recovery and repeat CLI tests passed. | Process-kill recovery, successful-but-unacknowledged COMMIT recovery and repeat CLI tests passed. |
| npm audit | Exit 0; **0 vulnerabilities** at every severity. | Exit 0; **0 vulnerabilities** at every severity. |
| Direct dependency resolution | All 11 declarations resolved. | `npm ls --depth=0` exit 0. |
| Import/security/provenance checks | Prior records compared with actual files and fresh scans. | 59 source/test/script files, 319 import/require edges; no scan errors. Five migration digests and six original root legal digests match Phase 6. |

Final PostgreSQL counts by suite: migration **7**, inventory **17**, commerce **13**, authentication **13**, payments **22**, operations **6**. Counts include each suite's parent test; they do not represent 78 independent top-level scenarios.

Evidence is indexed in [PHASE_7_VERIFICATION.json](PHASE_7_VERIFICATION.json). Initial successful database evidence: `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-q10fLt/verification.json`. Final evidence: `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-pYRflr/verification.json`; final output: `/private/tmp/mnv-phase7-final-postgres.log`.

The final cluster used **127.0.0.1:51851**, administrator `mnv_cluster_admin`, database owner/migration role `mnv_migrator`, and unprivileged runtime `mnv_runtime`. Its databases were:

- `mnv_commerce_dev_b333f7a7d417`: development purpose marker, public schema, forward migration and rollback refusal.
- `mnv_commerce_test_b333f7a7d417`: disposable purpose marker, mnv schema, migration and inventory tests.
- The same test name with `_workflow`, `_auth`, `_payments` and `_operations` suffixes: separate fresh disposable databases for those suites.

Before provisioning, the harness verified the running server's data-directory identity, administrator, initial database, port and major version against the newly created cluster. Domain suites verified database purpose/name/owner and empty initial domain data before mutation. Separate roles, immutable evidence and restricted runtime grants were exercised. Only task-created clusters/processes were stopped; files and logs were retained outside the project. Independent `pg_ctl -D <task-data-directory> status` checks confirmed successfully started Phase 7 clusters were stopped.

### Failures and environmental limitations recorded honestly

- The first sandboxed clean install failed with registry DNS `ENOTFOUND`. A network-enabled retry succeeded; the failed attempt is not counted as a pass. Final installation succeeded offline from that cache. Initial sandbox retries reused baseline log destinations; initial failure summaries remain in this review/chat, and npm's first failure debug log remains in `/private/tmp/mnv-phase7-npm-cache/_logs/2026-10-29T05_26_05_514Z-debug-0.log`.
- The first sandboxed database harness failed before establishing the test server. A permission-enabled run of the existing fresh-cluster harness established the safe environment and passed before implementation began.
- The new logger test failed against the original implementation, demonstrating the redaction gap, and passed after repair. Evidence: `/private/tmp/mnv-phase7-redaction-before.log` and the final unit log.
- The first actual-worker crash test timed out because the parent test omitted its IPC dispatch. The harness still stopped its cluster. The test setup was corrected without weakening assertions; subsequent complete runs passed. Evidence: `/private/tmp/mnv-phase7-recovery-postgres.log` and `/private/tmp/mnv-phase7-recovery-fixed-postgres.log`.
- npm warned about deprecated transitive `glob@10.5.0` and pending install-script policy for Argon2. No arbitrary approval, audit fix or dependency upgrade was applied. Actual Argon2 hashing/verification passed; this does not validate native builds on other platforms.
- Docker's daemon socket was absent; both read-only Docker inspection commands failed. No Docker service, container, named volume or system PostgreSQL service was started/stopped. Remote CI, application container builds and deployments were not executed.

## 2. Findings by severity and evidence

Severity describes impact if this development backend were deployed, not a claim that it is currently exposed.

| Severity / status | Finding and evidence | Impact / disposition |
| --- | --- | --- |
| High / remaining deployment blocker | `src/auth/auth.module.ts` exposes registration/login; `src/auth/password.ts` performs 64 MiB Argon2 work. No application request limiter, bounded hash admission queue or account-abuse controls exist. | Public login/registration can consume CPU/memory and support credential attacks. Keep deployment private until HTTPS, trustworthy proxy handling, rate/concurrency limits and abuse tests exist. A new throttling architecture was not invented in this phase. |
| High / manual security action remains | Root SECURITY.md and Phase 6 evidence identify a previously removed Google Maps credential whose earlier source remains in the protected backup. | The credential owner must assess rotation/revocation and provider restrictions. Source deletion does not revoke it. No value was printed and no account action was attempted. |
| Medium / fixed | `src/common/safe-logger.ts` redacted by field/word pattern but emitted credential-bearing URL strings, unfiltered context and opaque trace strings. New `test/foundation.test.js` regression failed before repair. | Sanitizes context and credential URLs; suppresses Error details and raw traces. Synthetic-value regression now passes. This is defense in depth, not a guarantee that all arbitrary strings are safe. |
| Medium / fixed | `src/main.ts` had no signal hooks; the custom DataSource provider had no Nest shutdown lifecycle. Earlier integration tests manually destroyed the pool after app.close(). | Main now handles SIGINT/SIGTERM through Nest, and DatabaseModule destroys its initialized pool on application shutdown. Tests prove app.close(), actual signals and source startup close PostgreSQL connections. Listener-start failure also closes the application. |
| Medium / remaining validation gap | Only PostgreSQL 18.4 tools are installed; no available PostgreSQL 16 installation, and Docker daemon is unavailable. | PostgreSQL 16 and the pinned Compose image remain unverified. A requested-major guard prevents accidentally substituting 18.4. Reproduction is below. |
| Medium / remaining | `src/database/options.ts` sets a 3-second connection-acquisition timeout, but no statement/lock timeout or graceful drain deadline. `src/health.controller.ts` queries migration state. | A lock wait or stalled query can delay readiness and shutdown indefinitely. Choose workload-appropriate deadlines and test them before deployment; connection timeout is not a query timeout. |
| Medium / remaining | `src/database/database.module.ts` catches initial connection failure; the returned DataSource is not automatically reinitialized. | Confirmed live=200, ready=503 and catalog=503 with sanitized responses on unavailable-database startup. Restart after restoring connectivity. Later readiness checks are connectivity/migration/table checks, not a full schema/ACL/constraint audit. |
| Medium / remaining | No request ID/correlation middleware, access-log policy, automatic session cleanup or reconciliation scheduler. AuthService enforces absolute expiry but retains rows. | Diagnosis and long-running retention/recovery operations need defined policies. Expired sessions cannot authenticate. Expired reservation timestamps do not release stock, and unresolved payments must retain holds. |
| Low / retained contract | `idempotentCommand` uses application-global `commerce` and `inventory` scopes. Principal/operation/payload are in the hash, rather than in the unique key namespace. | Same key from another principal returns conflict without disclosing the first response; now explicitly tested. Clients should generate unpredictable unique keys. Any actor-scoped redesign must preserve replay of existing records and be reviewed separately. |
| Low / remaining | `LOG_LEVEL` is read into configuration but never filters SafeLogger output. | Documented honestly in README. Future level validation/filtering should be tested together with safe event metadata. |
| Informational / deployment boundary | Compose runs only a database, requires a password and binds loopback, but its bootstrap role is administrative and no application Dockerfile/healthcheck exists. | It is not an application deployment configuration. Preserve separate least-privilege runtime/migration environments; use readiness for traffic admission when a deployment is designed. |

No additional reproducible oversell, double-consume, ownership bypass or terminal-payment regression was found in the inspected service paths and executed scenarios. This is bounded evidence, not a proof for every interleaving or direct database-owner action.

## 3. Transaction and concurrency conclusions

`InventoryEngine` maintains `available = on_hand - reserved`, with database checks enforcing `0 <= reserved <= on_hand`. Triggers update counters and append ledger evidence in the same transaction; runtime cannot directly write the reserved counter or insert/mutate movement history. Final invariant queries compare every reserved counter with the sum of active reservations.

Reservation paths lock the order, canonical line IDs, catalog/location rows and stock pairs in deterministic order before writes. Payment finalization/cancellation lock the order before attempts/stock. The normal inventory paths retain sorted allocation and reservation IDs. The new deadlock deliberately uses reverse direct SQL only in a disposable test to exercise recovery; it does not introduce that order into production code.

Idempotency claims, request fingerprints, writes and normalized replay responses commit atomically. Failed work removes its claim through rollback. Authorization is checked before commerce replay; hashes include the server-derived principal and operation, so a conflicting principal/payload cannot receive another response. Completed JSON response snapshots are replayed as stored; callers needing current order state must perform an authorized read. No retention/claim takeover policy was introduced.

`inventoryTransaction` retries only SQLSTATE 40001/40P01, with at most four complete attempts, fresh QueryRunner/EntityManager/transaction and release before jittered backoff. Domain, unique, connection, rollback/release and ambiguous-commit failures are not automatically retried. Existing real serialization and failed-rollback client-eviction tests still pass with TypeORM 0.3.31; the protected PostgreSQL release path remains an upgrade-sensitive dependency.

Payment start commits the immutable request and outbound key before provider I/O. Provider calls occur outside retriable callbacks. Pending/unknown attempts prevent cancellation and release. Order locking serializes cancellation against attempt admission and terminal finalization; a cancellation that wins before admission prevents a new payment. Success/decline, order transition, reservation consumption/release and ledger writes finalize together. Duplicate/stale nonterminal evidence cannot reopen terminal attempts; conflicting terminal evidence is rejected for investigation. Expiry is an admission deadline, not evidence of provider failure or permission to release uncertain holds.

Unknown outcomes recover through durable attempts and provider lookup, with same-key resubmission only after authoritative not-found. Tests prove rollback before COMMIT and replay after a successful but unacknowledged COMMIT. The development simulator has no external funds/ledger; these checks do not establish a real provider's idempotency retention, signatures, availability, refund handling or exactly-once behavior.

## 4. Changes and new test coverage

Runtime changes are limited to [safe-logger.ts](src/common/safe-logger.ts), [database.module.ts](src/database/database.module.ts) and [main.ts](src/main.ts). No commerce algorithm, schema, migration, dependency, grant or payment-provider production behavior was changed.

The isolated harness now checks tool major versions and its actual newly started cluster identity, provisions one additional disposable operations database, runs operational tests, and checks its own data-directory status during cleanup even after a failed start. It never attaches to a supplied persistent database. [verify-boundary.js](scripts/verify-boundary.js) makes the source/lock/import/legal/migration/named-credential scans reproducible; its one computed require.resolve is the scanner resolving already-discovered literal imports and was manually reviewed. Credential-pattern scans have limited coverage and cannot certify the absence of every possible secret.

New coverage consists of **one unit test and eleven PostgreSQL subtests**:

1. Logger URL/context/Error/trace redaction, with a failing-before/passing-after regression.
2. Last-unit contention with two observed lock waiters; exactly one reservation, no failed idempotency claim, and successful same-key retry after release.
3. Genuine PostgreSQL deadlock; one whole retry with a new transaction/manager, exact final stock and only committed ledger movements.
4. Same global commerce key across two real customer sessions; conflict without foreign replay.
5. A deferred constraint trigger that fails at COMMIT after payment/order/inventory writes; exact durable snapshot rollback, followed by recovery without another provider charge.
6. Successful COMMIT followed by simulated lost acknowledgement; no automatic retry, terminal persisted evidence and harmless same-key replay/reconciliation.
7. A separately forked runtime-only worker stopped by actual SIGKILL before finalization COMMIT; PostgreSQL backend disconnect and rollback verified, then two actual reconciliation CLI invocations finalize/skip the durable attempt. The deterministic simulator response is used to reach the checkpoint; no live provider is involved.
8. app.close() destroys the actual DataSource and disconnects its observed backend without manual test pool destruction.
9. Actual built entry point handles SIGTERM and releases runtime connections.
10. Actual built entry point handles SIGINT and releases runtime connections.
11. Source entry point starts through ts-node and handles SIGTERM.
12. Actual startup with a deliberately unavailable database serves live=200, ready=503, catalog=503 and omits credentials/SQL from output.

The count is twelve numbered scenarios because item 1 is a unit test; items 2–12 are the eleven new integration subtests. Existing tests were extended without weakening assertions. [payment-crash-worker.js](test/payment-crash-worker.js) is test-only, excluded from application imports/build/container source context, receives its bearer through local IPC and emits only checkpoint metadata.

README now links this review and describes shutdown, logging limits, the six-database harness, version selection and new scenarios. All earlier reviews and cleanup records are unchanged.

## 5. PostgreSQL 16 result and safe reproduction

**Result: blocked by unavailable local PostgreSQL 16 binaries / inactive Docker daemon; compatibility is not claimed.** Read-only inspection found only `/opt/homebrew/opt/postgresql` and `/opt/homebrew/opt/postgresql@18`. `postgres --version` returned 18.4. `docker info --format '{{.ServerVersion}}'` and image enumeration could not connect to the absent daemon socket. Starting Docker could restore unrelated local containers; no daemon or service configuration was changed merely to obtain a version check.

`MNV_TEST_POSTGRES_MAJOR=16 npm run test:postgres:isolated` exited **1**, intentionally, because the selected tools were 18.4. The version guard executes before mkdtemp, initdb, listener probing or migration. This rejection is evidence of the guard, not a PostgreSQL 16 test result.

Once a trusted PostgreSQL 16 binary installation is available, use its complete bin directory without starting its default service. Replace the example path with the actual verified installation:

```sh
cd /Users/munavark/Downloads/vendure-master/mnv-commerce
PG16_BIN=/absolute/path/to/verified/postgresql-16/bin
test -x "$PG16_BIN/postgres"
"$PG16_BIN/postgres" --version
PATH="$PG16_BIN:$PATH" MNV_TEST_POSTGRES_MAJOR=16 npm run test:postgres:isolated
```

All postgres/initdb/pg_ctl/psql tools must report major 16; mismatches refuse the run. The harness creates a private fresh cluster, verifies its server/data-directory identity, provisions marked empty databases with distinct roles, and performs all migrations/reverts only there. Preserve the printed evidence and independently check that cluster's exact data directory with `"$PG16_BIN/pg_ctl" -D <printed-root>/data status` after completion; exit 3 means no server running. Do not point direct integration scripts at an existing database, set a marker on an unidentified target, reuse Compose's named volume or stop an unrelated service. Provisioning the missing binary installation is a remaining prerequisite, not a command executed in this phase.

## 6. Remaining security and operational limits

- Development payment simulation only; no public payment route, live adapter, permissive webhook, credential or real funds. Production simulation/CLI execution refusal still passes. Legacy attempts remain explicit review evidence, not automatically adopted recovery requests.
- Before public deployment: HTTPS, bounded authentication work, rate/abuse controls, reviewed proxy trust/access-log redaction and secret-management separation. No MFA, email verification/recovery, password reset or capacity benchmark was added.
- Define statement/lock/provider deadlines, a graceful drain budget, startup restart policy and ongoing schema/ACL monitoring. Current liveness is process-only, and readiness is intentionally narrower than full commerce/provider health.
- Define privacy/retention policy for expired/revoked sessions and idempotency records. Runtime cannot delete session rows. Preserve evidence and replay guarantees; cleanup needs a separately reviewed privileged/forward-migration design. Do not indiscriminately delete order/payment/history data.
- Reconciliation is explicit, page-bounded and restartable, with no scheduler/alerting service. Exit 0 indicates no unresolved/errors encountered by that scan, 2 requires investigation, and 1 indicates configuration/command failure. Attempts committed behind the keyset cursor need the next invocation. No expiry worker can safely release unresolved-payment holds merely because time passed.
- Request correlation/access logging, meaningful safe error/event codes and LOG_LEVEL filtering remain future operational work. Redaction patterns cannot sanitize every arbitrary opaque value; keep credentials, bearer/session responses and provider payloads out of all logs.
- No application Dockerfile/healthcheck, production image, remote CI execution, PostgreSQL 16 run, minimum-Node run, failover/load benchmark, backup restore drill, fulfillment/refunds/returns integration or production deployment was validated.
- Existing root/application GPL notices, GPL-3.0-or-later terms, Vendure copyright/attribution and upstream exception/legal records are preserved. Historical/legal references and the safety comment rejecting unrelated targets are not executable Vendure dependencies. Dependency funding/repository metadata in the npm lockfile are not configured telemetry endpoints.
- The protected original backup was not modified, moved, extracted or deleted. A read-only SHA-256 comparison matches the Phase 6 digest and its mode remains 0400. It remains private and outside source/build/CI context. The owner must complete the outstanding Google Maps credential assessment/rotation/restrictions; no key is reproduced here and no account changes were attempted.

## 7. Exact commands and evidence

Commands ran from the application directory unless marked read-only environment inspection. Shell output was redirected to local files, with no credentials passed in command arguments. Network access was used only for locked public npm downloads and requested advisory queries; project files were not uploaded or published.

```sh
cd /Users/munavark/Downloads/vendure-master/mnv-commerce
node --version
npm --version
postgres --version
npm ci --cache /private/tmp/mnv-phase7-npm-cache --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000
npm run typecheck
npm run build
npm test
npm run test:postgres:isolated
npm audit --json --cache /private/tmp/mnv-phase7-npm-cache --fetch-retries=0 --fetch-timeout=20000
npm ls --depth=0
node scripts/verify-boundary.js
```

The final repeat used:

```sh
npm ci --offline --cache /private/tmp/mnv-phase7-npm-cache --no-audit --no-fund
npm run typecheck
npm run build
npm test
node scripts/verify-boundary.js
npm ls --depth=0
npm run test:postgres:isolated
npm audit --json --cache /private/tmp/mnv-phase7-npm-cache --fetch-retries=0 --fetch-timeout=20000
```

Each final command exited 0. A fresh machine without the populated cache should use the first install command (or ordinary `npm ci`), not the offline repeat. The harness executes `node dist/database/migrate.js show`, `run`, `run`, `show`, and rejects `revert` for its development target; disposable migration tests exercise guarded rollback/reapplication. Recovery tests execute `node dist/payments/reconcile.js` repeatedly with child-process runtime environments. These are the implementations behind `npm run migration:*` and `npm run payment:reconcile`; no operator command was pointed at a persistent database.

Final logs: `/private/tmp/mnv-phase7-final-ci.log`, `mnv-phase7-final-typecheck.log`, `mnv-phase7-final-build.log`, `mnv-phase7-final-unit.log`, `mnv-phase7-final-postgres.log`, `mnv-phase7-final-audit.json`, `mnv-phase7-final-boundary.json` and `mnv-phase7-final-dependencies.log` (all under `/private/tmp/`). Temporary evidence is retained but may be removed by the operating system; the sanitized summary is retained with this review. All pre-existing phase reviews and cleanup evidence remain unchanged.

## 8. Prioritized recommendation for the next phase

1. Complete the owner's Google Maps credential action and implement/test authentication rate and concurrent-work admission controls before any public exposure. Choose actual deployment trust boundaries and HTTPS/logging policy first.
2. Provision verified PostgreSQL 16 binaries or a dedicated disposable CI runner and execute this exact guarded harness; also validate the supported minimum Node/native installation. Resolve evidence gaps before asserting support.
3. Add operational deadlines, request correlation/safe event codes, startup/restart behavior and bounded graceful shutdown. Exercise database outages, slow/locked queries and service recovery under load.
4. Design reconciliation scheduling/alerts and session/evidence retention without weakening pending-payment holds, immutable history or idempotency replay. Validate restoration from backups on a newly isolated environment.
5. Only after those controls, separately specify any live payment adapter, signature/idempotency windows, conflicting terminal-result investigation and refund process. Keep development simulation unavailable in production.

No next phase, Git initialization, publication, upload, persistent migration or credential-account operation was started.
