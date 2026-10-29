# Phase 6 — Vendure removal and repository reduction

Completed 29 October 2026 in `/Users/munavark/Downloads/vendure-master`. The independently runnable backend is `mnv-commerce/`. No repository was cloned, Git initialized, remote configured, files published/uploaded, live payment adapter enabled, or persistent database/volume modified.

## Inspection and protected backup

Read the current AGENTS.md, five on-disk phase reviews, earlier foundation/validation reports from the “Build MNV Commerce foundation” chat, root/application manifests, Bun and both npm lockfiles, TypeScript/test configuration, all upstream workflows/actions and the actual application import graph. There was no additional foundation review file on disk. The earlier manifest was not treated as proof of current dependencies.

The protected archive was read directly at:

`/Users/munavark/Downloads/mnv-commerce-backups/stage-3a-original-20261028T071339Z/vendure-master-original.tar.gz`

Its contents could be listed and its SHA-256 matched before deletion and after cleanup:

`5390dfa2144f177b5e08f1d93b047d40ba0e3ebb60eb759b12a83a3c65b5dea7`

Archive mode remains 0400; parent mode 0500. No backup was created, extracted, moved, modified or overwritten. The initial attempt to list Downloads failed with macOS `Operation not permitted`, including with elevated execution. The exact path was subsequently recovered from the prior foundation report and independently confirmed by the user; direct access succeeded. No further Downloads enumeration was attempted. Archive member totals include macOS metadata, so they are not used as the logical original-source count.

The pre-deletion plan is [PLAN.md](PLAN.md). [deletions.json](deletions.json) records every deleted file, original byte length, SHA-256 and assigned batch. [batches.json](batches.json) records actual deletion results. Each deletion required the actual target file list and hashes to match the recorded inventory. Explicit paths were used throughout; no blanket wildcard deletion was performed. No original deleted file remains at its old path. The workflows directory was subsequently recreated for the new application CI.

## Deletion evidence and independent boundary

| Batch | Removed | Files | Bytes | Verification after removal |
| --- | --- | ---: | ---: | --- |
| 1 | Admin UI/dashboard, UI devkit, CLI/scaffolding, MCP, optional plugins, telemetry plugin, development server, docs site, upstream workflows/actions/community templates, dashboard agent rules and upstream skills | 4,478 | 65,723,319 | Typecheck/build; 43 unit passes; 295 application import edges valid. |
| 2 | Upstream testing/e2e harness, root scripts, root manifest and dependencies, Bun/Lerna configuration and lockfile, root TypeScript/Vitest/GraphQL/generated schemas, development Compose, lint/hooks/editor/review tooling and release history | 107 | 3,437,812 | Typecheck/build; 43 unit passes; root workspace configuration absent; all imports resolve inside the app. |
| 3 | `packages/core`, `packages/common`, then the empty `packages/` directory | 1,309 | 17,315,506 | Fresh application npm install, typecheck/build, 43 units, all 66 PostgreSQL reported passes, migration/reconciliation/start/dev command smoke checks. |
| Total | Exact inventory retained for review | **5,894** | **86,476,637** | No commerce source or test implementation removed. |

Core/common were removed only after clean installation, all units, and all 66 isolated PostgreSQL reported tests passed independently. Their generated output directories were absent even before removal. The full PostgreSQL suite passed again after removal. Intermediate references inside the then-pending upstream tooling/core were removed in their assigned batches; none was an application dependency.

All **56 original TypeScript/JavaScript source, test and harness files**, plus the migration `.gitkeep`, retain their original SHA-256 values. Every migration and commerce implementation is byte-for-byte unchanged. The five historical phase reviews, application tsconfig and placeholder environment example are unchanged. [preserved-before.json](preserved-before.json) provides the original fingerprints; [verification.json](verification.json) contains the final comparisons and migration hashes.

