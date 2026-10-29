# Phase 5 payment reliability and reconciliation review

Completed 29 October 2026 in the existing `mnv-commerce/` application. Read `AUTH_REVIEW.md`, `COMMERCE_REVIEW.md`, `INVENTORY_REVIEW.md`, `MIGRATION_REVIEW.md` and the actual payment, order, inventory, migration/grant, authentication and idempotency implementations before editing. Work stops at Phase 5. No Git initialization, publication, backup overwrite, Vendure package removal, applied-migration modification, persistent database migration, live gateway/credentials, Kafka, Redis or separate service was introduced.

## Dependency security review before implementation

The initial successful `npm audit --json` returned four **package findings**, not four individual advisories: two high, one moderate and one low. A sandboxed attempt could not resolve the registry; the network-enabled retry supplied the actual report. The dependency tree, exact release metadata, Node engines and peer ranges were reviewed before modifying the manifest/lockfile. No `npm audit fix`, major direct upgrade or transitive override was used.

| Finding and initial installed version | Severity | Dependency path | Exploitability in this application | Compatible remediation applied |
| --- | --- | --- | --- | --- |
| `@nestjs/platform-express@12.0.1` | High, inherited from Multer | Application -> platform-express -> multer; also a deduplicated peer of Nest core | No file/upload interceptors or multipart handlers are registered. The reported vulnerable upload paths are not reached by current JSON routes. This is dependency exposure, not an observed application exploit. | Upgrade to `12.3.2`, which pins `multer@2.5.0`. Its `@nestjs/common`/`core` peers are `^12.0.0`, satisfied by existing `12.0.1`. |
| `multer@2.2.0` | High overall | Application -> `@nestjs/platform-express` -> multer | Audit includes crafted field names/array indices, aborted-upload file descriptor/disk write leaks, async file-filter size bypass and async teardown crashes. These require upload processing, absent here. | `2.5.0` via the compatible parent update addresses all six advisory ranges; no forced override. |
| `typeorm@0.3.28` | Moderate | Application -> TypeORM, also deduplicated under `@nestjs/typeorm@12.0.1` | MySQL/MariaDB update/soft-delete `orderBy` injection does not apply to the PostgreSQL application or its bound-parameter queries. Migration-generation code injection requires attacker-influenced schema metadata and generating/loading that migration; this app uses reviewed explicit migrations, never `migration:generate`. | Patch to `0.3.31` addresses both advisories. Node >=16.13 and pg `^8.5.1` requirements fit Node >=20.19 / pg 8.16.3. The protected PostgreSQL connection-eviction method was inspected and its existing live regression passed after upgrading. |
| `esbuild@0.27.7` | Low, development only | Application -> `tsx@4.21.0` -> esbuild | Windows development-server path traversal requires esbuild's serving API. This app's development command uses ts-node; it neither serves files with esbuild nor uses Windows in this verification. | Upgrade tsx to `4.23.0`, whose supported dependency is `~0.28.0`; lock resolves esbuild `0.28.2`, beyond patched `0.28.1`. tsx's Node >=18 fits the app. Old tsx required `~0.27.0`, so a cross-range esbuild override was avoided. |

