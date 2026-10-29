# Provenance and attribution

MNV Commerce was developed within an extracted copy of the Vendure repository, identified by its Lerna manifest as version 3.8.1. Upstream: https://github.com/vendurehq/vendure. The exact upstream commit was not recorded in this extraction; no commit identity is asserted.

Vendure copyright: **Copyright (C) Vendure GmbH**. The original upstream licence notice is preserved unchanged in LICENSE.md, with the GNU GPL v3 text and upstream plugin exception in license/. The upstream licensing FAQ and contributor agreement are retained as historical legal documents. Their references to upstream products, commercial licensing and contributors remain upstream statements.

The foundation and five commerce implementation phases produced the small NestJS/PostgreSQL application in this directory. Phase 6 removed the unused Vendure packages and workspace infrastructure. Inventory concurrency, order state transitions, monetary precision and idempotency work was informed by the Vendure starting point. This project does not claim that inherited or adapted Vendure work was originally authored from scratch, nor imply Vendure endorsement. There are no remaining runtime imports from Vendure packages.

Modifications and validation are described in the phase review documents and cleanup/REVIEW.md. The application is retained under the upstream GPL terms; no separate commercial licence is granted here. Third-party npm libraries retain their own notices and licences in their installed packages and the resolved dependency inventory in package-lock.json. Preserve those notices when distributing their code.
