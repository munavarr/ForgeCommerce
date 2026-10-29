# Phase 3 commerce workflow review

Completed 29 October 2026 in the existing `mnv-commerce/` application. The initial and inventory migrations, entities, application configuration, inventory service, transaction/retry helper, idempotency implementation, tests and `INVENTORY_REVIEW.md` were inspected before implementation. Vendure packages and the backup were retained. Git was not initialized, nothing was published, and no dependencies, live payment gateway or separate infrastructure were added.

## Implementation and service contracts

The existing orders and order lines are the draft/cart model. No new domain table was needed. `CommerceModule` exports `CatalogService` and `OrdersService`. Public HTTP access is limited to `GET /catalog`, which returns up to 100 active, unarchived variant/product projections. Mutations and order reads are internal service operations pending real authentication.

`CommerceAccess` is an injectable authentication/authorization boundary. Both production methods deny by default. `catalogManager(context)` must resolve an authenticated manager to an audit actor; `customer(context)` must resolve an opaque authenticated request context to a user ID. A future adapter must validate sessions and privileges; it must never derive identity from arbitrary body fields. Tests use a test-local adapter mapping opaque object identities to fixture principals; it is not installed in the application. Order queries derive ownership from this principal and return the same 404 for missing and foreign orders. Active customer status is rechecked under a SHARE lock before idempotency replay as well as during ordinary commands.

| Operation | Contract |
| --- | --- |
| `CatalogService.createProduct(context, input)` / `updateProduct(context, id, input)` | Full validated replacement DTO: `key`, `name`, `description`, `active`, `archived`. |
| `createVariant(context, productId, input)` / `updateVariant(context, productId, id, input)` | Full validated replacement DTO: `key`, `sku`, `name`, `price`, `currency`, `active`, `archived`. Product identity cannot be reassigned by this API. |
| `OrdersService.createDraft(context, {key})` | Server generates code and derives owner/currency/state/zero totals. |
| `read(context, orderId)` | Ownership-checked order and active-line projection, including lifecycle name. |
| `setLine(context, {key, orderId, variantId, quantity})` | Absolute quantity upsert; adds a line if absent. Order lock prevents duplicate lines across different concurrent keys. At most 100 retained variant lines. |
| `removeLine(context, {key, orderId, variantId})` | Soft removal; recalculates totals. Re-adding restores the same line ID. |
| `checkout(context, {key, orderId})` | Refreshes prices/snapshots, validates catalog and stock, reserves all lines, freezes checkout, transitions to PaymentPending atomically. |
| `cancel(context, {key, orderId})` | Draft or PaymentPending only; releases active holds and transitions to Cancelled. |
| `recordPayment({key, evidence})` | Calls configured authoritative verifier once, then records normalized evidence and finalizes the order/inventory in one retriable transaction. No HTTP endpoint. |

Validation rejects unknown fields, blank/untrimmed or overlong names/SKUs, malformed IDs/currencies, numeric money, fractions, negative prices, nonpositive/overflow quantities and PostgreSQL bigint overflow. JSON prices are canonical nonnegative decimal strings. Existing unique trimmed **case-sensitive** SKUs and nonnegative bigint price constraints remain the database backstop; archiving never releases a SKU. Product/variant activation and archival are independent. Active variants on inactive/archived products are unavailable. Service APIs expose no deletion.

## Pricing and snapshots

`PricingPolicy` is injected and immutable. Environment configuration is documented in `.env.example`:

- `COMMERCE_CURRENCY`: INR by default; one configured order currency.
- `COMMERCE_TAX_BPS`: integer 0–10000, default 0.
- `COMMERCE_SHIPPING`: nonnegative decimal minor-unit string, default 0.
- `COMMERCE_RESERVATION_SECONDS`: 1–86400, default 900.
- `COMMERCE_STOCK_LOCATION_CODE`: MAIN by default; must already exist and be unarchived.

