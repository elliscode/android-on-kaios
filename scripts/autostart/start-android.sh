#!/usr/bin/env bash
# Run at login by launchd (see scripts/install-autostart.sh): waits for OrbStack's Docker to be up,
# then starts Android. `docker compose up -d` also re-runs the binder-perms fix, which the VM loses
# on every reboot.
set -uo pipefail
cd "$(dirname "$0")/../.."

for i in $(seq 1 120); do            # up to ~10 minutes for OrbStack to start
  docker info >/dev/null 2>&1 && break
  sleep 5
done
echo "$(date): starting Android"
docker compose up -d
