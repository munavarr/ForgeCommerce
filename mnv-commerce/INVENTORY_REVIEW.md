# Phase 2 inventory implementation and verification

Completed 28 October 2026 in the existing `mnv-commerce/` application. The actual source and `MIGRATION_REVIEW.md` were inspected first. No Vendure package, backup, existing database or Docker volume was removed or overwritten. Git was not initialized and nothing was published. No dependencies, payment processing, Kafka, Redis or microservices were added. This is not a production-readiness claim.

## Schema assumptions and migration

The original `1793145600000-initial-commerce.ts` remains byte-for-byte unchanged (SHA-256 `cdfd994a23ce463ced2393b6248832deaf0f20c63c1cb1b9e96fc7432831b406`, checked before and after implementation). Apply the new `InventoryEngine1793232000000` through the existing guarded migration command. Startup still never migrates or synchronizes.

The forward migration adds `stock_levels.reserved` and `CHECK (reserved >= 0 AND reserved <= on_hand)`. The original nonnegative on-hand check remains. An owner trigger maintains reserved quantities and consumption decrements; the runtime role cannot write the reserved column. Existing active reservations are backfilled, including those whose timestamp has passed but whose state is still active. Inconsistent legacy data (oversubscribed stock, variant mismatch or active/consumed quantities exceeding a line) aborts the whole migration; no automatic reconciliation occurs. Existing on-hand balances and historical movements are not rewritten.

Movement additions are `kind`, `on_hand_delta`, `reserved_delta`, `reservation_id`, `actor` and `request_key`. Existing movements keep their original fields, with `kind='legacy'`, `actor='legacy'` and null new deltas/references. They cannot safely be retrospectively classified. A restrictive reservation FK and leading unique `(reservation_id, kind)` partial index prevent duplicate event kinds. Shape checks describe each new movement's two quantity legs.

The final migrated schema has 13 domain tables plus migration metadata, 14 restrictive FKs, 43 CHECK constraints, 9 UNIQUE constraints and 39 indexes (including PK/unique indexes). All FKs have a leading-column supporting index. No new domain table or extension is required.

## Exact quantity meanings

| Quantity | Meaning |
| --- | --- |
| On-hand | Physical sellable units still held at a variant/location, including units held by active reservations. Initialization and adjustments change it; reservation/release do not. Consuming a paid-order reservation subtracts its quantity. |
| Reserved | Sum of quantities with reservation state `active` at that stock level, materialized in the protected counter. A passed expiry timestamp alone does not free units. |
| Available | Exactly `on_hand - reserved`. A read uses one SQL statement/snapshot. It is never negative in a committed state. |
| Sold | Cumulative quantities of retained `consumed` reservations at that level. Returned as a decimal string because the sum is PostgreSQL bigint and can exceed one integer balance over time. Adjustments/releases do not change it. Returns/refunds are outside scope. Legacy sales without consumed reservations cannot be inferred. |

| Event | On-hand delta | Reserved delta | Existing `quantity_delta` meaning |
| --- | --- | --- | --- |
| Initialization/adjustment | Signed stock change | 0 | On-hand delta |
| Reservation | 0 | +quantity | -quantity (available decreases) |
| Release/expiry transition | 0 | -quantity | +quantity (available increases) |
| Sale | -quantity | -quantity | -quantity (on-hand decreases; available stays constant) |

Use the explicit two deltas and `kind`; summing `quantity_delta` across event kinds does not reconstruct a balance. A zero opening balance creates the stock row and idempotency response but no movement because no quantity changes. Later positive stock must be an adjustment. Legacy balance reconciliation remains a separate operational decision.

## Internal service and authorization boundary

`InventoryModule` exports `InventoryService`. A shared `DatabaseModule` provides the same DataSource to health checks and inventory. Operations are:

| Operation | Input beyond required `key`, `actor`, `reason` |
| --- | --- |
| `createLocation` | `code`, `name` |
| `manageLocation` | `locationId`, `name`, `archived` (rename/archive/restore) |
| `initializeStock` | `variantId`, `locationId`, nonnegative integer `quantity` |
| `adjustStock` | `variantId`, `locationId`, nonzero signed integer `delta` |
| `reserveStock` | `orderId`, UTC ISO `expiresAt`, 1–100 items (`lineId`, `variantId`, `locationId`, positive `quantity`) |
| `releaseReservations` / `commitReservations` | `orderId`, 1–100 unique `reservationIds` |
| `readStock` / `listLocations` | Variant/location IDs / no arguments; read-only |

DTO validation rejects unknown fields, missing/blank audit values, malformed IDs/dates, duplicate allocations/IDs, numeric strings, fractions, negative stock and values outside the PostgreSQL integer range. Errors expose consistent inventory codes/statuses and safe messages rather than driver SQL or credentials. Archived variants/locations reject new initialization, adjustment and reservation; existing reservations remain releasable/consumable and stock remains readable. Location codes remain reserved after archive.

