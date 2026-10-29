# MNV Commerce

Independent NestJS/TypeORM backend with an explicit PostgreSQL schema, catalog, draft orders, pricing, checkout, inventory, bearer sessions, durable development payment attempts and explicit reconciliation. Run all commands from this directory; no sibling package, workspace build, Bun or Lerna is required.

This project began in an extracted Vendure repository. See [NOTICE.md](NOTICE.md) for provenance, [LICENSE.md](LICENSE.md) for the preserved upstream licence notice, [cleanup/REVIEW.md](cleanup/REVIEW.md) for the repository reduction and [PHASE_7_REVIEW.md](PHASE_7_REVIEW.md) for current hardening and verification. The five earlier phase reviews remain historical evidence: [payments](PAYMENT_REVIEW.md), [authentication](AUTH_REVIEW.md), [commerce](COMMERCE_REVIEW.md), [inventory](INVENTORY_REVIEW.md) and [migrations](MIGRATION_REVIEW.md). Statements in those records about retained Vendure packages describe their completion dates.

## Commands

Use Node.js >=20.19.0 and npm with the committed v3 lockfile. Local Phase 6 verification used Node 26.5.0; the minimum Node version was not separately tested. PostgreSQL integration requires local PostgreSQL binaries. The application does not require Redis, Kafka, Docker or Vendure. Keep development dependencies installed for TypeScript builds and the commands that build before execution.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run migration:show
npm run migration:run
npm run start
```

`npm run dev` runs the source with ts-node and watch mode. `npm test` builds and runs the unit suite; `npm run test:postgres:isolated` runs the database suites described below. For a built runtime deployment, `npm start` needs only production dependencies and the generated `dist/` directory. Migrations and reconciliation remain explicit operator commands.

The application and migration commands load `.env` if present. Exported variables take precedence. Copy `.env.example` and replace placeholders locally; do not print or commit credentials. Supply only runtime credentials to application deployments; migration credentials belong in the migration process environment.

The optional local `docker-compose.yml` starts only PostgreSQL. It requires `POSTGRES_PASSWORD` supplied locally and binds its port to loopback. Its bootstrap user is administrative and must not be used as the application runtime role. Existing named volumes are preserved; starting Compose does not provision the purpose marker or distinct roles required below. The pinned PostgreSQL 16 image has not been tested in this phase.

Startup connects using the runtime role with `synchronize: false` and `migrationsRun: false`. It never applies migrations. `/health/live` checks process liveness; `/health/ready` returns 503 until the database is connected, the exact known migration history is applied, and all expected tables exist. If the initial connection fails, restart after restoring PostgreSQL. Readiness is not a full ongoing schema-drift audit.

SIGINT/SIGTERM enable Nest shutdown hooks; HTTP shutdown precedes database-pool destruction. `app.close()` also closes the pool. There is no enforced drain deadline for stuck requests/queries. Logs are JSON; sensitive fields, credential-bearing URLs, Error details, traces and sensitive context are redacted. Avoid logging arbitrary request/provider values: pattern redaction cannot identify every opaque secret. Request correlation and access logging are not yet implemented; `LOG_LEVEL` is currently informational configuration and does not filter output.

## Provisioning and identity

Create a **new dedicated database** using a database administrator, after verifying the target server. Never reuse a Vendure database, infer safety from connectivity, or mark an unidentified database to bypass the guard. No command here provisions or modifies an existing server automatically.

Provision distinct login roles: `mnv_migrator` owns the new database/schema; `mnv_runtime` has no superuser, create-role, create-database, replication or bypass-RLS privileges and no membership that confers schema creation. Set their passwords through your local secret-management process. For a custom `DB_SCHEMA`, provision the schema owned by the migration role first. The default `public` schema is supported.

After confirming ownership, address, port and that the new database is empty, its administrator/owner must set its purpose marker, for example:

```sql
COMMENT ON DATABASE mnv_commerce_dev IS 'mnv-commerce:development';
```

Migration commands accept only `mnv_commerce`, `mnv_commerce_dev[_suffix]` or `mnv_commerce_test[_suffix]`. They verify the actual database name, purpose comment, owner, role, server address/port and reject unrelated tables/views/sequences anywhere in the database. Identity output contains no passwords or connection URLs. A development marker permits forward migration only. A disposable test database requires a unique suffix and the `mnv-commerce:disposable-test` marker.

`migration:run` requires separate `DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD`; `migration:show` uses the runtime role and is read-only, even before the first migration. A session advisory lock serializes the supported commands. Schema DDL, migration metadata and runtime grants execute in one transaction. Invalid/missing configuration and driver failures exit nonzero with sanitized output. Do not bypass the wrapper with the generic TypeORM CLI.

The wrapper grants runtime schema USAGE and explicit table privileges, revokes schema CREATE from PUBLIC/runtime, and refuses an administrative/owning runtime role or inherited schema/database CREATE privileges. Runtime has no TRUNCATE privilege, no migration-metadata writes, no DELETE on orders/lines/payments/reservations/stock levels, and only SELECT on stock movements. Owner triggers insert inventory movements. Stock-level INSERT/UPDATE grants are column-scoped and exclude the reserved counter; transition history is SELECT-only, written by an order-state trigger. Runtime user INSERT privileges allow only email/password hash, and UPDATE allows only password hash/archive time. Role and email verification are owner-only columns. Session writes allow only user/digest/expiry insertion and revocation updates. No default privileges are granted for hypothetical future tables.

## Schema decisions

The reviewed SQL in `src/database/migrations/1793145600000-initial-commerce.ts` and the forward migrations `1793232000000-inventory-engine.ts`, `1793318400000-commerce-workflow.ts`, `1793404800000-authentication.ts` and `1793491200000-payment-reliability.ts` is authoritative. All five migrations are unchanged by the repository reduction. `src/database/entities/commerce.entity.ts` maps scalar columns for repositories; foreign keys, constraints, indexes and triggers live explicitly in migrations. Do not generate a migration by diffing those scalar mappings or enable synchronization.

| Area | Tables and decisions |
| --- | --- |
| Identity | `users`: normalized unique email, password hash, customer/administrator role, archive time and nullable email verification time. `sessions`: unique SHA-256 token hash, expiry and revocation times; never store a bearer token. |
| Catalog | `products`, `product_variants`: archive times, unique trimmed case-sensitive SKU, price/currency. SKU remains reserved after archive. |
| Inventory | `stock_locations`, `stock_levels`: unique location code and variant/location pair. Phase 2 adds a trigger-maintained reserved counter with `0 <= reserved <= on_hand`; available is `on_hand - reserved`. Reservations retain their order-line/stock references, quantity, expiry and terminal states. |
| History | `stock_movements`: original signed delta/reason retained, plus kind, separate on-hand/reserved deltas, reservation reference, actor and request key. Existing rows have explicit legacy semantics. `orders`, `order_lines`, `order_transitions` retain states and line snapshots. Movement and transition UPDATE/DELETE/TRUNCATE are rejected by statement triggers, including for the owning migration role. |
| Payments | `payment_attempts`: durable order-linked amount/currency/state, unique outbound idempotency key and unique non-null provider/reference pair. Managed attempts add an immutable request fingerprint, one attempt per order, and pending/unknown/succeeded/declined states. Pending/unknown attempts may lack a provider reference. |
| Idempotency | `idempotency_records`: unique scope/key, request hash, processing/completed state and JSONB replay response; status/body must be present together on completion. Response money must be decimal strings. No payment-card or provider payload storage. |

IDs are PostgreSQL UUIDs with built-in `gen_random_uuid()` defaults; dates are `timestamptz`. No extension is required. State values use CHECK constraints so this small initial state vocabulary remains visible in reviewed SQL. Currency has an uppercase three-letter format check, not a hard-coded currency registry. All foreign keys have a supporting leading-column index; live-session/reservation expiry indexes are partial.

All monetary columns (`price`, `total`, `subtotal`, `tax`, `shipping`, `unit_price`, `amount`) use PostgreSQL `bigint` minor units and TypeScript `bigint`. The transformer rejects numbers, strings and out-of-range values on writes and decodes the driver's decimal strings on reads. The HTTP interceptor and `stringifyCommerce()` serialize bigint values as decimal strings without number conversion. Raw SQL results retain the PostgreSQL driver's bigint strings; use repositories for typed monetary reads. JSONB response writers must use `stringifyCommerce()` before passing a response containing bigint to the driver.

Every foreign key uses ON DELETE RESTRICT. Referenced catalog and stock records must be archived rather than deleted; an attempted deletion fails and retains history. Unreferenced catalog records can be deleted. There are no cascading deletes. Corrections to inventory/history use new entries. Inventory locking and reservation transitions are implemented internally. The commerce services calculate totals and orchestrate checkout and verified payment results. Authentication is implemented through the bearer-session adapter. The deterministic development provider supports internal simulation only; it rejects all webhook evidence and is disabled in production. The legacy payment-result verifier remains unconfigured and denies every request. Catalog reads are public; orders require customer sessions and catalog/inventory administration requires administrator sessions. No payment HTTP controller is registered.

## Authentication and administrator provisioning

Use JSON bodies for `POST /auth/register` and `POST /auth/login`, each accepting **only** `email` and `password`. Registration creates a customer and returns an allowlisted user projection; login returns `{token,tokenType,expiresAt,user}`. Both customer and administrator accounts use the same login route. Supply `Authorization: Bearer <token>` on authenticated requests. Tokens in query strings, cookies and identity/role objects are not accepted. `GET /auth/me` returns the current principal; `POST /auth/logout` revokes that token. Logout is idempotent for well-formed tokens, including already revoked/unknown tokens. Other uses of missing, malformed, expired, revoked or unknown sessions return 401. Valid sessions with the wrong role return 403. Auth identity and credential responses set `Cache-Control: no-store`.

Passwords require at least 15 Unicode characters and at most 1024 UTF-8 bytes, with no trimming, normalization or truncation. Invalid Unicode is rejected. Argon2id uses 64 MiB, three passes, one lane, a random salt and a 32-byte output; passwords beyond bcrypt's 72-byte limit remain distinct. PostgreSQL stores only password hashes and SHA-256 session-token digests. Each token uses 32 cryptographically random bytes encoded as base64url, with a fixed eight-hour absolute expiry. Each request rechecks the session/account in PostgreSQL. Role changes and archival apply immediately to subsequent checks. Order/catalog/inventory mutations recheck before idempotency replay and hold session/user SHARE locks until their transaction ends; an operation already authorized may finish before concurrent logout returns.

Registration cannot choose a role or verification timestamp. There is no email-verification, password-reset, external-login, default administrator or public account-promotion endpoint. Emails remain unverified. The new migration assigns existing accounts the customer role and revokes all pre-authentication sessions while retaining their digests/history; it does not rewrite password hashes. Unsupported legacy hashes cannot log in and need a separately reviewed provisioning/recovery process.

To create an administrator, use an interactive terminal from this directory with separate owner/migration credentials supplied by the existing secret-management environment:

```sh
npm run admin:create
```

The command prompts for email and twice for a hidden password. It rejects arguments and non-TTY input, never reads a password from a shell argument/environment variable, logs no credential data and inserts only a new account. Duplicate email fails; existing customers are never silently promoted. It verifies database identity, owner access and applied migrations. Keep migration credentials out of the running application process.

| Route | Access / input |
| --- | --- |
| `GET /catalog` | Public active catalog projection. |
| `POST /orders` | Customer; `{key}`; owner is derived from the session. |
| `GET /orders/:id` | Customer; own order only; foreign and missing IDs both return 404. |
| `PUT /orders/lines` | Customer; `{key,orderId,variantId,quantity}`. |
| `POST /orders/lines/remove` | Customer; `{key,orderId,variantId}`. |
| `POST /orders/checkout`, `POST /orders/cancel` | Customer; `{key,orderId}`. |
| `POST /admin/catalog/products`, `PUT /admin/catalog/products/:id` | Administrator; full product replacement DTO. |
| `POST /admin/catalog/products/:id/variants`, `PUT /admin/catalog/products/:productId/variants/:id` | Administrator; full variant replacement DTO. |
| `GET /admin/inventory/locations`, `GET /admin/inventory/stock/:variantId/:locationId` | Administrator. |
| `POST /admin/inventory/locations`, `PUT /admin/inventory/locations` | Administrator; location create/update DTO without `actor`. |
| `POST /admin/inventory/initialize`, `POST /admin/inventory/adjust` | Administrator; stock DTO without `actor`. |

Inventory mutations accept a key/reason and operation fields, and derive the audit actor from the administrator session. `InventoryService` enforces this authorization even when called directly. The separate `InventoryEngine` is a trusted internal transaction primitive used by `OrdersService` and the authorized facade; never wire it to client input. Reserve/release/consume commands have no HTTP route. Order access and ownership checks also live inside the services; administrators have catalog/inventory privileges, not customer impersonation privileges. There is no public payment confirmation route for any role, and the internal verifier still fails closed.

Use HTTPS and deployment-level request throttling before exposing credentials publicly. This phase has no MFA, distributed rate limiter, session cleanup worker, automatic reservation expiry worker or live payment-provider adapter. Session rows remain stored after expiry/revocation. Configure proxy/access logs to exclude authorization headers, cookies, credentials and response tokens. See the current review for dependency-audit results and other limits.

## Commerce services and pricing

`CatalogService` provides validated product/variant creation and replacement updates; `active` and `archived` are independent booleans. Case-sensitive SKUs remain unique after archive. `GET /catalog` returns at most 100 active, unarchived variant projections. Catalog writes require `CommerceAccess.catalogManager(context)`, which validates an active administrator session from the Authorization header.

`OrdersService` provides `createDraft`, `read`, `setLine`, `removeLine`, `checkout`, `cancel` and `recordPayment`. Customer methods require an bearer Authorization header resolved by `CommerceAccess.customer(context)`; owner IDs are never accepted in a body. `setLine` sets an absolute quantity and upserts one line per variant; removal retains the row. All mutations require a stable key. Inputs reject unknown fields, and JSON prices use canonical nonnegative decimal strings. See the DTO interfaces and review for contracts.

Configure `COMMERCE_CURRENCY` (default INR), `COMMERCE_TAX_BPS` (0), `COMMERCE_SHIPPING` ("0" minor units), `COMMERCE_RESERVATION_SECONDS` (900), and `COMMERCE_STOCK_LOCATION_CODE` (MAIN). Provision that location through the existing inventory service; the app does not invent stock. Tax is exclusive, rounded half-up once on the merchandise subtotal. Flat shipping is untaxed. All calculations use bigint. The initial workflow uses one currency, one fulfillment location and at most 100 retained variant lines per order.

Draft prices are estimates refreshed from the catalog during editing and checkout. Checkout reserves all lines and freezes names, description, SKU, unit price, currency, quantity, pricing policy and totals in one transaction. `Draft -> PaymentPending -> Paid` uses stored states `draft -> placed -> paid`. Draft or PaymentPending without an unresolved managed payment may cancel. An unresolved attempt blocks cancellation and stock release until reconciliation. Authoritative payment decline cancels and releases; terminal orders cannot reopen or change snapshots. Legacy `fulfilled` orders remain readable and terminal.

`PaymentsService.start(context, {key, orderId})` is an internal, customer-authorized service API with no HTTP route. It derives amount/currency from the frozen checkout, requires complete unexpired reservations at admission and commits a durable attempt plus idempotency response before calling the provider. Repeated logical requests use the same stored outbound key; conflicting command fingerprints fail. A timeout/lost response records `unknown`, keeps the order PaymentPending and retains reservations. A fresh transaction records success, marks Paid and consumes the existing holds, or records a definitive decline, cancels and releases them. Duplicate confirmations cannot repeat stock movements. Complete active holds remain consumable after expiry for a confirmed managed payment during recovery. Passing the expiry timestamp alone never releases stock.

`PaymentProvider` defines typed charge, lookup and authenticated-notification verification. Only `DevelopmentPaymentProvider` is installed: a stable key deterministically selects success, decline, or a lost success response, and lookup returns the same simulated result across restarts. It never contacts a gateway or moves money. No caller chooses the scenario through a client DTO. There is no public development payment bypass or webhook route. Development notification verification always rejects; opaque notification authorities exist only in test fixtures. `NODE_ENV=production` disables development execution and the reconciliation CLI.

The preceding `OrdersService.recordPayment` boundary remains for compatibility with existing service tests, with its default fail-closed verifier. It cannot finalize an order that has a managed attempt. It never initiates provider calls. Existing legacy payment evidence is retained and not silently adopted for outbound recovery.

Run explicit reconciliation with runtime credentials against the identified, migrated development database:

```sh
npm run payment:reconcile
```

No arguments are accepted. The command verifies database identity and complete migration history, scans unresolved managed attempts in bounded pages and performs provider lookup outside transactions. An authoritative not-found result permits resubmission using the original key; lookup errors remain unknown. Each confirmed result finalizes atomically. Restart the command after a crash; successful attempts are terminal and skipped. It reports processed/unresolved counts and failed attempt IDs without credentials or provider payloads. Exit 0 means the scan found no unresolved/errors, 2 means unresolved/errors require attention, and 1 means command/configuration failure. New attempts committed after the scan passes their ID are picked up on the next invocation. Retain both attempts and idempotency records.

Provider idempotency, durable requests, unique references and reconciliation reduce duplicate-processing risk. External exactly-once execution is not guaranteed; real adapters need verified signatures, documented idempotency retention and provider-specific handling of conflicting/late terminal evidence and refunds before a public gateway is enabled.

## PostgreSQL integration verification

The safest local command creates a new temporary PostgreSQL cluster, provisions six new marked databases with separate runtime/migration roles, runs verification and stops only that cluster:

```sh
npm run test:postgres:isolated
```

It requires working local `initdb`, `pg_ctl`, `psql` and `postgres` binaries plus permission to create PostgreSQL shared memory and bind localhost. It uses a fresh data directory, private Unix socket directory, random loopback port and generated in-memory passwords. It ignores existing Docker volumes and servers. Logs and database files remain in the printed temporary directory for inspection. Failures exit nonzero; they are not reported as passed.

All four binaries must have the same major version. To require PostgreSQL 16, put a verified PostgreSQL 16 installation first on `PATH` and run `MNV_TEST_POSTGRES_MAJOR=16 npm run test:postgres:isolated`. A mismatch fails before cluster creation. The harness verifies the running cluster's data directory, port, administrator and server major before provisioning roles/databases. `node scripts/verify-boundary.js` performs read-only dependency/import, migration fingerprint, legal-record and named credential-pattern checks; it reports locations without matched values.

`npm run test:postgres` is an alias for the same isolated harness. Neither command targets a database supplied in `.env`. The harness verifies forward migration and rollback rejection on a new development database, then migration/upgrade and inventory tests on one disposable database, commerce tests on another, real authentication/authorization tests on a third disposable database, payment/reconciliation tests on a fourth and operational lifecycle tests on a fifth. Direct test files also verify disposable identity and require empty data; no truncate/reset helper is provided.

Migration tests exercise upgrades from the initial schema, retained legacy history, all five migrations, including revocation of retained pre-authentication sessions, repeat application, readiness and explicitly confirmed disposable rollback/reapplication. Payment tests cover durable-before-I/O, timeout retention, concurrent confirmations, duplicate/out-of-order notifications, crash recovery, atomic rollback and the actual reconciliation CLI. Inventory and commerce tests exercise real locks, contention, idempotency, atomic rollback, pricing, ownership, immutable snapshots, payment/cancellation races and transaction retry behavior. See the review documents for exact execution evidence.

Phase 7 adds last-unit contention and failed-key recovery, a genuine deadlock, deferred-COMMIT failure, lost acknowledgement after a successful COMMIT, actual worker SIGKILL followed by CLI reconciliation, cross-customer key conflict, application/pool shutdown and unavailable-database startup tests. The crash worker is test-only and accepts its bearer context through local IPC; it is never registered in the application.

## Rollback limitation

Reverts run newest first: payment reliability, authentication, commerce workflow, inventory engine, then initial schema. Payment rollback refuses a database containing any managed attempt, preserving recovery semantics. Earlier reverts remove their added columns/triggers while retaining original history; the initial revert drops all 13 commerce tables. No revert is an operational rollback strategy. Reverting the workflow also restores the old strictly-positive payment constraint, and therefore refuses data containing verified zero-value payments. The initial rollback leaves TypeORM's empty bookkeeping table and schema in place; rollbacks do not restore earlier schema ACLs. All are disposable-test-only.

Both the wrapper and migration `down()` require a database named `mnv_commerce_test_<unique_suffix>`, its `mnv-commerce:disposable-test` comment, and `MNV_ALLOW_DESTRUCTIVE_ROLLBACK` exactly equal to that database name. Only in that disposable environment:

```sh
npm run migration:revert
npm run migration:run
```

The database name confirmation must already be exported locally. Use a reviewed forward migration and backups for any database containing records that must survive.
