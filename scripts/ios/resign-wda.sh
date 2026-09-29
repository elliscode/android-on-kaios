#!/usr/bin/env bash
# Run every 6 days by the iphone-resign launchd agent: re-signs WebDriverAgent (a free Apple ID's
# signature lasts 7 days), then restarts the iphone-wda agent so the phone runs the new build.
set -euo pipefail
cd "$(dirname "$0")/../.."
echo "$(date): re-signing WebDriverAgent"
scripts/ios/build-wda.sh
launchctl kickstart -k "gui/$(id -u)/com.elliscode.android-on-kaios.iphone-wda"
