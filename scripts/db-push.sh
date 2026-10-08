#!/usr/bin/env bash
# Apply every migration in supabase/migrations to the database that
# SANAD_DATABASE_URL names in .env.local, in order, recording each in the
# database's own migration ledger so a second run applies only what is new.
#
#   npm run db:push
#
# The connection string is read from .env.local and never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env.local"

[ -f "${ENV_FILE}" ] || { printf 'No .env.local. Run: npm run db:connect\n' >&2; exit 1; }
URL="$(grep '^SANAD_DATABASE_URL=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
[ -n "${URL}" ] || { printf 'SANAD_DATABASE_URL is not set in .env.local. Run: npm run db:connect\n' >&2; exit 1; }
HOST="$(printf '%s' "${URL}" | sed -E 's#^[a-z]+://([^@/]*@)?([^/:?]+).*#\2#')"

printf 'Applying migrations to %s ...\n' "${HOST}"
cd "${ROOT}"
# --yes: no prompt; --include-all: files the ledger has not seen, whatever their version order.
npx --yes supabase db push --db-url "${URL}" --yes --include-all
printf 'Done. Restart the apps so they read %s.\n' "${HOST}"
