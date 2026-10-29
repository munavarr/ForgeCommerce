# MNV Commerce — Phase 8: PostgreSQL 16 Compatibility Verification

Completed 29 October 2026 in `/Users/munavark/Downloads/vendure-master/mnv-commerce`.

**Result: the complete existing isolated PostgreSQL suite passes on PostgreSQL 16.15 (Homebrew).** A second PostgreSQL 16 run and a fresh PostgreSQL 18.4 comparison also pass. This establishes compatibility for these migrations and tested application behaviours in the environment below; it does not establish production readiness or every PostgreSQL 16 patch/platform combination.

## Environment and provisioning

Read `PHASE_7_REVIEW.md` first, then inspected the isolated harness, guarded migration CLI, database options/safety code, all five migration sources and integration test coverage before running database tests. `synchronize` and `migrationsRun` remain false. No migration, production configuration, dependency, lockfile or application/test source changed.

Environment: Darwin arm64, Node 26.5.0, npm 11.17.0. PostgreSQL 16 was initially absent from Homebrew opt; Docker inspection still failed because its daemon socket was absent. No Docker daemon was started.

Provisioned using `HOMEBREW_NO_AUTO_UPDATE=1 brew install postgresql@16` (exit 0), with network/filesystem permission. Installed Homebrew formula 16.15_1; `postgres --version` reports `postgres (PostgreSQL) 16.15 (Homebrew)`. Used `/opt/homebrew/opt/postgresql@16/bin` through command-local PATH. No global linking or service start was performed. Homebrew also installed openssl@4 4.0.3 and upgraded ca-certificates to 2026-09-25, krb5 to 1.22.2_2, readline to 8.3.6 and xz to 5.8.4. These are local package-manager effects, not application dependency changes.

Homebrew's postinstall initialized `/opt/homebrew/var/postgresql@16`; it was not used for testing, started, or subsequently modified/deleted by this phase. The installation and that directory are retained; no package uninstall or broad cleanup was attempted.

## Isolation and safety evidence

The existing harness checks all four tools (`postgres`, `initdb`, `pg_ctl`, `psql`) match the requested major before creating resources. It creates a new private temporary data directory and socket, fresh random database suffix, ephemeral loopback port and random local role passwords. Before provisioning domain databases it verifies the actual server data directory (real path), port, administrator identity, initial `postgres` database and server major against its newly created cluster.

An additional temporary copy of the harness at `/private/tmp/mnv-phase8-isolated.js` added only read-only pre-migration checks. Before any application migration it queried each of all six new databases and asserted exact database name, owner `mnv_migrator`, expected purpose comment, zero user relations/sequences and server version starting with `16.`. All six reported version `16.15 (Homebrew)` and `objects: 0`. The development database marker was `mnv-commerce:development`; the other five were `mnv-commerce:disposable-test`. This temporary copy otherwise ran all the same tests and cleanup. The repository harness was never edited.

The unmodified npm suite then passed in another entirely fresh cluster. Its identity checks reject unknown objects, unmarked targets and unsafe rollback. Domain suites check owner/identity and empty domain tables before fixture mutation. Runtime is `mnv_runtime`, separate from owner/migration role `mnv_migrator`, with administrative privileges disabled. No production credentials or persistent test targets were supplied.

| Run | Temporary directory suffix | Port | Database suffix | Result |
| --- | --- | --- | --- | --- |
| PostgreSQL 16 plus preflight | `mnv-postgres-XSlJWQ` | 52134 | `6c43143f57da` | Passed |
| PostgreSQL 16 unmodified npm suite | `mnv-postgres-1WNlsp` | 52271 | `b9fc836c599c` | Passed |
| PostgreSQL 18.4 fresh comparison | `mnv-postgres-ncT5PS` | 52323 | `d2855c45c346` | Passed |

Directories are under `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/`. Each contains `verification.json`, data and server logs. Exact database identities and log digests are retained in `PHASE_8_VERIFICATION.json`. Each run used `mnv_commerce_dev_<suffix>`, `mnv_commerce_test_<suffix>`, and test names with `_workflow`, `_auth`, `_payments`, `_operations` appended.

## Commands and results

Commands ran from the application directory. Logs below are under `/private/tmp/`. Database executions required permission to bind local sockets; all completed with exit 0.