The application manifest now declares eight runtime and three development dependencies. Removed unused direct dependencies: `@nestjs/typeorm` and `tsx`, with their unreachable lockfile dependency closure. The app uses its own Nest DataSource provider and ts-node for development. `@nestjs/platform-express` and `pg` remain explicit dependencies because Nest and TypeORM load them at runtime. All other exact direct versions remain unchanged. Lockfile v3 has 221 entries including the application root, with no local/workspace links and only public npm registry package resolutions. Clean installation adds 220 packages.

The root manifest and all its workspace dependencies, optional platform packages, publishing/versioning/codegen scripts and Git hooks were removed. No root package manager installation is needed. No Bun, Lerna, Vendure build output or parent TypeScript configuration is used by application commands. Schema synchronization and startup migrations remain disabled.

## Documentation, legal and security changes

Updated root/application READMEs, AGENTS.md, CONTRIBUTING.md and SECURITY.md to describe the actual application. Added [NOTICE.md](../NOTICE.md) with Vendure provenance and copyright. The extraction identifies Vendure 3.8.1; no upstream commit hash was available, and no original-authorship or upstream-endorsement claim is made.

All six original root legal files, including the GPL text, plugin exception, FAQ, CLA and historical signature record, remain byte-for-byte unchanged. The original licence notice, GPL, exception, FAQ and CLA were also copied into the application so it carries its legal context independently. Installed third-party package notices remain with their packages. No required legal text was removed.

Root/application Git ignores now exclude environment variants, registry credential files, private keys, databases/dumps, archives and backups, while allowing the placeholder `.env.example` and the npm lockfile. Docker contexts use source/build-input allowlists plus explicit sensitive-file exclusions. CI uses a sparse checkout of application source, tests, scripts, manifests and legal records, with explicit exclusions for sensitive material. No real environment file, key, dump or backup was found in the retained source tree. PostgreSQL test clusters and logs remain outside the project.

The local Compose file now requires `POSTGRES_PASSWORD` supplied from the local environment and binds the port to loopback. Its existing volume definition was retained and never started or deleted. The bootstrap database user remains administrative; operators must provision the documented separate roles and purpose marker. `.env.example` remains placeholder-only and unchanged.

All upstream publishing, deployment, telemetry, SonarCloud, release, back-merge, CLA bot and external contribution automations were removed. The single replacement `.github/workflows/ci.yml` runs application installation, typecheck/build, units, isolated PostgreSQL tests and npm audit with read-only repository permissions. It contains no publishing, deployment, upload, external exporter or user-secret access. YAML was parsed locally; remote CI was not dispatched.

## Commands actually executed

Unless otherwise stated, commands ran from `/Users/munavark/Downloads/vendure-master/mnv-commerce` with Node **26.5.0**, npm **11.17.0** and local PostgreSQL **18.4 (Homebrew)**.

