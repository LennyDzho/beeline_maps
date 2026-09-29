#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="${MARSH_PROJECT_DIR:-/opt/marsh}"
backup_dir="${MARSH_BACKUP_DIR:-/var/backups/marsh}"
retention_days="${MARSH_BACKUP_RETENTION_DAYS:-14}"
volume_name="${MARSH_STATE_VOLUME:-marsh_web-state}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_name="web-state-${timestamp}.tar.gz"
partial_path="${backup_dir}/.${archive_name}.partial"
archive_path="${backup_dir}/${archive_name}"

exec 9>/run/lock/marsh-backup.lock
if ! flock -n 9; then
  echo "Another Marsh backup is already running" >&2
  exit 1
fi

cd "${project_dir}"
test -s .env
docker volume inspect "${volume_name}" >/dev/null

install -d -m 0700 "${backup_dir}"
install -m 0600 .env "${backup_dir}/env-latest"

web_was_running=false
if docker compose ps --status running --services | grep -qx web; then
  web_was_running=true
  docker compose stop --timeout 30 web
fi

restore_web() {
  if [[ "${web_was_running}" == "true" ]]; then
    docker compose up -d --wait --wait-timeout 180 web
  fi
}
trap restore_web EXIT

docker run --rm \
  --volume "${volume_name}:/source:ro" \
  --volume "${backup_dir}:/backup" \
  alpine:3.22.1 \
  tar -C /source -czf "/backup/.${archive_name}.partial" .

gzip -t "${partial_path}"
mv "${partial_path}" "${archive_path}"
chmod 0600 "${archive_path}"

restore_web
web_was_running=false
trap - EXIT

find "${backup_dir}" -maxdepth 1 -type f -name 'web-state-*.tar.gz' -mtime "+${retention_days}" -delete
echo "Created ${archive_path}"
