#!/usr/bin/env bash
# One-time device setup: connect adb, install ADBKeyBoard as the IME, install any APKs in ./apks.
set -euo pipefail
cd "$(dirname "$0")/.."
SERIAL="${ADB_SERIAL:-localhost:5555}"
A="adb -s $SERIAL"

adb connect "$SERIAL" >/dev/null
echo "Waiting for Android to finish booting..."
until [ "$($A shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done

# Play Protect's verifier otherwise stalls every `adb install` indefinitely.
$A shell settings put global verifier_verify_adb_installs 0
$A shell settings put global package_verifier_enable 0

# ADBKeyBoard: an IME that accepts text over adb broadcasts (supports Unicode/emoji).
IME_APK="docker/ADBKeyboard.apk"
if ! $A shell pm list packages | grep -q com.android.adbkeyboard; then
  [ -f "$IME_APK" ] || curl -fL -o "$IME_APK" https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk
  $A install -r "$IME_APK"
fi
$A shell ime enable com.android.adbkeyboard/.AdbIME >/dev/null
$A shell ime set com.android.adbkeyboard/.AdbIME >/dev/null
echo "IME: $($A shell settings get secure default_input_method | tr -d '\r')"

# Sideload APKs: single .apk files, or a folder per app containing split APKs.
shopt -s nullglob
for f in apks/*.apk; do echo "Installing $f"; $A install -r "$f"; done
for d in apks/*/; do
  splits=("$d"*.apk)
  [ ${#splits[@]} -gt 0 ] && { echo "Installing splits in $d"; $A install-multiple -r "${splits[@]}"; }
done

# Play Store: redroid is an uncertified device. Register this ID, then sign in.
# (adb shell isn't root; the container's own shell is.)
GSF_ID=$(docker exec android sqlite3 /data/data/com.google.android.gsf/databases/gservices.db \
  "select value from main where name='android_id';" 2>/dev/null | tr -d '\r' || true)
if [ -n "$GSF_ID" ]; then
  echo
  echo "Google Services Framework Android ID: $GSF_ID"
  echo "Register it at https://www.google.com/android/uncertified before signing in to the Play Store."
else
  echo "GSF ID not available yet (open the Play Store once, then re-run this script to print it)."
fi
