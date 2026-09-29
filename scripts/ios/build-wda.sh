#!/usr/bin/env bash
# Builds and signs WebDriverAgent (WDA), the on-phone runner the iPhone server controls the phone
# through (see IPHONE.md). Re-run it to re-sign: with a free Apple ID the signature lasts 7 days
# (the iphone-resign launchd agent does this every 6 days).
#
# - Downloads a pinned appium/WebDriverAgent release into ios/ (gitignored).
# - Patches it so WDA's screen-streaming (MJPEG) server binds to the same address as its control
#   server. start-wda.sh sets that to 127.0.0.1, so neither is reachable over the phone's Wi-Fi.
#   Upstream binds the MJPEG server to every interface regardless.
# - Signs it with your Apple ID's team (Xcode → Settings → Accounts) under a bundle ID of your own
#   (the default com.facebook one is taken).
#
# Settings in ios/config.env (created on first run): TEAM_ID, BUNDLE_PREFIX, and optionally UDID.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/ios/common.sh

WDA_VERSION=16.12.11
WDA_DIR="ios/WebDriverAgent-$WDA_VERSION"

if [ ! -d "$WDA_DIR" ]; then
  echo "Downloading WebDriverAgent $WDA_VERSION..."
  mkdir -p ios
  curl -fsSL "https://github.com/appium/WebDriverAgent/archive/refs/tags/v$WDA_VERSION.tar.gz" | tar xz -C ios
fi

# Bind the MJPEG server like the HTTP server (USE_IP). Fails the build if the code moved.
python3 - "$WDA_DIR/WebDriverAgentLib/Routing/FBWebServer.m" <<'EOF'
import sys
path = sys.argv[1]
src = open(path).read()
patch = "  self.screenshotsBroadcaster.interface = FBConfiguration.sharedInstance.bindingIPAddress;\n"
anchor = "  self.screenshotsBroadcaster.delegate = self.mjpegServer;\n"
if patch not in src:
    if src.count(anchor) != 1:
        sys.exit("WDA patch failed: MJPEG server setup changed in " + path)
    open(path, "w").write(src.replace(anchor, anchor + patch))
EOF

# Your own bundle IDs (Appium does the same replacement for its updatedWDABundleId option).
sed -i '' "s/com\.facebook\./$BUNDLE_PREFIX./g" "$WDA_DIR/WebDriverAgent.xcodeproj/project.pbxproj"

echo "Building and signing for $UDID (team $TEAM_ID); full log in ios/build.log..."
if ! xcodebuild build-for-testing \
  -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  -derivedDataPath ios/build \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic > ios/build.log 2>&1; then
  grep -E "error:" ios/build.log | sort -u | head -20 >&2
  echo "Build failed. See ios/build.log." >&2
  exit 1
fi
echo "Built and signed. Start it with scripts/ios/start-wda.sh."