There is no inventory HTTP controller, so no public mutation endpoint or permissive admin bypass. Live HTTP tests verify relevant POST routes return 404. The actor is an audit attribution supplied by a trusted internal caller, **not authentication or an authorization proof**. A future authenticated application layer must authorize adjustments/warehouse access, derive order lines server-side and supply a stable request key; it must not forward arbitrary public DTOs directly to this service.

Reservations reference existing order lines, from which their order is derived. Both service checks and database triggers enforce matching variants and the line's aggregate active+consumed quantity limit. Reserved line identity/order/variant/quantity and stock-level identity are protected. Reservation identity/quantity/expiry are immutable; only `active -> released|expired|consumed` is allowed, and reservation deletion/truncation is blocked. The service exposes explicit release rather than an automatic expiry job. Consumption requires the already-existing order state to be `paid`, locked and checked in the same transaction, and the reservation to remain unexpired. Inventory does not mark orders paid or verify a provider/payment amount.

## Transaction and concurrency boundaries

Every mutating service command executes its idempotency claim, all locks/validation, business writes, trigger-generated ledger records and completed replay response in **one READ COMMITTED PostgreSQL transaction on one QueryRunner's EntityManager**. Transaction callbacks use only the passed manager; global `db.manager` is used only by read-only entry points. No external calls or publications occur inside retries.

The globally scoped `inventory` request key is mandatory across all mutation types. A unique insert waits for competing requests, followed by a locked record read. A matching completed request returns its normalized stored JSON response; a reused key with different operation/input/actor/reason conflicts. Multi-item input and reservation IDs are canonicalized before hashing. A failure rolls back the idempotency claim too. A committed incomplete record is rejected, never taken over. Completed records must be retained to preserve replay guarantees; no expiry/deletion routine was added.

For reservations, lock order is order row, distinct line IDs in lexical order, active variant IDs in lexical order, location IDs in lexical order, then stock pairs by variant/location lexical order. All stock locks precede reservation inserts. Finalization locks order/lines, then stock pairs in that same order, then reservation IDs in lexical order. The service uses `FOR UPDATE` for allocation/adjustment rows and SHARE locks for catalog eligibility. Adjustment and initialization take catalog locks before touching stock. Location management updates only its location row. These orders reduce deadlocks; they do not make every arbitrary external SQL workflow deadlock-free.

For a missing stock-level row, `INSERT ... ON CONFLICT (variant_id,location_id) DO NOTHING` uses the existing unique constraint as the concurrency arbiter. A different-key loser conflicts and never overwrites/adds another opening balance; an identical-key retry replays. Reserving missing stock fails instead of inventing inventory.

Reservation triggers atomically update the stock counter and on-hand balance, with the stock CHECK constraint as the final allocation guard. They use `FOR NO KEY UPDATE` because keys are immutable; this avoids upgrading foreign-key KEY SHARE locks into conflicting UPDATE locks during concurrent direct INSERTs. Stock changes and reservation transitions insert movements inside the database statement/transaction. Movement insertion failure aborts the associated balance/state change. Runtime ledger access is SELECT-only, and original owner/runtime history protections remain. SECURITY DEFINER trigger functions qualify objects, set `search_path=pg_catalog` and revoke PUBLIC execution; they expose no general callable write function.

The retry helper recognizes only SQLSTATE `40001` and `40P01`, including TypeORM's wrapped driver errors. It retries the entire callback using a fresh runner/manager/transaction, at most four attempts (initial plus three retries), with short bounded jittered backoff after releasing the runner. Domain, check, uniqueness, connection and ambiguous commit failures are not retried automatically. Retry exhaustion becomes `INVENTORY_BUSY`/503; the caller may retry with the same key. Rollback/release failures stop retries. A failed rollback evicts the pg connection via TypeORM 0.3.28's PostgreSQL error-release path instead of returning an open transaction to the pool.

This follows PostgreSQL's documented [row-lock behavior](https://www.postgresql.org/docs/current/explicit-locking.html) and requirement to [retry complete transactions for serialization/deadlock failures](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html).

## Commands and executed evidence

From `/Users/munavark/Downloads/vendure-master/mnv-commerce`:

| Exact command | Final outcome |
| --- | --- |
| `npm run typecheck` | Passed; `tsc -p tsconfig.json --noEmit`. |
| `npm run build` | Passed; `tsc -p tsconfig.json`. |
| `npm test` | Passed; build then `node --test test/*.test.js`: 12 passed, 0 failed/skipped. |
| `npm run test:postgres:isolated` | Passed; build and fresh-cluster harness. Migration suite: 7 reported passes (parent + 6 subtests). Inventory suite: 15 reported passes (parent + 14 subtests). 0 failed/skipped. |

