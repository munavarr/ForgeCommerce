# MNV Commerce

The independently runnable backend is in [mnv-commerce/](mnv-commerce/README.md). It includes PostgreSQL migrations, inventory, catalog, checkout/orders, authentication and development payment reconciliation.

```sh
cd mnv-commerce
npm ci
npm run typecheck
npm test
npm run test:postgres:isolated
```

Configure runtime and separate migration credentials locally as described in the application README before using `npm run migration:show`, `npm run migration:run`, `npm start` or `npm run payment:reconcile`. Startup never synchronizes the schema or applies migrations. No live payment provider is configured.

This tree was reduced from an extracted Vendure 3.8.1 monorepo. See [provenance](mnv-commerce/NOTICE.md), the unchanged [upstream licence notice](LICENSE.md) and [Phase 6 cleanup evidence](mnv-commerce/cleanup/REVIEW.md). Historical phase reviews remain in the application. No Git repository or remote has been initialized, and nothing has been published.

The protected original backup remains outside this project. Do not place backups, real environment files, keys or database dumps in this tree. Removing a credential from this tree does not revoke it. Local tests do not establish production readiness; PostgreSQL 16 has not been tested here.
# ForgeCommerce