Advisories reviewed: Multer [field names](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm), [descriptor leak](https://github.com/advisories/GHSA-qfvm-cv95-jqjf), [filter race](https://github.com/advisories/GHSA-qvfw-j98x-7q72), [array index](https://github.com/advisories/GHSA-535w-7cp7-47q4), [disk writes](https://github.com/advisories/GHSA-3pph-fpjx-jg34) and [async teardown](https://github.com/advisories/GHSA-q7qp-rjg7-q26m); TypeORM [query builder](https://github.com/advisories/GHSA-9ggv-8w38-r7pm) and [migration generation](https://github.com/advisories/GHSA-2rp8-mm9q-fp49); esbuild [Windows serving](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr). Exploitability assessments above are inferences from those preconditions and inspected application paths.

Exact dependency changes:

```sh
npm install --save-exact @nestjs/platform-express@12.3.2 typeorm@0.3.31
npm install --save-dev --save-exact tsx@4.23.0
```

Final `npm ls --depth=0` and the targeted `npm ls @nestjs/platform-express multer typeorm tsx esbuild` succeeded without invalid peers. Final `npm audit --json` exited 0 with **zero vulnerabilities** (all severities). The complete unit and isolated PostgreSQL suites passed after these updates. No remaining npm audit finding is being deferred. Registry audit results are a point-in-time dependency check, not a production security certification.

## Payment/provider contracts

`src/payments/provider.ts` defines `PaymentRequest`, `PaymentResult`, `PaymentLookup`, `PaymentState` and the injectable abstract `PaymentProvider` contract: charge, authoritative lookup and authenticated notification verification. Canonical decimal-string minor units preserve bigint amounts. Every result must match provider, attempt ID, outbound key, order ID, amount and currency. Terminal results require a nonblank provider reference. Changed references conflict.

`DevelopmentPaymentProvider` is a pure, versioned simulator (`development-v1`). SHA-256 of the persisted outbound key deterministically selects decline, success or a lost success response. Lookup derives the same simulated result across fresh processes, even after a response was lost. This represents no real charge, provider database or network request. Only tests choose explicit scenarios through a fixture adapter. The public DTO has no scenario, state, amount, provider or success fields. Production execution is disabled.

`PaymentsService.start(context,{key,orderId})` is a trusted internal service API, installed/exported through `CommerceModule`. No payment HTTP controller is registered. It authenticates a customer, reauthenticates inside the admission transaction before idempotency replay, checks ownership, frozen PaymentPending checkout and complete unexpired reservations. Amount/currency come from the snapshot, never client inputs. Existing commerce idempotency fingerprints include operation, key, order and authenticated owner; conflicting key reuse fails. The payment fingerprint additionally captures frozen amount/currency and provider. A different logical key cannot open another payment on the same order.

Admission commits an existing-schema `payment_attempts` row and the idempotency replay pointer together. The unique outbound key is generated once and stored before provider I/O. Retries return the same attempt ID/key and use the original request. Provider calls run after the admission transaction completes, outside every retry callback. A timeout, exception, lost response or invalid provider result retains pending/unknown evidence and reservations; none becomes a definitive decline.

| State | Meaning and behavior |
| --- | --- |
| `pending` | Durable request admitted; no confirmed terminal outcome. May include provider-pending processing. Holds remain active. |
| `unknown` | Outcome cannot be established, including exceptions/timeouts. Stale pending results cannot downgrade this uncertainty. Holds remain active. |
| `succeeded` | Confirmed matching provider success, locally finalized in the same transaction as Paid and inventory consumption. Terminal. |
| `declined` | Confirmed definitive decline, locally finalized with cancellation and reservation release. Terminal. |
| Legacy `failed` | Existing evidence retained unchanged; managed attempts cannot use it. Not silently adopted for outbound retries. |

Finalization takes a **fresh** database transaction: lock order then attempt; revalidate snapshot/results; update the attempt; mark order Paid or Cancelled; consume/release the existing reservations and write inventory/order history atomically. It uses the existing inventory engine on the same manager. A failure in any step rolls back all finalization writes, leaving the pre-call attempt and admission response durable. Existing whole-transaction retry behavior applies only to database work, never provider execution.

Duplicate terminal confirmations return the recorded result and cannot repeat consumption. Pending/unknown notifications cannot regress terminal state. Conflicting terminal evidence is rejected for investigation and never reopens Paid or Cancelled. Cancelled/draft orders cannot start payment. Once an attempt is admitted, customer cancellation is blocked until a definitive result is established. Ordinary cancellation remains available before payment admission. No provider cancellation API is invented; a future live adapter must establish definitive cancellation before releasing holds.

## Notification boundary

`PaymentsService.notification(evidence)` calls provider authentication/verification before database access or result acceptance. The installed development provider **always rejects** notifications: no signing secret, magic token, trusted boolean, header bypass or development webhook endpoint exists. Test-only opaque authorities are declared solely in `test/payments.postgres.integration.js`; they are not imported by application code. Existing default `PaymentResultVerifier` still fails closed. Its legacy service path cannot finalize an order with a managed attempt, and a database insert guard also rejects an alternative unmanaged payment for that order.

This phase does not claim to implement a real provider's signature protocol. Before enabling a real transport, its adapter must verify raw bytes/signatures and provider-specific replay context and normalize authenticated results. There is no public callback route accepting unverified evidence in this phase.

## Forward migration and reservation safety

New migration only: `PaymentReliability1793491200000`, `src/database/migrations/1793491200000-payment-reliability.ts`. The existing schema could not store unknown/declined states or an immutable payment fingerprint, and lacked the one-managed-attempt-per-order and uncertainty-release guards.

The migration adds nullable `request_hash` for legacy compatibility, checked managed states/references, a partial unique managed-order index, an unresolved-attempt scan index and retained-payment protections. Attempt identities, amounts/currencies, fingerprints and outbound keys are immutable. A reference may be assigned once. Terminal states cannot change. Existing provider/reference and outbound-key uniqueness remains. Legacy pending/success/failed rows and every original field survive the upgrade; the migration test now verifies all three.

Database guards prohibit cancellation and active reservation release/expiry when a managed attempt is pending, unknown or succeeded. A decline update permits cancellation/release inside its transaction. Expiry alone does not free stock. Confirmed managed success may consume **complete still-active** reservations after the admission deadline during crash recovery. The original unexpired-only rule remains for legacy/unmanaged payment paths; existing expiry regressions passed unchanged. No reservation expiry/quantity/identity is extended or rewritten.

There are still 13 domain tables plus migration metadata, 14 restrictive foreign keys and 9 UNIQUE constraints; checks now total 55 and indexes 42 (including the two new partial indexes). Runtime grants retain previous restrictions. No new public database write function is exposed. Owner-trigger functions retain qualified names, `search_path=pg_catalog` and revoked PUBLIC execution. Runtime/application code remains trusted; database-owner compromise can defeat these guards.

All four preceding migration SHA-256 values remain unchanged:

- Initial: `cdfd994a23ce463ced2393b6248832deaf0f20c63c1cb1b9e96fc7432831b406`.
- Inventory: `49907c5145bd793fa82d8c3abc83ab00f36808c4df5bdd3f0f9c76e69271d389`.
- Workflow: `1635660e0a535691c7caefbcb40e7f1d926a008ea2a5aaacca584d5fca69e5ea`.
- Authentication: `9365444b6f9092c426b477cc07c6ecc96fd4d517d7f2760a189f23db345a1350`.

The new migration's down path retains exact-confirmation/disposable-only checks and additionally refuses any managed attempt, preserving recovery semantics. Empty/legacy-only disposable rollback restores the prior functions/state constraints, and all five migrations were reverted/reapplied in the migration regression. No applied migration or persistent database was modified.

## Explicit crash recovery

Run from this application directory, using the existing secret-management environment and runtime database role:

```sh
npm run payment:reconcile
```

The CLI accepts no arguments, verifies actual dedicated database identity and complete known migration history, and refuses production simulation. It scans pending/unknown managed rows using UUID keyset pages of 100. Each lookup occurs outside a transaction; each finalization uses a fresh transaction. Lookup errors preserve unknown. An authoritative not-found lookup may resubmit the original request/key. Confirmed terminal rows are skipped. One item failure does not starve later items. Output contains processed/unresolved counts and failed attempt IDs, not credentials or provider payloads. Exit status: 0 for a scan without unresolved/errors; 2 for unresolved/error items; 1 for command/configuration failure.

Restart after a crash; unresolved attempts remain discoverable and completed attempts remain terminal. Concurrent reconciliation and duplicate confirmations serialize under order/attempt locks. An attempt inserted behind the current cursor is picked up on the next invocation. No automatic scheduler, expiry worker or persistent in-memory cursor is required.

**External execution is not exactly-once.** Durable attempts prevent a crash from losing the outbound key; provider idempotency reduces duplicate execution when requests repeat; database uniqueness/locking prevents repeated local consumption; lookup and reconciliation recover lost responses and failed local commits. A real provider's retention windows, semantics, availability or inconsistent terminal evidence can still produce duplicate processing or require manual investigation/refunds. No live adapter, refund or provider cancellation infrastructure is configured here. Never switch an existing provider identity or discard attempts/idempotency records to retry uncertain payments.

## Exact verification and evidence

Commands executed from `/Users/munavark/Downloads/vendure-master/mnv-commerce`:

| Command | Final outcome |
| --- | --- |
| `npm run typecheck` | Exit 0; TypeScript no-emit check passed. |
| `npm run build` | Exit 0; TypeScript compilation passed. |
| `npm test` | Exit 0; **43 passed**, 0 failed/cancelled/skipped. Includes all 29 preceding unit tests and 14 payment/provider/orchestration tests. |
| `npm run test:postgres:isolated` | Exit 0; migration 7, inventory 15, commerce/catalog/checkout 13, authentication 12, payment 19 reported passes: **66 total**, including five parent tests and 61 subtests; 0 failed/cancelled/skipped. |
| `npm audit --json` | Exit 0; **0 vulnerabilities**. |
| `npm ls --depth=0` | Exit 0; all exact direct dependencies resolved. |
| `npm ls @nestjs/platform-express multer typeorm tsx esbuild` | Exit 0; patched paths and deduplicated peers verified. |

The final live run used Node **26.5.0** and PostgreSQL **18.4 (Homebrew)** on **127.0.0.1:50444**, in a newly initialized isolated cluster. Separate databases, all owned by `mnv_migrator`, with the unprivileged `mnv_runtime` write role:

- `mnv_commerce_dev_c744c3ec900c`: development marker, public schema; forward migration/repeated application and refused rollback.
- `mnv_commerce_test_c744c3ec900c`: disposable marker, mnv schema; legacy upgrade, rollback/reapplication and inventory tests.
- `mnv_commerce_test_c744c3ec900c_workflow`: disposable marker; catalog, pricing, checkout, ownership and preceding payment lifecycle regressions.
- `mnv_commerce_test_c744c3ec900c_auth`: disposable marker; real authentication/session/authorization regressions.
- `mnv_commerce_test_c744c3ec900c_payments`: disposable marker; new payment reliability/reconciliation tests with real customer/admin bearer sessions.

Evidence: `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-bLWXnJ/verification.json`. Cluster files/server log are retained beside it. The harness verifies identity, expected migration history and empty data before domain suites, and stops its own server in `finally`. An independent `pg_ctl -D /var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-bLWXnJ/data status` returned `no server running`. The manifest and lockfile root dependency/dev-dependency/engine fields also match. No pre-existing cluster/database/volume was reset. The sandbox initially blocked local PostgreSQL startup; the authorized fresh-cluster run passed. Earlier attempts are not counted as final evidence.

Payment evidence includes committed visibility from an independent connection before provider I/O; NOWAIT order/attempt locks acquired while the provider is blocked; three same-key initiations; six concurrent confirmations; one simulated provider effect and one sale movement per reservation; duplicate/out-of-order results; exact large amounts; mismatched amount/currency/order/key/provider/reference rejection; customer cancellation/direct release rejection during uncertainty; success/decline recovery of expired-but-held reservations; failures before the call and after its response; four full serialization retries while calling the provider once; whole-table rollback snapshots for order, sale and release failures; repeatable real reconciliation CLI execution; provider outage retention and per-item scan isolation. Existing connection-eviction, stock-contention, catalog, checkout and real authentication regressions all passed. Final counters equal active reservations with no negative availability.

## Remaining boundaries

- Development simulation only; no money moves, no live credentials, payment HTTP start/confirmation route, real webhook transport, refund handling or provider cancellation is enabled. Service callers and future adapters must remain trusted.
- No automatic reconciliation/expiry scheduler is added. Uncertainty intentionally holds stock until explicit reconciliation obtains a definitive result; prolonged provider outages can retain reservations indefinitely.
- Legacy attempts lacking fingerprints are retained for explicit review and are excluded from outbound retry/reconciliation. Conflicting terminal evidence is rejected without inventing a refund or reopening a terminal order; operators must investigate.
- Previous authentication/deployment limits remain: no MFA/email recovery/verification, public credential throttling, failover/load validation or production security certification. The runtime database role must remain unprivileged.
- Live tests used PostgreSQL 18.4, not the Compose PostgreSQL 16 image. Failure injection demonstrates local atomicity and recoverability, not a real gateway's settlement, idempotency retention or distributed failure behavior. No persistent application environment received the new migration.
