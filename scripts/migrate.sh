#!/usr/bin/env bash
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose "$@")
else
  compose=(docker-compose "$@")
fi

for migration in db/migrations/*.sql; do
  version="$(basename "$migration")"
  applied="$("${compose[@]}" exec -T postgres psql -U bankpilot -d bankpilot -Atc "SELECT 1 FROM schema_migrations WHERE version='$version'" 2>/dev/null || true)"
  if [[ "$applied" == "1" ]]; then
    echo "skip $version"
    continue
  fi
  echo "apply $version"
  "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U bankpilot -d bankpilot < "$migration"
done
