#!/usr/bin/env bash
# Replace Android's /data with a backup made by backup-data.sh.  Usage: restore-data.sh <file.tar.gz>
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?usage: restore-data.sh backups/android-data-XXXX.tar.gz}"
[ -f "$FILE" ] || { echo "No such file: $FILE" >&2; exit 1; }
read -r -p "This overwrites the current Android data. Continue? [y/N] " ok
[ "$ok" = "y" ] || exit 1
docker compose stop android
docker run --rm -v android-on-kaios_android-data:/data -v "$PWD/$(dirname "$FILE"):/backups:ro" alpine \
  sh -c "find /data -mindepth 1 -delete && tar xzf /backups/$(basename "$FILE") -C /data"
docker compose up -d
echo "Restored $FILE"
