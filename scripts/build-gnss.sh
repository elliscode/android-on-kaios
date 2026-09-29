#!/usr/bin/env bash
# Builds the GNSS HAL (helper/gnss/service.cpp) into
# docker/overlay/vendor/bin/hw/android.hardware.gnss-service.kaios, which build-image.sh bakes in.
#
# Downloads once into docker/gnss-build/: the NDK, build-tools (for the aidl compiler), and the
# Android 14 GNSS AIDL definitions from AOSP. The binder platform APIs the NDK leaves out are
# declared in helper/gnss/include and linked from libbinder_ndk.so copied out of the redroid base
# image. The toolchain is x86-64 Linux only: it runs in an amd64 container.
set -euo pipefail
cd "$(dirname "$0")/.."

B=docker/gnss-build
OUT=docker/overlay/vendor/bin/hw/android.hardware.gnss-service.kaios
NDK=android-ndk-r26d
AOSP=https://android.googlesource.com/platform
BASE_IMAGE=redroid/redroid:14.0.0_64only-latest # as in docker/Dockerfile

if [ "${IN_CONTAINER:-}" != 1 ]; then
  mkdir -p "$B"
  fetch() { # url dest: download once, retrying (googlesource sometimes answers 503)
    [ -e "$2" ] && return
    for i in 1 2 3 4 5; do curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2" && return; sleep 5; done
    echo "Download failed: $1" >&2; exit 1
  }
  fetch "https://dl.google.com/android/repository/$NDK-linux.zip" "$B/ndk.zip"
  fetch "https://dl.google.com/android/repository/build-tools_r34-linux.zip" "$B/build-tools.zip"
  fetch "$AOSP/hardware/interfaces/+archive/refs/heads/android14-release/gnss.tar.gz" "$B/gnss.tgz"
  [ -d "$B/$NDK" ] || unzip -q "$B/ndk.zip" -d "$B"
  [ -d "$B/android-14" ] || unzip -q "$B/build-tools.zip" -d "$B"
  [ -d "$B/gnss" ] || { mkdir "$B/gnss" && tar xzf "$B/gnss.tgz" -C "$B/gnss"; }
  mkdir -p "$B/device-lib"
  C=$(docker create "$BASE_IMAGE")
  docker cp "$C:/system/lib64/libbinder_ndk.so" "$B/device-lib/" >/dev/null
  docker rm "$C" >/dev/null
  exec docker run --rm --platform linux/amd64 -e IN_CONTAINER=1 -v "$PWD":/w -w /w \
    debian:bookworm-slim bash scripts/build-gnss.sh
fi

# In the container.
API="$B/gnss/aidl/aidl_api/android.hardware.gnss/3" # the frozen v3 interface (Android 14)
GEN=$(mktemp -d)
trap 'rm -rf "$GEN"' EXIT
"$B/android-14/aidl" --lang=ndk --structured --stability=vintf \
  --version=3 --hash="$(tail -n 1 "$API/.hash")" \
  -I "$API" -o "$GEN/src" -h "$GEN/include" \
  $(find "$API/android" -name '*.aidl')

mkdir -p "$(dirname "$OUT")"
"$B/$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android34-clang++" \
  -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -I "$GEN/include" -I helper/gnss/include \
  helper/gnss/service.cpp $(find "$GEN/src" -name '*.cpp') \
  -L "$B/device-lib" -lbinder_ndk -llog -static-libstdc++ \
  -o "$OUT"
"$B/$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" "$OUT"
echo "Built $OUT"
