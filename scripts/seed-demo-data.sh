#!/usr/bin/env bash
#
# seed-demo-data.sh
# ------------------
# Populates a local database with sample accounts, claims, and webhook
# subscriptions for manual testing / frontend integration work.
#
# Idempotent: uses ON CONFLICT DO NOTHING keyed on publicKey / url, so it is
# safe to re-run against an already-seeded database.
#
# Usage:
#   ./scripts/seed-demo-data.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$REPO_ROOT/package.json" ] || ! grep -q '"bridgelet-sdk"' "$REPO_ROOT/package.json"; then
  echo "error: this does not look like the bridgelet-sdk repo root ($REPO_ROOT)." >&2
  exit 1
fi

: "${DATABASE_HOST:=localhost}"
: "${DATABASE_PORT:=5432}"
: "${DATABASE_NAME:=bridgelet}"
: "${DATABASE_USER:=bridgelet_user}"
export PGPASSWORD="${DATABASE_PASSWORD:-bridgelet_pass}"

PSQL="psql -h $DATABASE_HOST -p $DATABASE_PORT -U $DATABASE_USER -d $DATABASE_NAME -v ON_ERROR_STOP=1"

echo "Seeding demo accounts across statuses..."
$PSQL <<'SQL'
INSERT INTO accounts ("publicKey", "secretKeyEncrypted", "fundingSource", amount, asset, status, "expiresAt")
VALUES
  ('GDEMOACTIVE0000000000000000000000000000000000000001', 'demo', 'GDEMOFUNDER', 10, 'XLM', 'pending_payment', now() + interval '30 days'),
  ('GDEMOCLAIMED000000000000000000000000000000000000002', 'demo', 'GDEMOFUNDER', 25, 'XLM', 'claimed', now() + interval '30 days'),
  ('GDEMOEXPIRED000000000000000000000000000000000000003', 'demo', 'GDEMOFUNDER', 5, 'XLM', 'expired', now() - interval '1 day'),
  ('GDEMOFAILED0000000000000000000000000000000000000004', 'demo', 'GDEMOFUNDER', 15, 'XLM', 'failed', now() + interval '30 days')
ON CONFLICT ("publicKey") DO NOTHING;
SQL

echo "Seeding demo webhook subscription..."
$PSQL <<'SQL'
INSERT INTO webhooks (url, events, "isActive", description)
SELECT 'https://example.com/demo-webhook', '["sweep.completed","sweep.failed"]', true, 'Demo seed webhook'
WHERE NOT EXISTS (SELECT 1 FROM webhooks WHERE url = 'https://example.com/demo-webhook');
SQL

echo "Done."