Final live run used PostgreSQL **18.4 (Homebrew)** and Node **26.5.0** on loopback **127.0.0.1:51792**. It provisioned only the new `mnv_commerce_dev_03db68165fb6` (development marker, public schema) and `mnv_commerce_test_03db68165fb6` (disposable-test marker, mnv schema), owned by `mnv_migrator`. Runtime writes used `mnv_runtime`, including a two-connection inventory pool. Database name, owner, role, address/port, purpose comment and known objects were explicitly verified; inventory tests additionally required all domain tables empty. There is no truncate/delete reset helper.

Evidence is retained at `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-8wIv77/verification.json` with the server log and cluster files alongside it. The harness stopped its cluster in `finally`; no existing server/volume was used. Development forward migration and rejected rollback were also checked. The test-only initial-schema setup exists to prove a real Phase 1 upgrade with pre-existing balances, reservations and immutable movements, including failure on inconsistent legacy stock. Confirmed disposable rollback/reapplication occurs before inventory tests so those tests start on a verified empty migrated schema.

Observed database evidence:

- Two different checkout transactions were simultaneously blocked on real PostgreSQL locks, observed through `pg_locks`. Each requested 4 units against 5 on-hand. Exactly one succeeded: on-hand 5, reserved 4, available 1, one reservation movement.
- Concurrent initialization produced one level, balance 7 and exactly one opening movement. The loser received `STOCK_ALREADY_INITIALIZED`.
- Reverse-input, overlapping two-variant checkouts acquired identical stock-pair lock sequences and both completed within capacity. A second-item shortage rolled back an already-inserted first reservation and its movement.
- Direct concurrent reservation SQL bypassing service prechecks also had one success and one database constraint rejection, with no overselling. Direct variant mismatch, invalid quantities, manual counter reset and on-hand reduction below reserved were rejected.
- Same-key concurrent requests replayed a single result. Different-key duplicate release/consume and a release-versus-consume race finalized only once. Wrong-order/variant/line-limit/expiry failures preserved stock and movement snapshots.
- A server-side BEFORE INSERT movement trigger deliberately rejected initialization, adjustment, reserve, release and sale records; whole-table inventory/idempotency snapshots before/after each failure matched.
- Server-injected `40001` and `40P01` failures exhausted exactly four whole transactions, all released, without changing stock/history/idempotency. A separate real SERIALIZABLE conflict forced a fresh manager/transaction ID and reread the concurrently committed value. Exhaustion for deadlocks was fault-injected rather than relying on a nondeterministic deadlock victim.
- A deliberately failed rollback on an actual open PostgreSQL transaction caused connection eviction; its backend disappeared, uncommitted stock/history changes vanished and subsequent pooled queries completed.
- Final counter audit matched every reserved counter to the sum of active reservations; all balances satisfied `0 <= reserved <= on_hand`. Owner and runtime history tampering remained rejected.

Earlier runs are not counted as passing: the initial sandbox could not start PostgreSQL, so the harness ran with elevated execution. Live tests caught a raw `UPDATE ... RETURNING` tuple response bug (fixed using a SELECT over an UPDATE CTE), insufficient observer visibility into another role's wait details (fixed using public lock metadata), and a trigger lock-upgrade deadlock during direct inserts (fixed using NO KEY UPDATE). Upgrade fixtures also required scoped assertions and handling expected non-JSON TypeORM migration-failure diagnostics. The final complete suites passed after these corrections.

## Changed files and remaining risks

New source: `src/inventory/inventory.module.ts`, `inventory.service.ts`, `inventory.dto.ts`, `inventory.error.ts`, `transaction.ts`; `src/database/database.module.ts`, `migration-names.ts`, `migrations/1793232000000-inventory-engine.ts`. Updated source: `src/app.module.ts`, `src/database/options.ts`, `safety.ts`, `migrate.ts`, `entities/commerce.entity.ts`. Tests/commands: new `test/inventory.test.js`, `test/inventory.postgres.integration.js`; updated `test/postgres.integration.js`, `scripts/test-postgres-isolated.js`, `package.json`. Documentation: updated `README.md`, new this review. Generated `dist/` remains ignored. The original migration, Phase 1 review, dependency lockfile and Vendure packages are retained.

Remaining limits: authentication/authorization and order/payment confirmation are not implemented; internal callers are trusted. Automatic reservation expiry, distributed workflows, refunds/returns, reconciliation and idempotency retention policy need future design. Reads are point-in-time snapshots. Existing legacy movements cannot reconstruct historical balances or prove earlier sale correctness. Test validation used PostgreSQL 18.4, not the Compose PostgreSQL 16 image; container, failover, sustained load and production privilege deployments were not tested. The failed-rollback disposal path depends on a protected TypeORM 0.3.28 method and must be revalidated on upgrades. Runtime credentials must not inherit owner/admin privileges; a privileged owner can alter triggers/constraints and remains outside application-level protection. No non-test application database was migrated in this work.
