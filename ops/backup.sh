#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"

backup_root="${BACKUP_ROOT:-$repo_root/backups}"
retention_days="${RETENTION_DAYS:-14}"
umask 077
mkdir -p "$backup_root"
backup_root="$(cd "$backup_root" && pwd)"
chmod 700 "$backup_root"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$backup_root/$timestamp"
mkdir -m 700 "$backup_dir"
cleanup_partial() {
  rm -rf "$backup_dir"
}
trap cleanup_partial ERR

if ! docker compose ps --services --filter status=running | grep -qx "postgres"; then
  echo "postgres service must be running" >&2
  exit 1
fi

docker compose exec -T postgres pg_dump \
  --format=custom \
  --no-owner \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  > "$backup_dir/database.dump"

docker compose run --rm --no-deps --user root \
  -v "$backup_dir:/backup" \
  worker \
  sh -c 'tar --numeric-owner --create --gzip --file=/backup/documents.tar.gz --directory=/var/lib/fssp/documents .'

{
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'git_commit=%s\n' "$(git rev-parse --verify HEAD 2>/dev/null || printf unknown)"
  printf 'database=%s\n' "$POSTGRES_DB"
  printf 'compose_images=\n'
  docker compose config --images
  printf 'migration_checksums=\n'
  sha256sum migrations/*.sql
} > "$backup_dir/MANIFEST.txt"

chmod 600 "$backup_dir/database.dump" "$backup_dir/documents.tar.gz" "$backup_dir/MANIFEST.txt"
(cd "$backup_dir" && sha256sum database.dump documents.tar.gz > SHA256SUMS)
chmod 600 "$backup_dir/SHA256SUMS"
trap - ERR

if [[ "$retention_days" =~ ^[0-9]+$ ]]; then
  find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime "+$retention_days" -exec rm -rf -- {} +
fi

printf 'Backup created: %s\n' "$backup_dir"
