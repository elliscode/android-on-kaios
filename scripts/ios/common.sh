# Shared by the scripts in scripts/ios (sourced from the repo root). Loads ios/config.env, creating
# a template on first run, and finds the phone's UDID if the config doesn't set one.

CONFIG=ios/config.env
if [ ! -f "$CONFIG" ]; then
  mkdir -p ios
  cat > "$CONFIG" <<'EOF'
# iPhone settings for scripts/ios (see IPHONE.md). Not committed.
# TEAM_ID: Xcode → Settings → Accounts → your Apple ID → Team ID (10 characters), or run:
#   security find-identity -v -p codesigning   (the ID in parentheses after "Apple Development:")
TEAM_ID=
# Bundle IDs must be unique to your Apple ID; change this if Xcode says it's unavailable.
BUNDLE_PREFIX=com.elliscode.kaios
# The phone's UDID; leave empty to use the one connected iPhone.
UDID=
EOF
  echo "Created $CONFIG. Fill in TEAM_ID, then run this again." >&2
  exit 1
fi
source "$CONFIG"
[ -n "${TEAM_ID:-}" ] || { echo "Set TEAM_ID in $CONFIG" >&2; exit 1; }
BUNDLE_PREFIX=${BUNDLE_PREFIX:-com.elliscode.kaios}

# The UDID xcodebuild and usbmux use (not the CoreDevice identifier devicectl prints first).
if [ -z "${UDID:-}" ]; then
  JSON=$(mktemp)
  xcrun devicectl list devices --json-output "$JSON" >/dev/null 2>&1 || true
  UDID=$(python3 - "$JSON" <<'EOF'
import json, sys
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    devices = []
phones = [d["hardwareProperties"]["udid"] for d in devices
          if d.get("hardwareProperties", {}).get("deviceType") == "iPhone"
          and d["hardwareProperties"].get("udid")]
print(phones[0] if len(phones) == 1 else "")
EOF
)
  rm -f "$JSON"
  [ -n "$UDID" ] || { echo "No single iPhone found (xcrun devicectl list devices). Set UDID in $CONFIG." >&2; exit 1; }
fi
