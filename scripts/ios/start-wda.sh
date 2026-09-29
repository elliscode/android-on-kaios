#!/usr/bin/env bash
# Runs WebDriverAgent on the iPhone (built by build-wda.sh) and makes it reachable from this Mac at
# 127.0.0.1:8100, over USB only. Runs until stopped (Ctrl+C); the iphone-wda launchd agent keeps it
# running (scripts/install-autostart.sh).
#
# USE_IP=127.0.0.1 makes WDA listen only on the phone's own loopback (its control server, and its
# MJPEG server thanks to build-wda.sh's patch), so nothing on the home network can reach it. iproxy
# forwards over USB (usbmux), which arrives on that loopback, and listens only on this Mac's
# 127.0.0.1.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/ios/common.sh

XCTESTRUN=$(ls ios/build/Build/Products/*.xctestrun 2>/dev/null | head -n 1 || true)
[ -n "$XCTESTRUN" ] || { echo "WDA isn't built: run scripts/ios/build-wda.sh first." >&2; exit 1; }
command -v iproxy >/dev/null || { echo "iproxy not found: brew install libimobiledevice" >&2; exit 1; }

iproxy -u "$UDID" -s 127.0.0.1 8100:8100 &
IPROXY=$!
trap 'kill $IPROXY 2>/dev/null' EXIT

echo "$(date): starting WebDriverAgent on $UDID"
# xcodebuild passes TEST_RUNNER_* variables to the runner on the phone without the prefix.
TEST_RUNNER_USE_IP=127.0.0.1 TEST_RUNNER_USE_PORT=8100 \
  xcodebuild test-without-building -xctestrun "$XCTESTRUN" -destination "id=$UDID"