All arithmetic uses bigint. Subtotal is the sum of `unit_price * quantity`. Tax is exclusive and computed **once on aggregate merchandise subtotal** as `(subtotal * basisPoints + 5000) / 10000` with integer division: nearest minor unit, ties upward. Shipping is flat and untaxed; an empty draft has zero shipping. The total and each stored amount must fit signed PostgreSQL bigint. Draft totals are current estimates, refreshed from eligible catalog rows during editing and checkout. Client prices, totals, owner IDs, state and warehouse allocations are not accepted.

Checkout snapshots retain product/variant names, description, SKU, unit price, currency, quantity and pricing policy on each line; the order retains subtotal/tax/shipping/total, policy and checkout timestamp. Later catalog edits/archive do not change them. Database triggers block changes to non-draft lines and non-draft pricing/identity, including privileged SQL attempts. Lines with any existing reservation history cannot be changed, even while draft.

## Lifecycle and authoritative payment boundary

The explicit service and database graph is `draft -> placed -> paid`, presented as **Draft -> PaymentPending -> Paid**. Existing `placed` storage is reused. `draft -> cancelled` and `placed -> cancelled` are the only other new transitions. Paid, Cancelled and legacy Fulfilled are terminal. Payment failure cancels rather than reopening mutable snapshots. An order-state trigger writes the audited transition in the same database statement; runtime has SELECT-only history access. Update/delete/truncate history protections remain.

`PaymentResultVerifier.verify(evidence)` must authenticate provider evidence and return provider/reference, order ID, amount, currency and succeeded/failed outcome. Production verification rejects every request until an adapter is configured. No client boolean can mark an order paid. The verifier runs **outside** retry callbacks and must only verify/read; it must never initiate a charge/capture. The subsequent database transaction requires PaymentPending, a completed checkout snapshot, an exact amount/currency match and, on success, complete unexpired reservations. It inserts durable normalized payment evidence, changes state to Paid and consumes the existing inventory reservations together. Zero-value orders also require verified evidence; the forward migration permits nonnegative payment amounts for that case.

Provider/reference uniqueness prevents the same evidence finalizing twice even under a different request key. Changed order/amount/currency/outcome for that reference conflicts. Mismatched results, late success after expiry/cancellation, and legacy pending orders without complete checkout snapshots are rejected; they do not falsely claim payment or consume stock. Future provider integration must persist/reconcile/refund external successes that cannot be applied locally.

## Transactions, inventory reuse and retries

The original idempotency algorithm was extracted into `src/common/idempotency.ts`; inventory and commerce share it and the existing records table. Inventory's scope and request hashing remain compatible. Commerce uses a global `commerce` scope, hashing operation plus normalized command and server-derived principal. Matching completed keys return the stored decimal-string JSON response; changed fingerprints conflict. Failed transactions remove claims and completed responses together. Incomplete committed records are rejected, never taken over. Retention is still required for durable replay guarantees.

The existing `InventoryService.reserveStock`, `releaseReservations` and `commitReservations` accept an optional transaction-scoped EntityManager. The manager must belong to the same DataSource and an active transaction. Those paths use the exact existing lock/allocation/ledger logic; they neither open a second transaction nor retry a subset of checkout. Standalone inventory commands retain their previous transaction behavior. Nested inventory keys are bounded hashes derived from the outer operation/key, and all inventory audit context uses transaction-local settings.

| Boundary | Writes committed or rolled back together |
| --- | --- |
| Catalog mutation | Idempotency claim, validated product/variant write, replay response. |
| Draft mutation | Active-customer check, claim, ownership/state checks, absolute line edit/removal, refreshed prices/totals, replay response. |
| Checkout | Active-customer/ownership and order lock, claim, line/catalog locks, refreshed snapshots/totals, inventory claim/reservations/counters/ledger, checkout timestamp, state/transition history, both replay responses. |
| Payment result | Verification precedes the transaction; claim, order lock, immutable payment evidence, state/history, inventory consume or release, counters/ledger and replay responses share the transaction. |
| Cancellation | Customer/ownership/state guards, claim, inventory release/counters/ledger, state/history and replay responses. |

Order row locking serializes editing/checkout/payment/cancellation. Catalog locks are products then variants in stable order, followed by configured location and the inventory engine's sorted stock locks. Checkout rejects empty orders and draft orders with older reservation history rather than adding a second set of holds. Legacy duplicate variants require explicit reconciliation when edited. No applied migration or legacy snapshot was silently rewritten.

