#!/usr/bin/env bash
# Makes Android, the server and Caddy start automatically at login (macOS launchd agents), the
# macOS equivalent of a Windows startup script. Run it once on the Mac that hosts everything:
#
#   ./scripts/install-autostart.sh              install (or reinstall) and start them now
#   ./scripts/install-autostart.sh --uninstall  stop them and remove them
#
# - android: runs scripts/autostart/start-android.sh once per login (waits for OrbStack).
# - server:  node server/index.js, restarted automatically if it exits.
# - caddy:   caddy run --config Caddyfile, restarted automatically if it exits.
# With an iPhone set up (ios/config.env exists, see IPHONE.md), also:
# - iphone-wda:    scripts/ios/start-wda.sh (WebDriverAgent over USB), restarted if it exits.
# - iphone-server: the iPhone server (DEVICE=ios on :8081), restarted if it exits.
# - iphone-resign: scripts/ios/build-wda.sh every 6 days (a free Apple ID's signature lasts 7),
#                  then restarts iphone-wda.
# Logs go to logs/*.log in this folder. Login codes are in logs/server.log.
#
# Agents only run while you're logged in, so turn on automatic login (System Settings → Users &
# Groups) and make OrbStack start at login (OrbStack settings).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PREFIX="com.elliscode.android-on-kaios"
NAMES="android server caddy"
IPHONE_NAMES="iphone-wda iphone-server iphone-resign"
[ -f ios/config.env ] && NAMES="$NAMES $IPHONE_NAMES"
DOMAIN="gui/$(id -u)"

unload() {
  for name in $NAMES; do
    launchctl bootout "$DOMAIN/$PREFIX.$name" 2>/dev/null || true
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  unload
  NAMES="android server caddy $IPHONE_NAMES"
  unload
  for name in $NAMES; do rm -f "$AGENTS_DIR/$PREFIX.$name.plist"; done
  echo "Autostart removed."
  exit 0
fi

# launchd starts programs with a minimal PATH, so record where the tools live on this Mac.
need() { command -v "$1" || { echo "Not found: $1 ($2)" >&2; exit 1; }; }
NODE=$(need node "brew install node")
CADDY=$(need caddy "brew install caddy")
ADB=$(need adb "brew install --cask android-platform-tools")
DOCKER=$(need docker "install OrbStack")
TOOL_PATH="$(dirname "$NODE"):$(dirname "$CADDY"):$(dirname "$ADB"):$(dirname "$DOCKER"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$AGENTS_DIR" "$REPO/logs"

# write_agent <name> <working dir> <keep alive: true|false> <program> [args...]
# EXTRA: optional plist keys for the next agent (e.g. a StartInterval).
EXTRA=""
write_agent() {
  local name=$1 dir=$2 keepalive=$3
  shift 3
  local args=""
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  cat > "$AGENTS_DIR/$PREFIX.$name.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PREFIX.$name</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key>
  <string>$dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$TOOL_PATH</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <$keepalive/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
$EXTRA  <key>StandardOutPath</key>
  <string>$REPO/logs/$name.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO/logs/$name.log</string>
</dict>
</plist>
EOF
  plutil -lint -s "$AGENTS_DIR/$PREFIX.$name.plist"
  EXTRA=""
}

write_agent android "$REPO" false /bin/bash "$REPO/scripts/autostart/start-android.sh"
write_agent server "$REPO/server" true "$NODE" index.js
write_agent caddy "$REPO" true "$CADDY" run --config Caddyfile

if [ -f ios/config.env ]; then
  need iproxy "brew install libimobiledevice" >/dev/null
  write_agent iphone-wda "$REPO" true /bin/bash "$REPO/scripts/ios/start-wda.sh"
  write_agent iphone-server "$REPO/server" true /usr/bin/env DEVICE=ios PORT=8081 \
    SESSIONS_FILE=sessions-iphone.json LOCATION_FILE=location-iphone.json "$NODE" index.js
  EXTRA="  <key>StartInterval</key>
  <integer>518400</integer>
"
  write_agent iphone-resign "$REPO" false /bin/bash "$REPO/scripts/ios/resign-wda.sh"
fi

if [ -n "${NO_LOAD:-}" ]; then
  echo "Wrote agents to $AGENTS_DIR (not loaded)."
  exit 0
fi

unload
for name in $NAMES; do
  launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$PREFIX.$name.plist"
done
echo "Autostart installed and started. Logs: $REPO/logs/ (login codes: tail -f logs/server.log)"
echo "Stop any copies you started by hand (npm start / caddy run) first, or they'll clash on ports."
