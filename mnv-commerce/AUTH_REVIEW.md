# Phase 4 authentication and authorization review

Completed 29 October 2026 in the existing `mnv-commerce/` application. The Phase 3 review, all existing migrations, access/payment boundaries, catalog/orders/inventory code, database grants and existing tests were read before implementation. Vendure packages, the backup and preceding migrations were retained. Git was not initialized, files were not published, no persistent database was migrated, and no Kafka, Redis, microservice or live payment credentials were added.

## Implemented contracts

`AuthModule` installs `AuthService` and the real `CommerceAccess` adapter. Registration and login accept exactly `{email,password}`. Email is lowercased and validated; password data is never normalized or truncated. Registration always inserts the database-default customer role. Neither customers nor administrators are marked verified: `email_verified_at` remains null. No verification, password reset, external identity or account-promotion endpoint exists.

`argon2@0.45.1` and its lockfile entries were added. Argon2id uses 65,536 KiB memory, three passes, one lane, 32 output bytes and a library-generated random salt. Input must contain at least 15 Unicode code points and at most 1,024 UTF-8 bytes; malformed Unicode is rejected. Long multibyte inputs, the complete maximum input, embedded NUL bytes, distinct random salts and differences beyond bcrypt's 72-byte limit were tested against the native library. The library's [official implementation/documentation](https://github.com/ranisalt/node-argon2) and [Argon2 specification](https://www.rfc-editor.org/rfc/rfc9106.html) informed the selection. There is no custom password-hashing algorithm or silent truncation.

Login verifies the password, then rechecks the hash and active account under a database SHARE lock before issuing a session. A cached random dummy hash gives absent-account attempts a real password verification. Wrong passwords, absent accounts, invalid legacy hashes and archived accounts have the same generic authentication rejection. User responses are SQL allowlists excluding password hashes. Entity mappings also exclude password/session hashes from ordinary repository selection. Registration conflicts and driver errors are sanitized before they can reach Nest logging.

Each login generates a new 32-byte cryptographically random opaque base64url token. Only its SHA-256 digest is stored in `sessions`; the bearer itself is returned once in the login response and never included in command fingerprints/replay responses. Absolute expiry is eight hours, calculated in PostgreSQL. No session cache or client-supplied lifetime exists. Tokens are accepted only in the Authorization bearer header, not cookies, query strings, identity objects or role fields. Missing/malformed/unknown/expired/revoked sessions return 401; authenticated wrong-role access returns 403.

Logout revokes the presented token. Well-formed unknown/already-revoked tokens receive the same idempotent result. Other sessions are independent. Account archival and role changes are re-read on subsequent authorization checks. Registration/login/identity HTTP responses set `Cache-Control: no-store`. Application code never logs request headers, cookies, credentials or session responses; the safe logger now explicitly redacts cookie/credential/bearer fields as well as existing password/token/authorization fields.

## Authorization and transaction boundaries

There are exactly two roles: `customer` and `administrator`.

- Every order/cart command and read resolves the customer from the bearer session inside the service. Owner, currency, totals, state and payment fields are not writable through the client DTOs. Foreign and missing orders return the same 404. Administrators do not gain customer impersonation privileges.
- Catalog writes require administrator authorization in `CatalogService`. Inventory reads, location changes, stock initialization and signed adjustments require administrator authorization in `InventoryService`. Audit actors come from the session; client `actor` and extra fields are rejected.
- Mutations repeat authorization inside the complete transaction **before** idempotency replay and lock both session and user with SHARE locks. Logout or archival cannot commit through those locks while the admitted mutation is active. An already-authorized transaction may finish before concurrent logout returns. A live lock test observes the actual logout wait and verifies denial after revocation completes.
- Existing inventory logic moved to the explicitly trusted internal `InventoryEngine`. The authorized inventory facade and `OrdersService` use it with the same transaction manager. Existing adjustment entry points now accept the same validated transaction-scoped manager path as reservations. The engine is not wired to any HTTP route. Reservation allocation/release/consumption remain server operations; callers must not expose the engine to client inputs.
- The inventory transaction helper remains the retry owner; checkout still retries the entire operation with a fresh runner for only serialization/deadlock SQLSTATEs. Authorization failure rolls back all request claims and writes.

Customer routes are `POST /orders`, `GET /orders/:id`, `PUT /orders/lines`, `POST /orders/lines/remove`, `POST /orders/checkout` and `POST /orders/cancel`. Administrator catalog routes are under `/admin/catalog/products` (including product variant routes); inventory routes are under `/admin/inventory` (`locations`, `stock/:variantId/:locationId`, `initialize`, `adjust`). `GET /catalog` remains public. See README for exact inputs.

## Administrator creation

Run `npm run admin:create` from this application directory using separate migration-owner database credentials supplied by the existing secret-management environment. The command requires an interactive terminal and no arguments, prompts for email, then twice for a hidden password. It does not read account passwords from command arguments, environment variables or piped input. Oversized input is rejected; echo remains disabled until Enter even after an oversized paste. Failure messages contain neither credentials nor driver/SQL details.

The command verifies the dedicated database identity, owner role and complete known migration history, and inserts only a new administrator. Duplicate email fails without updating/promoting an existing customer. There is no default administrator, bootstrap password or permissive authorization bypass. Integration tests provision only fixtures in a freshly created disposable database and test refusal to promote an existing email, invalid command arguments and non-TTY invocation. A separate pseudo-terminal check confirmed hidden password/confirmation input and generic mismatch rejection before database access.

## Migration and database privileges

New forward migration: `Authentication1793404800000` in `src/database/migrations/1793404800000-authentication.ts`. It adds checked `users.role` defaulting to customer and nullable `email_verified_at`, and revokes all pre-authentication sessions without deleting their digests/history. It preserves all existing account hashes, orders, inventory and payment data. Existing unsupported password hashes cannot authenticate; no insecure legacy fallback was introduced. The upgrade test checks field-by-field preservation of a legacy user/session, default customer/unverified status and denial of the old bearer token.

The migration wrapper now grants runtime user INSERT only on email/password hash and UPDATE only on password hash/archive time. Runtime cannot write roles or verification timestamps, even by direct SQL. Session writes permit only insertion of owner/digest/expiry and revocation updates; runtime cannot extend session expiry, reassign sessions or delete them. Existing history, stock counter, ownership/snapshot and lifecycle protections remain intact. Database grants protect against accidental runtime privilege writes; the trusted application/database owner remains a security boundary.

All preceding migration SHA-256 values remain unchanged:

- Initial: `cdfd994a23ce463ced2393b6248832deaf0f20c63c1cb1b9e96fc7432831b406`.
- Inventory: `49907c5145bd793fa82d8c3abc83ab00f36808c4df5bdd3f0f9c76e69271d389`.
- Commerce workflow: `1635660e0a535691c7caefbcb40e7f1d926a008ea2a5aaacca584d5fca69e5ea`.

The schema still has 13 domain tables plus migration metadata, 14 restrictive foreign keys, 9 UNIQUE constraints and 40 indexes; it now has 53 CHECK constraints. Disposable-only exact-confirmation rollback/reapplication covers all four migrations. Authentication rollback removes its new columns but deliberately does not restore revoked sessions or previous ACLs. Startup still never synchronizes or migrates.

## Payment boundary and preserved invariants

There is no payment confirmation HTTP endpoint for customers **or** administrators. `PaymentResultVerifier` still rejects every result until a real authoritative provider adapter is configured. Client booleans, role assertions, fake `verified` flags and forged evidence cannot mark an order paid. Tests exercise attempted payment/commit HTTP routes and direct service evidence forgery, verifying PaymentPending state, held stock and zero payment rows afterward. Successful payment tests continue to use an explicit test-only authority, never installed in the application.

The existing commerce suites passed unchanged invariant assertions: exact bigint pricing/rounding, frozen checkout snapshots, uniqueness, ownership, concurrent stock contention without overselling, idempotency, full rollback on failures, four complete transaction attempts, verifier invocation once across retries, immutable payment evidence and payment/cancellation races. Existing fixtures now explicitly import the trusted internal engine; actual client authorization is exercised by the new real-session suite. Real-session concurrent duplicate checkout reserves once and authenticated cancellation releases the exact holds. Final counter audits equal active reservations.

## Executed verification

Final commands ran from `/Users/munavark/Downloads/vendure-master/mnv-commerce`:

| Command | Exact final result |
| --- | --- |
| `npm run typecheck` | Passed; `tsc -p tsconfig.json --noEmit`, exit 0. |
| `npm run build` | Passed; `tsc -p tsconfig.json`, exit 0. |
| `npm test` | Passed; 29 tests, 29 passed, 0 failed/cancelled/skipped. Includes 11 new auth unit tests and the 18 preceding unit tests. |
| `npm run test:postgres:isolated` | Passed; migration 7, inventory 15, commerce 13, authentication 12 reported passes; **47 total including 4 parent tests and 43 subtests**, 0 failed/cancelled/skipped. |
| `npm audit --json` | Exit 1: 4 dependency findings (2 high, 1 moderate, 1 low), detailed below; not claimed as clean. |

The final live run used Node 26.5.0 and PostgreSQL **18.4 (Homebrew)** on **127.0.0.1:50162**, in a newly initialized temporary cluster. Four newly provisioned, purpose-marked databases were used with separate `mnv_migrator` owner and unprivileged `mnv_runtime` credentials:

- `mnv_commerce_dev_7a608b499844`: development forward migration and refused rollback.
- `mnv_commerce_test_7a608b499844`: legacy upgrade, disposable rollback/reapplication and inventory tests.
- `mnv_commerce_test_7a608b499844_workflow`: existing commerce invariants starting from empty migrated tables.
- `mnv_commerce_test_7a608b499844_auth`: real authentication/service/HTTP authorization starting from empty migrated tables.

Evidence: `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-GZLpah/verification.json`, with retained cluster files/server logs alongside it. Actual database name, owner, runtime role, address/port, purpose marker, schema/history and expected empty starting state were checked. The harness stopped its server in `finally`; an independent status check confirmed no server running. No existing cluster/database/volume was reset.

An initial sandboxed dependency install could not resolve the registry, and the sandboxed PostgreSQL harness could not start its local server. Both completed with the necessary execution permission. The first unit run exposed a test assuming one ordering of Argon2's encoded parameters; the assertion now parses/sorts parameters and checks their values. Earlier failed/incomplete attempts are not counted as passing. Final full checks were rerun after the last source/test changes.

## Remaining limitations

- Public payment confirmation remains disabled pending trusted provider verification, durable external idempotency and reconciliation/refund infrastructure. This phase stops at authentication/authorization.
- No email delivery/verification, password reset, external identity, MFA, account-management or customer-to-admin promotion workflow exists. Existing legacy placeholder/unsupported hashes require a separately reviewed recovery path. Administrator provisioning can only insert a new unique email.
- HTTPS termination and credential-safe proxy logging are deployment responsibilities. Public deployment also needs request throttling; no distributed limiter, brute-force lockout or load benchmark was added. Hash costs were functionally verified, not calibrated against production capacity.
- Sessions expire absolutely, without refresh/sliding expiry or a cleanup worker. Revoked/expired digests remain stored. Logout revokes only the presented token. Role changes and archival apply at the next authorization check; admitted transactions may finish before revocation returns.
- The existing automatic-reservation-expiry/recovery, pagination, pricing-policy, fulfillment and refund limitations described in the preceding review remain. Stock expiry still requires explicit cancellation/release.
- `npm audit` reports existing-stack findings in `@nestjs/platform-express`/`multer` (high), `typeorm` (moderate) and development `esbuild` (low). No finding was attributed to Argon2. Framework/dependency upgrades were not bundled into this phase. The application has no upload routes, uses PostgreSQL and does not generate migrations from untrusted metadata; this does not constitute an audit remediation or production security review.
- Live tests used PostgreSQL 18.4 rather than the Compose PostgreSQL 16 image. Production load, failover, TLS/proxy configuration, deployment and owner compromise were not tested. No persistent application environment has received the new migration.