`inventoryTransaction` remains the retry owner: fresh runner/manager/whole READ COMMITTED transaction, maximum four attempts for `40001`/`40P01`. Scoped inventory calls propagate raw SQLSTATEs to that outer helper. Domain/check/uniqueness/connection and ambiguous commit errors are not automatically retried. Rollback failure still evicts the connection. There are no provider charge calls, messages or publications inside retry callbacks.

## Migration and preserved files

New forward migration: `CommerceWorkflow1793318400000` in `src/database/migrations/1793318400000-commerce-workflow.ts`. It adds activation/descriptions, order totals/policy/timestamp, additional line snapshot fields and soft-removal timestamp, transition audit data, supporting index, lifecycle/snapshot/payment guards and transactional history trigger. It changes only the payment amount CHECK from positive to nonnegative; existing rows/amounts are preserved. Database state vocabularies remain unchanged. New length constraints may reject incompatible legacy catalog text and require explicit reconciliation. Startup still never migrates or synchronizes.

The initial and inventory migrations retain their exact original SHA-256 hashes:

- Initial: `cdfd994a23ce463ced2393b6248832deaf0f20c63c1cb1b9e96fc7432831b406`.
- Inventory: `49907c5145bd793fa82d8c3abc83ab00f36808c4df5bdd3f0f9c76e69271d389`.

Legacy snapshot additions remain null; historical descriptions/currency/policy are not fabricated. The final schema has 13 domain tables plus migration metadata, 14 restrictive foreign keys, 52 CHECK constraints, 9 UNIQUE constraints and 40 indexes. All FKs retain leading-column indexes. Runtime cannot insert arbitrary transition history, change reserved counters, write stock movements, delete retained orders/lines/payment evidence or create/truncate tables.

`down()` remains exact-confirmation/disposable-only. It removes Phase 3 additions, and restores the old positive-payment constraint; that restoration deliberately fails if verified zero-value evidence exists. It is not an operational data rollback. Initial migration tests exercise all three reversions and reapplication only in a verified disposable database.

Changed source: new `src/commerce/` services/DTOs/policy/state/access/module/store and shared idempotency helper; updated application module, inventory transaction entry points, entities, migration registration and runtime grants. New unit/live commerce tests; earlier fixture helpers now produce valid lifecycle history/payment evidence instead of bypassing guards. The isolated harness provisions a separate commerce-test database. `test:postgres` now aliases the isolated harness, avoiding accidental environment-targeted execution. README and environment examples describe the new contract. Dependency lockfile, Vendure packages and backup were retained.

## Executed checks and evidence

From `/Users/munavark/Downloads/vendure-master/mnv-commerce`:

| Exact command | Final result |
| --- | --- |
| `npm run typecheck` | Passed (`tsc -p tsconfig.json --noEmit`). |
| `npm run build` | Passed (`tsc -p tsconfig.json`). |
| `npm test` | Passed: 18 unit tests, 0 failed/cancelled/skipped. |
| `npm run test:postgres:isolated` | Passed: migration 7 reported passes, inventory 15, commerce 13; 35 reported passes including three parent tests, 32 subtests, 0 failed/cancelled/skipped. |

Final live run used PostgreSQL **18.4 (Homebrew)**, Node **26.5.0**, loopback **127.0.0.1:49843**, in a newly initialized temporary cluster. Three newly provisioned, explicitly identified databases were used:

- `mnv_commerce_dev_b1210f692bba`, development marker/public schema, to test forward application and rejected rollback.
- `mnv_commerce_test_b1210f692bba`, disposable marker/mnv schema, for migration/upgrade/rollback and inventory tests.
- `mnv_commerce_test_b1210f692bba_workflow`, disposable marker/mnv schema, for commerce tests starting with empty migrated domain tables.

