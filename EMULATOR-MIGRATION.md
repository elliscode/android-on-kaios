# Handoff: move from redroid to the official Android Emulator (virtual camera)

Status: **not started.** A feasibility test passed on 2026-09-26. This document is for whoever
picks it up later (probably Claude): what we learned, what's already installed, and a plan.

## Why

The redroid container (current setup, see README.md) has **no camera at all**: `dumpsys
media.camera` reports 0 devices, there's no camera HAL, and OrbStack's kernel has no
v4l2loopback / CUSE / uinput, so a virtual camera can't be added without writing a camera HAL from
scratch.

The user needs a camera for one thing: **linking the WhatsApp iPad app**, which only links by
scanning a QR code with the primary phone. The iPad app has no "link with phone number" option. The
current workaround is WhatsApp Web on iPad Safari (linked by phone number), added to the Home
Screen.

Goal: the phone's **9 key** uploads a photo (already implemented, see "Existing pieces"), and that
photo becomes what Android's camera sees. The user photographs the iPad's QR code with the flip
phone, opens WhatsApp → Linked devices → Link a device, and the scanner reads it.

## What the feasibility test proved

Run on this Mac (Apple M3 Pro, macOS 26) with the emulator headless, next to redroid:

- The emulator runs natively on Apple Silicon (Hypervisor.framework). No KVM or Docker needed.
  Cold boot took ~27 s.
- The Android 14 Google Play arm64 image honours our screen config: `wm size` = 960x2208,
  `wm density` = 480.
- `-camera-back imagefile:<path>` gives Android **1 camera device** that shows the image file.
  AOSP Camera showed it, and decoding a screenshot of the camera preview returned the QR's text.
- **The image file is re-read when an app opens the camera.** It is NOT re-read while the camera
  is already open. So: write the file, then open the scanner.
- **Not tested:** WhatsApp's own scanner (WhatsApp wasn't installed there; the scanner needs a
  registered account).

### Camera framing (measured with labelled grid images)

- The emulator fits the image into a **landscape 4:3 frame** with "cover" scaling (centred,
  excess cropped).