```sh
node --version
npm --version
HOMEBREW_NO_AUTO_UPDATE=1 brew install postgresql@16 > /private/tmp/mnv-phase8-provision.log 2>&1
/opt/homebrew/opt/postgresql@16/bin/postgres --version
npm run typecheck > /private/tmp/mnv-phase8-typecheck.log 2>&1
npm run build > /private/tmp/mnv-phase8-build.log 2>&1
npm test > /private/tmp/mnv-phase8-unit.log 2>&1
PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH" MNV_TEST_POSTGRES_MAJOR=16 node /private/tmp/mnv-phase8-isolated.js > /private/tmp/mnv-phase8-pg16-preflight.log 2>&1
PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH" MNV_TEST_POSTGRES_MAJOR=16 npm run test:postgres:isolated > /private/tmp/mnv-phase8-pg16.log 2>&1
PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH" MNV_TEST_POSTGRES_MAJOR=18 npm run test:postgres:isolated > /private/tmp/mnv-phase8-pg18.log 2>&1
npm audit --json --cache /private/tmp/mnv-phase7-npm-cache --fetch-retries=0 --fetch-timeout=20000 > /private/tmp/mnv-phase8-audit-network.json 2>/private/tmp/mnv-phase8-audit-network.stderr
node scripts/verify-boundary.js > /private/tmp/mnv-phase8-boundary.json
```

The first sandboxed `brew info postgresql@16 --json=v2` inspection could not update Homebrew's cache. The authorized installation succeeded. The first sandboxed audit failed with registry DNS `ENOTFOUND` (retained in `mnv-phase8-audit.json`); the same audit command retried with network access exited 0 and reported **0 vulnerabilities at every severity**. The initial combined audit/boundary shell command returned the scanner's exit code, not a successful initial audit; only the network retry is counted as an audit pass.

| Check | Result |
| --- | --- |
| Typecheck | Exit 0 |
| Build | Exit 0 |
| Unit tests | 44 passes; zero failed, cancelled or skipped |
| PostgreSQL migration suite | 7 passes on each run |
| Inventory | 17 passes on each run |
| Commerce | 13 passes on each run |
| Authentication | 13 passes on each run |
| Payments/recovery | 22 passes on each run |
| Operations | 6 passes on each run |
| npm audit network retry | Exit 0; zero vulnerabilities |
| Boundary/provenance scan | Exit 0; no errors; five migration hashes match Phase 6 |

PostgreSQL totals are **78 reported passes per run: 6 parent tests and 72 subtests**, not 78 separate top-level scenarios. No integration test failed, skipped or was blocked in the completed runs. Existing installed dependencies were used; no fresh `npm ci` was performed in this phase.

## What the passing suite establishes

All five migrations apply to fresh databases. The development target executes guarded `show`, `run`, `run`, `show` and rejects rollback even with explicit confirmation. The disposable migration suite exercises an existing Phase 1 schema upgrade, rejects inconsistent legacy inventory atomically, preserves evidence, checks readiness and schema, repeats without schema changes, rolls back all five migrations under exact disposable confirmation and reapplies them to empty domain tables.

Schema checks cover bigint money round trips, 14 restrictive foreign keys and supporting indexes, check/unique/index presence, invalid values and references, immutable history and runtime privilege rejection. Migration hashes remain unchanged.

Concurrency and recovery coverage actually executed includes competing inventory reservations, observed lock contention for the last unit, reverse-input deterministic locking, real serialization conflicts and real deadlock retry, idempotency replay/conflicts (including different authenticated principals), whole-transaction retry exhaustion, failed rollback connection eviction, atomic checkout/payment/inventory rollback and payment/cancellation/result races.

Payment tests also execute deferred failure at COMMIT, successful COMMIT with lost acknowledgement, actual forked worker SIGKILL during uncommitted finalization, backend rollback observation and repeated real reconciliation CLI recovery. Pending/unknown outcomes retain inventory holds; duplicate/stale/conflicting results cannot silently repeat consumption or reopen terminal attempts. Provider calls use test simulation, never a live gateway.

The fresh PostgreSQL 18.4 baseline has identical suite counts and outcomes, matching Phase 7's final 78-pass baseline. No PostgreSQL compatibility failure or behaviour difference was demonstrated. Timing and randomized identities differ and are not performance comparisons. No code fix or new regression test was warranted.

## Cleanup and limits

Each harness stopped only its own fresh cluster in its existing `finally` cleanup. Independent `pg_ctl -D <exact phase-created directory>/data status` checks using the corresponding major's binaries returned exit 3, `no server running`, for all three directories. No database files were deleted. Logs, temporary instrumented harness and database evidence remain available for review; retention follows the existing evidence policy. No existing service, Docker volume, unrelated database or protected backup was stopped, reset, removed or modified. No Git initialization, publication or external file upload occurred.

PostgreSQL 16.15 compatibility is verified for this complete local suite on macOS arm64 with Node 26.5.0 and current locked dependencies. Docker/Compose, other platforms, minimum Node, all possible interleavings, real payment providers, load/failover, backup restoration and production readiness remain outside this evidence. Homebrew binaries and dependencies remain installed; temporary evidence may eventually be removed by the operating system.

Recommended next phase: address Phase 7's authentication rate/concurrency controls and operational deadlines/shutdown bounds, then verify the minimum supported Node and intended deployment platform. Keep credential-owner actions, live-provider integration and production rollout separately authorized and reviewed. Phase 7's historical PostgreSQL 16 blocker is resolved by this record; its other limitations remain applicable.
