# Security

MNV Commerce is a locally validated development backend. No production security certification, public vulnerability-reporting address or live payment provider is configured. Do not send reports, account data or credentials to upstream Vendure contacts on this project's behalf.

Keep credentials in your own secret-management environment. Do not commit real `.env` files, private keys, database dumps or backups. Use separate unprivileged runtime and owner/migration roles as described in [the application README](mnv-commerce/README.md). Before exposing credential endpoints, provide HTTPS, request throttling and credential-safe proxy logs. Preserve payment attempts and idempotency records during uncertain outcomes.

A suspected Google Maps credential was removed in the foundation phase; the original protected backup still contains the earlier source. Its owner must assess revocation/rotation and provider-side restrictions. Deleting files does not revoke credentials. Keep the backup private; do not upload it or include it in builds or CI. This cleanup does not modify or scan the backup's secret contents.

Run `npm audit` from `mnv-commerce/` and review new findings before changing dependencies. A clean audit is a point-in-time dependency check, not proof that application or deployment vulnerabilities are absent. Current verification and remaining limits are in [the cleanup review](mnv-commerce/cleanup/REVIEW.md).