All were owned by `mnv_migrator`; application writes used the separate unprivileged `mnv_runtime` role. Actual name, owner, role, address/port, purpose marker, schema/history and expected empty starting data were verified. No existing cluster/database/volume was used or reset. Schema synchronization was disabled. Evidence remains at `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-JbXN5J/verification.json` with cluster/server logs alongside it. The harness stopped its server in `finally`; `pg_ctl -D .../data status` independently reported **no server running**.

Observed commerce evidence includes:

- Concurrent duplicate SKUs produced one success and one conflict; archived SKUs remained reserved. Direct negative price/duplicate SKU SQL was rejected.
- Authenticated fixture principals could mutate/read only their own orders. Forged contexts and client owner/totals/state/price fields failed. The live application still denied privileged service access and returned 404 for mutation routes.
- Tax boundaries at 9/10/11 minor units with 5% tax produced 0/1/1. Values above Number.MAX_SAFE_INTEGER stayed exact; overflow and mixed currencies failed. A zero-total order required verified evidence and consumed its reservation correctly.
- Same-key concurrent line edits/checkout replayed one response. Different keys performed absolute quantity updates without duplicate lines. Conflicting fingerprints failed, including across order IDs and payment outcomes.
- Checkout refreshed changed SKU, description and price, then retained them after catalog edits/archive. Pending and paid snapshot mutations and backward/terminal transitions were rejected by service/database guards.
- Two independent checkout transactions were both observed waiting in `pg_locks`, requesting 4 units each against 5 on-hand. One succeeded, one failed; reserved=4, available=1, one reservation, loser remained draft.
- A second-line shortage and injected transition failure rolled back the entire checkout, including refreshed stale prices, reservations/movements, totals/state/history and all request claims. Whole-table before/after snapshots matched.
- Injected serialization failures during sale insertion reached **four** complete transaction attempts, proved by a nontransactional test sequence. All state/evidence/inventory/idempotency changes rolled back, while the verifier ran once. A later successful payment and repeated keys/provider evidence produced one payment row and one sale per reservation.
- Payment/cancellation races produced one terminal winner and exactly two order transitions (checkout and finalization), with either one sale or released stock. Expired reservations rejected success and remained explicitly cancellable. Archived customers could not replay prior request results.
- Final inventory counter audit equaled the sum of active reservations with no negative availability. Existing migration and inventory suites also passed their actual serialization conflict, deterministic lock order, direct-SQL contention and failed-rollback connection-eviction tests.

An initial sandboxed PostgreSQL start could not run; the isolated harness was then run with the execution permission needed for local shared memory/listening sockets. The first live attempt exposed an older repository fixture omitting the newly required bigint mappings, corrected by supplying explicit zero component amounts. Subsequent review caught scoped inventory SQL errors being sanitized before the outer retry helper; this was fixed and verified with the four-attempt sequence assertion. Earlier failed/incomplete runs are not counted as passing.

## Readiness and remaining limits

The **initial service-level order lifecycle is implemented and ready for the subsequent authentication and payment phases**. It is not a production checkout deployment: production authorization and authoritative payment verification remain deliberately unconfigured, so privileged APIs fail closed and public checkout endpoints do not exist.

Future work remains outside this phase: authenticated session/manager adapters and controllers, provider signature verification/webhook ingestion, initiating charges with durable outbound idempotency, reconciliation/refunds for late or rejected external successes, and automatic expiry/recovery of abandoned PaymentPending orders. There is no automatic expiry worker; passing the expiry time alone does not free stock. Explicit cancellation releases it.

Pricing currently supports one configured currency, one warehouse, flat untaxed shipping and one exclusive tax rate; no jurisdiction/address rules, promotions, multi-location allocation or multi-currency conversion. Public catalog reads cap at 100 without pagination. Orders cap at 100 retained variant rows, including soft-removed rows. Legacy pending orders missing checkout snapshots and draft reservation histories need explicit reconciliation. Completed idempotency records must be retained. Fulfillment, returns/refunds and inventory reconciliation remain outside the initial lifecycle.

Live validation used PostgreSQL 18.4, not the Compose PostgreSQL 16 image, and did not test sustained load, failover or production deployment. A privileged database owner can alter protections; runtime/payment adapters must remain trusted and least privileged. No persistent application database was migrated. Work stops at Phase 3.
