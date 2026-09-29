#!/usr/bin/env bash
# Builds server/helpers.jar for Android from helper/*.java: the accessibility-click helper
# (A11yClick) and the screen capture helper (ScreenCap).
# Needs a JDK; without one it runs itself inside a JDK container (Docker/OrbStack).
# Downloads Google's d8 (from r8 on Google Maven) once into docker/.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! javac -version >/dev/null 2>&1; then
  echo "No JDK here, building in the eclipse-temurin:17-jdk container..."
  exec docker run --rm -v "$PWD":/w -w /w eclipse-temurin:17-jdk bash scripts/build-helper.sh
fi

R8_VERSION=9.4.26
R8_JAR="docker/r8-$R8_VERSION.jar"
[ -f "$R8_JAR" ] || curl -fL -o "$R8_JAR" \
  "https://dl.google.com/android/maven2/com/android/tools/r8/$R8_VERSION/r8-$R8_VERSION.jar"

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
javac --release 11 -d "$BUILD/classes" helper/*.java
java -cp "$R8_JAR" com.android.tools.r8.D8 --release --min-api 30 --output "$BUILD" "$BUILD/classes/"*.class
(cd "$BUILD" && jar cf helpers.jar classes.dex)
cp "$BUILD/helpers.jar" server/helpers.jar
echo "Built server/helpers.jar"