| Exact command | Final result |
| --- | --- |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --cache /private/tmp/mnv-phase6-npm-cache` | Exit 0; lockfile pruned after removing the two unused declarations. No direct dependency upgrade. |
| `npm ci --cache /private/tmp/mnv-phase6-npm-cache --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000` | Exit 0, 220 packages. Repeated successfully after all upstream packages/tooling were absent. npm ci removes/replaces the application's installed dependency tree from its lockfile. |
| `npm run typecheck` | Exit 0. |
| `npm run build` | Exit 0. |
| `npm test` | Exit 0; **43 passed**, 0 failed/cancelled/skipped. Passed after each deletion batch. |
| `npm run test:postgres:isolated` | Exit 0 before core/common removal and again after cleanup; **66 reported passes**, including 5 parents and 61 subtests, 0 failed/cancelled/skipped. Migration 7, inventory 15, commerce 13, authentication 12, payments 19. |
| `node /private/tmp/mnv-phase6-command-smoke.js` | Exit 0; provisioned a separate fresh purpose-marked disposable database and ran the npm commands in the following rows with generated in-memory credentials. |
| `npm run migration:show` | Exit 0 on the new empty disposable database, before any schema mutation. |
| `npm run migration:run` | Exit 0; applied all five validated migrations using the separate owner/migration role. |
| `npm run migration:run` | Exit 0 on repeat; no pending migration. |
| `npm run migration:show` | Exit 0; all five migrations reported executed, no pending migration. |
| `npm run payment:reconcile` | Exit 0 on the empty migrated database; development provider, processed 0, unresolved 0, errors empty. Real persisted-attempt recovery and repeat CLI behavior also passed in the 19 payment integration tests. |
| `npm run start`, `npm run dev` | Each started with the runtime role on a fresh loopback HTTP port; `/health/live` and `/health/ready` both returned 200. Only these task-created process groups were then stopped. |
| `npm ls --depth=0` | Exit 0; all 11 exact direct dependencies resolved. The separate targeted absence query for `@nestjs/typeorm tsx esbuild` returned an empty tree (npm's expected exit 1 for no match). |
| `node /private/tmp/mnv-phase6-imports.js` | Exit 0 after batches and final cleanup. AST scan: 56 files, 295 imports/requires, no missing/escaping import, undeclared direct dependency, external package resolution, path alias, parent script or local lockfile link. |
| `python3 /private/tmp/mnv-phase6-security.py` | Exit 0. Named credential patterns, sensitive artifacts, executable upstream references and external telemetry checks are clear; literal credential-related matches are test fixtures. Suspected values are never emitted. |
| `npm audit --json --cache /private/tmp/mnv-phase6-npm-cache --fetch-retries=0 --fetch-timeout=20000` | Exit 0; **0 vulnerabilities** at every severity. No audit fix, blind upgrade or override was used. |

Initial sandboxed registry installation/audit attempts failed with ENOTFOUND; authorized network-enabled retries supplied the successful results. The first sandboxed PostgreSQL harness could not start; authorized isolated execution passed. These failed access attempts are not counted as successful verification. A root-directory lockfile-only install was interrupted immediately before it wrote a lockfile or installed packages; all completed installations and dependency mutations were performed in the application directory.

npm reported a deprecated transitive `glob@10.5.0` and a pending install-script-policy notice for Argon2. These are installation warnings, not audit findings. The bundled native Argon2 implementation loaded and passed actual hashing, verification and authentication tests after the final clean installation. Other platform-specific native builds were not tested and may require local install-script policy review.

Additional local checks from the repository root:

- `ruby -ryaml -e 'ARGV.each { |p| YAML.parse_file(p); puts "YAML parsed: #{p}" }' .github/workflows/ci.yml mnv-commerce/docker-compose.yml` — exit 0.
- `docker compose -f mnv-commerce/docker-compose.yml config --quiet` — exit 1 without the required bootstrap password; exit 0 with a generated temporary value supplied only through the child process environment. No Compose service or volume was started.
- `pg_ctl -D <each-task-cluster>/data status` — exit 3, `no server running`, independently confirmed for every successfully started task cluster.
- SHA-256 comparisons — every original application source/test/harness and root legal record preserved; all five migration digests match the original phase evidence and the Phase 6 initial snapshot.

## Disposable database identities and evidence

The final full-suite cluster listened only on `127.0.0.1:50822`, using owner `mnv_migrator` and separate unprivileged runtime `mnv_runtime`. It verified dedicated names, owner, role, server address/port, purpose comment, migration history and empty initial domain data:

- `mnv_commerce_dev_6e7513fd1774` — development marker, public schema; forward application and rejected rollback.
- `mnv_commerce_test_6e7513fd1774` — disposable marker, mnv schema; migration upgrade/rollback/reapplication and inventory.
- The same test base with `_workflow`, `_auth`, `_payments` suffixes — separate empty disposable databases for the corresponding domain suites.

Evidence: `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-postgres-AWdffK/verification.json`; full output: `/private/tmp/mnv-phase6-final-postgres.log`. The preceding independent run is at `.../mnv-postgres-LISJBW/verification.json` and `/private/tmp/mnv-phase6-before-postgres.log`.

The operational command smoke cluster used `127.0.0.1:50894`, database `mnv_commerce_test_344e9a5bed88_commands`, owner `mnv_migrator`, runtime `mnv_runtime`, public schema and the disposable-test marker. Identity and zero initial user tables were independently checked before the first application command. Evidence: `/var/folders/yq/cc_0bmxn2cd8dy3yrrxhjngh0000gn/T/mnv-phase6-commands-inwqlp/verification.json`; output: `/private/tmp/mnv-phase6-command-smoke.log`.

Both harnesses stopped only their own clusters in finally blocks. Independent status commands confirmed the servers were stopped; database files/logs remain in temporary locations outside the runnable project. They may later be removed by the operating system. Sanitized identities/results are copied into [verification.json](verification.json); no passwords, connection strings or provider payloads are recorded.

## Remaining upstream references and final structure

There are **zero `@vendure/*` imports or dependencies**, workspace aliases, upstream package commands or configured external telemetry in the runnable application/CI. Remaining Vendure text is intentional provenance in legal documents, READMEs, historical phase reviews, cleanup records, the environment-example warning and one database safety comment rejecting unrelated targets. The installed dependency lockfile does not resolve any Vendure package. Historical deletion paths identify what was removed and are not runnable references.

```text
vendure-master/
  .github/workflows/ci.yml
  .editorconfig, .gitignore, .dockerignore
  AGENTS.md, README.md, CONTRIBUTING.md, SECURITY.md
  LICENSE.md, license/                 original legal records
  mnv-commerce/
    package.json, package-lock.json, tsconfig.json
    .env.example, .gitignore, .dockerignore
    docker-compose.yml                optional database only
    README.md, NOTICE.md, LICENSE.md, license/
    MIGRATION_REVIEW.md, INVENTORY_REVIEW.md, COMMERCE_REVIEW.md
    AUTH_REVIEW.md, PAYMENT_REVIEW.md
    src/
      auth/, commerce/, common/, config/
      database/entities/, database/migrations/   five unchanged migrations
      inventory/, payments/
      main.ts, app.module.ts, health.controller.ts
    test/                             all original unit/integration tests
    scripts/test-postgres-isolated.js  original guarded harness
    cleanup/                          plan, inventories, fingerprints, evidence
    node_modules/, dist/              local generated output, ignored
```

The retained non-generated tree is approximately **2 MiB**, including the exact deletion inventory. Installed dependencies and compiled output remain local ignored artifacts and are excluded from Docker/CI source context. The original external protected backup is excluded from this size and from the runnable project.

## Limits and manual security actions

- Tests used **PostgreSQL 18.4**, not PostgreSQL 16. The Compose image and minimum supported Node version were not executed. The replacement GitHub workflow was not run remotely. Docker validation was configuration-only.
- Local test/audit success does not establish production readiness. No persistent application database was provisioned or migrated. Existing deployment, failover/load, authentication recovery/MFA/throttling, pricing/fulfillment/refund and scheduler limitations remain in the preceding reviews.
- Payment remains internal development simulation. No live gateway, webhook, credentials or funds were introduced. Reconciliation/inventory invariants and the production simulation refusal are preserved.
- The owner of the previously identified Google Maps credential must assess provider-side **revocation/rotation and restrictions**. Deletion did not revoke it, and its earlier source remains inside the protected backup. Keep that backup private and outside uploads, CI and build contexts; its contents were not printed or altered.
- Before public deployment, provision the separate database roles, isolate migration credentials, and supply HTTPS, request throttling and credential-safe proxy/access logs. No new default account or credential is provided.

Work stops after Phase 6 cleanup and verification.
