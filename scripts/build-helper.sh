#!/usr/bin/env bash
# Builds server/a11y.jar (the accessibility-click helper, helper/A11yClick.java) for Android.
# Needs a JDK. Downloads Google's d8 (from r8 on Google Maven) once into docker/.
set -euo pipefail
cd "$(dirname "$0")/.."

R8_VERSION=9.4.26
R8_JAR="docker/r8-$R8_VERSION.jar"
[ -f "$R8_JAR" ] || curl -fL -o "$R8_JAR" \
  "https://dl.google.com/android/maven2/com/android/tools/r8/$R8_VERSION/r8-$R8_VERSION.jar"

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
javac --release 11 -d "$BUILD/classes" helper/A11yClick.java
java -cp "$R8_JAR" com.android.tools.r8.D8 --release --min-api 30 --output "$BUILD" "$BUILD/classes/"*.class
(cd "$BUILD" && jar cf a11y.jar classes.dex)
cp "$BUILD/a11y.jar" server/a11y.jar
echo "Built server/a11y.jar"