- AOSP Camera then shows a **portrait 3:4 slice from the LEFT edge** of that frame (x from 0 to
  0.5625·W, full height). Other apps (e.g. WhatsApp's scanner, probably CameraX) may centre-crop
  instead (x from 0.219·W to 0.781·W).
- **Safe placement that worked:** a white 2000x1500 canvas with the uploaded image fitted into a
  box 0.30·W wide (600x600 here), centred at x = 0.39·W and vertically centred. That box lies
  inside both the left slice and a centre crop. If WhatsApp's scanner still misses it, re-measure
  with a grid image in WhatsApp's scanner and adjust.

## Already installed on this Mac

- Android SDK at `~/Library/Android/sdk`: cmdline-tools (latest), `emulator` 37.1.11,
  `platform-tools`, and `system-images;android-34;google_apis_playstore;arm64-v8a`. About 4.4 GB.
  The SDK licences were accepted non-interactively.
- AVD `kaios-test` (`~/.android/avd/kaios-test.avd`), based on pixel_6, with `config.ini` edited:
  `hw.lcd.width=960`, `hw.lcd.height=2208`, `hw.lcd.density=480`, `hw.keyboard=yes`,
  `hw.ramSize=2G`. It's a throwaway test device with no Google login. Create a fresh AVD for real
  use, or reuse it.

### Gotchas already hit

- The emulator needs `ANDROID_SDK_ROOT` (and `ANDROID_HOME`) set to `~/Library/Android/sdk`, or it
  fails with "Cannot find AVD system path".
- It also needs `platform-tools` installed inside the SDK, or it fails with "Broken AVD system
  path".
- Working launch command (headless, on its own port so it doesn't clash with redroid on
  `localhost:5555`; adb serial `emulator-5560`):
  ```sh
  ANDROID_SDK_ROOT=~/Library/Android/sdk ANDROID_HOME=~/Library/Android/sdk \
    ~/Library/Android/sdk/emulator/emulator -avd kaios-test -port 5560 \
    -no-window -no-audio -no-boot-anim -no-snapshot \
    -camera-back "imagefile:/absolute/path/to/cam.png"
  ```
  Stop it with `adb -s emulator-5560 emu kill`.
- Other camera modes the emulator supports: `emulated`, `webcam<N>`, `videofile:`, `image360:`,
  `environment`, and `-virtualscene-poster name=file`. `imagefile:` is the simplest.

## Existing pieces to reuse (current codebase)

- `server/` only talks to Android through adb. `ADB_SERIAL` (default `localhost:5555`) in
  `server/adb.js` selects the device.
- Key 9 → `POST /photo` in `server/index.js`: sharp normalises and rotates the image, it's pushed
  to `/sdcard/DCIM/Camera`, then `scan_file` indexes it.
- These features should work unchanged on the emulator: tap plus accessibility-click fallback
  (`helper/A11yClick.java`, pushed in `/data/local/tmp/helpers.jar`), text box, `/field`, scroll,
  pan, notifications, `/text` via ADBKeyBoard. **Re-verify each one.**
- Redroid-only things to drop or make conditional:
  - `binder-perms` and the `/sys/module` fake (compose only)
  - the Bluetooth / telephony overlays (image only)
  - the letterbox tweak in `configure()`: keep it if the emulator letterboxes too; check this
  - secure-screen capture (`helper/ScreenCap.java`) runs as root via `su`. The Google Play images
    have no root, so capture falls back to `screencap` and `FLAG_SECURE` screens (Chick-fil-A's QR
    code) show as missing there
  - the mock location in `index.js`: replace with `adb emu geo fix <lng> <lat>`, which uses the
    emulator's real GPS path and isn't flagged as a test provider. **Note the argument order is
    longitude then latitude.**

## Implementation plan

1. **Start script** `scripts/start-emulator.sh`:
   - Set the SDK environment variables.
   - Create the AVD if it's missing: `avdmanager create avd -n kaios -k "system-images;android-34;google_apis_playstore;arm64-v8a" -d pixel_6`, then apply the `config.ini` edits above. Consider `hw.ramSize=4G`.
   - Launch headless with `-camera-back imagefile:$REPO/server/camera/current.png`, and keep
     snapshots on (drop `-no-snapshot`) for fast restarts.
   - Wait for `sys.boot_completed`.
2. **Server:**
   - Default `ADB_SERIAL` to `emulator-5560` (keep it overridable).
   - In `/photo`, besides the gallery push, write the "safe placement" composite to
     `server/camera/current.png`. Write to a temp file and `rename()` it into place so the
     emulator never reads a half-written file. Seed it with a neutral placeholder at startup.
   - Status line: "Photo added to gallery and camera".
   - Location: switch `applyLocation()` to `adb emu geo fix`.
3. **Device setup:** run `scripts/setup-device.sh` against the emulator (ADBKeyBoard IME, verifier
   settings). Then the user signs into Google and installs WhatsApp and McDonald's.
4. **WhatsApp:**
   - Re-registering moves the account from redroid. Expect the same "automatic verification"
     stall; the fix was to disable Play Services during verification, then re-enable it
     (`pm disable-user --user 0 com.google.android.gms` / `pm enable`). On the emulator that needs
     root: use `adb root` (the google_apis_playstore images may not allow it, so check), or try
     without disabling first.
   - Then link the iPad app. The iPad QR rotates about every 20 s, so the loop is: key 9 photo
     → upload → open Link a device → scan, done quickly.
5. **Docs:** update README (setup, what changed, the 4.4 GB SDK, starting the emulator after a
   reboot). Retire or keep the redroid compose as a fallback.

## Verification

- `adb -s emulator-5560 shell wm size` shows 960x2208 and `dumpsys media.camera` shows 1 device.
- Key 9 with a QR photo, then open the AOSP camera: decode a screencap with jsQR (see how the test
  did it) to confirm the whole code is visible.
- Every existing feature through the phone page: tap, text box, scroll, pan, location (7), photo
  (9), notifications (4).
- WhatsApp: Linked devices → Link a device → scanner reads a QR photographed from the iPad.

## Risks

- **WhatsApp may reject or ban an emulator.** It already flags redroid as a "custom ROM".
  Registration on the emulator could fail outright. Keep redroid and its data volume (and
  `backups/`) until the emulator is proven.
- **McDonald's** Akamai bot detection (see README / chat history) will likely still block
  registration-type actions. Sign-in and the rewards code worked on redroid.
- **Memory:** the emulator is roughly 2–4 GB of RAM in addition to anything else running. Stop
  redroid (`docker compose stop android`) once migrated.
- **Remaining scanner risk:** the camera needs a photo *of* the QR code taken by the KaiOS
  phone. Glare, blur or low resolution may defeat the scanner; sharp could boost contrast or crop.
