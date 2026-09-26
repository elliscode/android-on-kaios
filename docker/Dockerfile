# Android 14 (arm64, 64-bit only) + MindTheGapps (Google Play Services / Play Store).
# - 64only: Apple Silicon has no AArch32, and OrbStack's kernel has no 32-bit compat.
# - 14 not 13: Android 13's init aborts when /proc/sys/vm/mmap_rnd_compat_bits is missing.
FROM redroid/redroid:14.0.0_64only-latest
COPY mindthegapps/system /system
COPY overlay/ /
ENTRYPOINT ["/init", "androidboot.hardware=redroid", "ro.setupwizard.mode=DISABLED"]
