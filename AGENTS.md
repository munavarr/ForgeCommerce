# MNV Commerce

The sole application is `mnv-commerce/`. The root contains documentation, legal records and application-only CI; there are no workspaces or sibling package build requirements.

## Development

Run from `mnv-commerce/`: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`. Use `npm run dev` for source development. Keep the npm lockfile committed and every direct dependency declared. Do not reintroduce upstream workspace tooling for application commands.

## Database and commerce invariants

- PostgreSQL `synchronize` and `migrationsRun` must remain false. Use the guarded migration commands only; never the generic TypeORM CLI/schema generator.
- Preserve applied migrations byte-for-byte; add reviewed forward migrations for changes.
- Use `npm run test:postgres:isolated` for database verification. It creates and stops only its own fresh temporary cluster; never reset existing servers, databases or volumes. Do not remove retained test evidence without authorization.
- Preserve bigint money, immutable order/payment/history evidence, least-privilege runtime grants, ownership checks, complete transaction retries, inventory locking and durable payment reconciliation.
- No live payment gateway, credentials or permissive development webhook. Development simulation remains disabled in production.

## Security and provenance

Keep `.env.example` placeholder-only. Never print suspected secrets. Real environment files, private keys, database dumps and backups must stay out of source, Docker and CI context. Do not overwrite the protected backup. Preserve root/application licence texts and upstream attribution; do not claim inherited Vendure work was originally authored from scratch.

The five phase reviews and cleanup/ records describe prior work and evidence. Do not treat earlier implementation-stage limitations as current requirements when a later review supersedes them. No Git initialization, remote, publication or persistent-data destruction without explicit user authorization. Do not infer production readiness or PostgreSQL 16 compatibility from other local checks.
