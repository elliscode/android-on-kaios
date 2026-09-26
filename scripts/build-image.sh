#!/usr/bin/env bash
# Builds redroid-gapps:14 — redroid Android 14 arm64 with MindTheGapps baked in.
set -euo pipefail
cd "$(dirname "$0")/../docker"

URL="https://github.com/s1204IT/MindTheGappsBuilder/releases/download/20240226/MindTheGapps-14.0.0-arm64-20240226.zip"
MD5="a0905cc7bf3f4f4f2e3f59a4e1fc789b"
ZIP="mindthegapps.zip"

if [ ! -f "$ZIP" ] || [ "$(md5 -q "$ZIP" 2>/dev/null || md5sum "$ZIP" | cut -d' ' -f1)" != "$MD5" ]; then
  echo "Downloading MindTheGapps..."
  curl -fL -o "$ZIP" "$URL"
fi
[ "$(md5 -q "$ZIP" 2>/dev/null || md5sum "$ZIP" | cut -d' ' -f1)" = "$MD5" ] || { echo "MD5 mismatch" >&2; exit 1; }

rm -rf mindthegapps
mkdir mindthegapps
unzip -q "$ZIP" 'system/*' -d mindthegapps

docker build -t redroid-gapps:14 .
echo "Built redroid-gapps:14"
