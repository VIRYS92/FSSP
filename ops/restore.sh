#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${BACKUP_DIR:?BACKUP_DIR must point to one backup directory}"
: "${CONFIRM_RESTORE:?set CONFIRM_RESTORE=YES to restore}"

if [[ "$CONFIRM_RESTORE" != "YES" ]]; then
  echo "Refusing restore: set CONFIRM_RESTORE=YES" >&2
  exit 1
fi

backup_dir="$(cd "$BACKUP_DIR" && pwd)"
[[ -s "$backup_dir/database.dump" ]] || { echo "database.dump is missing" >&2; exit 1; }
[[ -f "$backup_dir/documents.tar.gz" ]] || { echo "documents.tar.gz is missing" >&2; exit 1; }
[[ -f "$backup_dir/SHA256SUMS" ]] || { echo "SHA256SUMS is missing" >&2; exit 1; }
(cd "$backup_dir" && sha256sum --check SHA256SUMS)

if ! docker compose ps --services --filter status=running | grep -qx "postgres"; then
  echo "postgres service must be running" >&2
  exit 1
fi

echo "Stopping application and worker before restore"
docker compose stop app worker

echo "Restoring PostgreSQL dump"
docker compose exec -T postgres pg_restore \
  --clean \
  --if-exists \
  --exit-on-error \
  --no-owner \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  < "$backup_dir/database.dump"

echo "Restoring documents"
docker compose run --rm --no-deps --user root \
  -v "$backup_dir:/backup" \
  worker \
  sh -c 'rm -rf /var/lib/fssp/documents/* /var/lib/fssp/documents/.[!.]* /var/lib/fssp/documents/..?*; tar --extract --gzip --file=/backup/documents.tar.gz --directory=/var/lib/fssp/documents; chown -R node:node /var/lib/fssp/documents'

echo "Rechecking migrations and starting services"
docker compose run --rm migrate
docker compose up -d app worker

app_port="${APP_PORT:-3000}"
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${app_port}/readyz" >/dev/null; then
    echo "Restore complete; readiness check passed"
    exit 0
  fi
  sleep 2
done

echo "Restore finished but readiness check did not pass" >&2
exit 1
