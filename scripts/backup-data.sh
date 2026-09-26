#!/usr/bin/env bash
# Snapshot Android's /data (Google login, apps, app data) to backups/android-data-<date>.tar.gz.
# Stops Android during the copy so databases are consistent.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
OUT="backups/android-data-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose stop android
docker run --rm -v android-on-kaios_android-data:/data:ro -v "$PWD/backups:/backups" alpine \
  tar czf "/backups/$(basename "$OUT")" -C /data .
docker compose up -d
echo "Saved $OUT"
