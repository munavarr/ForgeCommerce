# Phase 6 removal plan — 29 October 2026

The current tree, AGENTS.md, five on-disk phase reviews, earlier foundation/validation reports, both application/root manifests, all three lockfiles, TypeScript/test configurations and every existing CI workflow were inspected before changes. The application has 56 source/test/script files and 295 static import/require edges. No relative import escapes `mnv-commerce/`, no edge is missing, and no application import uses an upstream workspace package. Nest loads `@nestjs/platform-express` and TypeORM loads `pg` at runtime; both remain explicit direct dependencies.

## Protected source

The original archive is outside this tree:
`/Users/munavark/Downloads/mnv-commerce-backups/stage-3a-original-20261028T071339Z/vendure-master-original.tar.gz`.
It was read and listed successfully; SHA-256 remains `5390dfa2144f177b5e08f1d93b047d40ba0e3ebb60eb759b12a83a3c65b5dea7`. File permissions are 0400; its parent is 0500. No copy, extraction, permission change or overwrite is needed. Archive member counts include macOS metadata; the checksum is the identity check.

## Boundary first

- Keep all existing commerce source, five migrations, unit/integration tests, guarded operational commands and historical phase reviews.
- Keep the npm v3 application lockfile; remove only unused `@nestjs/typeorm` and `tsx` declarations and their unreachable dependency closure. Keep the exact versions of all other direct dependencies. There is no imported Nest TypeORM adapter: the application supplies its own DataSource provider. Development uses ts-node, not tsx.
- Copy upstream licence texts into the independent application and add provenance. Preserve the original root LICENSE.md and entire license directory byte-for-byte.
- Correct root/application documentation and ignore rules. Remove Compose's built-in example password; require local environment provisioning. Keep its volume definition and do not start it.

## Explicit deletion batches

`deletions.json` is the exact file-level deletion inventory with pre-deletion sizes and SHA-256 values. Its `batches` field enumerates every directory/file deletion target; no wildcard deletion is used.

1. **Unused surfaces:** packages/admin-ui, admin-ui-plugin, asset-server-plugin, cli, create, dashboard, dev-server, email-plugin, graphiql-plugin, harden-plugin, job-queue-plugin, mcp-plugin, mcp-sdk, telemetry-plugin and ui-devkit; docs; upstream GitHub workflows/actions/issue templates/funding/ownership/PR templates; dashboard editor rules and upstream agent skills. These have no incoming application edge. The release, publishing, deployment, SonarCloud, CLA bot, back-merge and telemetry integrations belong to those removed surfaces.
2. **Workspace tooling:** packages/testing; e2e-common; root scripts; Lerna/Bun manifests and lock/configuration; root TypeScript/Vitest/GraphQL configurations and generated schemas; root development Compose, lint/format/hook/review/editor configuration, release changelogs and obsolete CONTEXT.md. The application uses Node's built-in test runner and its own TypeScript config. All root dependencies, optional platform packages, workspaces, codegen, publishing and hook scripts disappear with the obsolete root manifest. Replace upstream CI with application-only install/typecheck/build/unit/isolated PostgreSQL checks, without publishing or credential access.
3. **Core/common last:** packages/core and packages/common, only after clean independent installation, typecheck/build, units, migration and live PostgreSQL suites succeed without their output. Their useful invariants are already implemented and tested inside the retained application; do not rewrite or delete those implementations.

After each batch inspect actual deletions, scan the retained runnable boundary for broken imports/aliases/script references, build and run unit tests. Preserve all source/test/migration hashes. Intermediate references inside the not-yet-removed upstream tooling/core are inventory leftovers, not application dependencies; remove that obsolete tooling in its assigned batch. Run the complete isolated database suite before and after core/common removal.

## Verification and security

Use `npm ci` from the application directory with a temporary npm cache, then typecheck/build, all units, isolated PostgreSQL integration, guarded migration status/repeat execution and payment reconciliation. The harness creates and stops only its own fresh cluster and verifies purpose-marked empty test databases. Retain evidence outside the runnable tree. Run npm audit and dependency/import/telemetry/credential scans without printing suspected values. Keep real environment files, keys, dumps, backups and generated output out of Git, Docker and CI context. Deletion does not revoke the previously identified Maps credential in the protected backup; its owner must assess rotation/revocation separately.

No Git initialization, remote, publication, live provider, persistent database mutation, synchronization, startup migration or production-readiness claim is part of this phase. PostgreSQL 16 compatibility remains untested unless an actual PostgreSQL 16 run is recorded.
