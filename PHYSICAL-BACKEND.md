# Android on KaiOS — Physical Android Device Backend

## Project

Extend the existing `elliscode/android-on-kaios` project to support **two Android backends**:

* `https://android.elliscode.com/redroid` — existing Android emulator/redroid implementation
* `https://android.elliscode.com/realphone` — new physical Android phone connected to the basement Mac Mini via USB/ADB

The existing redroid implementation is working and should **not be broken or unnecessarily rewritten**.

The goal is to abstract the Android-control layer so the same KaiOS web client can operate either backend.

**Status (2026-09-26): not started, optional.** The Pixel 7a (bought for app testing) may be used
for this later. WhatsApp and McDonald's already work on redroid (except McDonald's linked
payment), so this backend is a nice-to-have, not a need.

---

# 0. Feasibility review (read this first)

Reviewed against the code as it stood on 2026-09-26. **Verdict: feasible.** The server already
drives Android purely through `adb -s <serial>`, so a USB phone is mostly "the same thing with a
different serial". The MVP (screen, tap, swipe, type, back/home) is modest. Where this spec and
reality differ, this section wins.

## 0.1 Corrections to the spec below

- **The KaiOS usable area is 240x276, not 240x294.** It's fixed and top-left (see README).
- **Coordinates:** the client already sends Android pixel coordinates computed from the frame it
  received (`scale = frame width / 240`, plus the pan offset), so it adapts to any resolution.
  Normalised 0–1 coordinates (section 11) aren't needed.
- **Screenshots:** the server uses raw `screencap` and hashes the raw pixels (faster than
  `screencap -p`), then encodes to JPEG with sharp only when the hash changes. Keep that pipeline
  rather than the PNG commands in section 9.

## 0.2 What works on a stock, locked, unrooted phone

Every mechanism the server uses today is available to the adb shell user on a normal phone:

- `screencap`, `input tap` / `swipe` / `keyevent`.
- `dumpsys input_method` (keyboard detection via `mInputShown`).
- ADBKeyBoard: install it with `adb install`, then `ime enable` and `ime set`. Also run
  `settings put global verifier_verify_adb_installs 0` so installs don't stall.
- The accessibility-click fallback (`helper/A11yClick.java` via `app_process` + `uiautomator.jar`,
  which is standard on all Android).
- `uiautomator dump` for `/field`.
- `cmd statusbar` for notifications.
- `adb push` + `content call … scan_file` for photos.

## 0.3 Things that will behave differently or not work

1. **Screen size / density.** The Pixel 7a is 1080x2400, and 1080/240 = 4.5, which isn't an
   integer.
   - **Simplest:** `adb shell wm size 960x2208` and `adb shell wm density 480`. That's no root,
     undone with `wm size reset` / `wm density reset`, and gives the identical layout and
     top/middle/bottom panning as redroid, with no client changes.
   - The physical screen shows thin side bars (irrelevant in a basement).
   - **Verify:** `screencap` returns 960x2208 after the override.
2. **Secure screens (`FLAG_SECURE`) screenshot as black** on a real stock phone. Banking apps and
   many payment screens set it, possibly McDonald's pay screen. Those screens can't be viewed
   remotely, and there's no legitimate workaround without root. Accept it.
3. **Developer Options / USB debugging detection.** Some banking and payment apps refuse to run
   while USB debugging or Developer Options is enabled, and some object to any active
   accessibility service. This design requires USB debugging permanently, so expect some banks not
   to work. Play Integrity itself is not affected by USB debugging.
4. **Input is still injected.** `input tap` events are software-injected on a real phone too
   (they fail `InputManager.verifyInputEvent`).
   - Apps that ignore injected touches (e.g. WhatsApp's registration screen) behave the same; the
     accessibility-click fallback still applies.
   - A real phone fixes **device/integrity** checks, not **input** checks. McDonald's Akamai bot
     detection sees real sensors now but still synthetic touches, so registration and payment
     *may* improve. Not guaranteed.
5. **Screen off / lock screen** is the biggest practical issue:
   - With the screen off, screenshots are black and taps do nothing.
   - "Stay awake while charging" keeps the screen on, but the 7a is **OLED**, so it will burn in.
   - Plan instead:
     - Short screen timeout (1–2 min).
     - The server sends `input keyevent KEYCODE_WAKEUP` when a client starts polling (in
       `wake()` in `server/index.js`), and maybe again before each tap.
   - Keeping a PIN (per section 18) means every wake shows the lock screen, so enter the PIN
     through the viewer. That's workable, just a UX cost.
   - After every reboot, apps can't run until the PIN is entered once ("before first unlock").
     ADB still works in that state.
6. **Location.** A basement phone has **real** location (Wi-Fi/cell = home), so mocking is only
   needed to appear elsewhere.
   - The existing mock mechanism should work as the shell user: `appops set com.android.shell
     android:mock_location allow` + `cmd location providers add-test-provider`.
   - Apps can see mocked locations. Verify on the device.
   - Consider making key 7 per-backend (on realphone: mock on demand, with a way to clear it).
7. **WhatsApp has one primary phone.**
   - Moving WhatsApp to the Pixel logs redroid's copy out and needs re-registration.
   - The Pixel has no SIM, so the "automatically verifying your number" stall may repeat.
   - On redroid the fix was temporarily disabling Play Services (`pm disable-user --user 0
     com.google.android.gms`, run as root in the container). On a stock phone the shell user may
     not be allowed to disable it. Untested.
8. **Redroid-only setup must not run on the phone:**
   - The letterbox tweak (`configure()` in `server/adb.js`) is harmless if it fails, but skip it.
   - The mock-location setup in `connect()` / `applyLocation()` in `server/index.js`.
   - Everything in `docker-compose.yml` / `docker/overlay`.

## 0.4 Code changes it would take (moderate)

- **`server/adb.js`:** `SERIAL` is a module-level constant. Make the functions take a serial, or
  export a factory `createAdb(serial)`.
- **`server/index.js`:** all device state is global (`frame`, `keyboard`, `lastPollAt`,
  `inFlight`, `timer`, `location`, the location interval, the capture loop, the tap fallback).
  - Move it into a per-device session object.
  - Mount the existing route handlers on an Express `Router` per backend: `/redroid/*` and
    `/realphone/*`.
  - The UiAutomation queue in `adb.js` must be per device too.
- **`GET /`:** currently the login page or the app. Keep login there. After login, redirect `/` →
  `/redroid` so existing bookmarks work. Serve the same inlined app page at `/redroid` and
  `/realphone`, with a `<meta name="backend">` (or base path) injected like the CSRF meta.
- **`public/app.js`:** all XHR paths are absolute (`/frame`, `/tap`, …). Prefix them with the
  backend base path read from the meta tag. No other client change is needed.
- **Auth (`server/auth.js`):** unchanged. The cookie has `Path=/` and covers both backends, and
  `requireSessionAndCsrf` applies to both routers.
- **Config:** `REDROID_SERIAL` (default `localhost:5555`) and `REALPHONE_SERIAL` (from
  `adb devices`). If the phone isn't connected, `/realphone` shows a clear "device not connected"
  frame or error instead of crashing.
- **Per-backend options:** `wakeOnPoll` (realphone), `mockLocationSetup` (redroid), `letterboxFix`
  (redroid).

## 0.5 Testing without the phone

The official Android Emulator is already installed on the dev MacBook (see
EMULATOR-MIGRATION.md): AVD `kaios-test`, serial `emulator-5560`. It's a ready stand-in "second
device" with its own serial and settings, so the whole `/realphone` path can be built and tested
before touching the Pixel.

## 0.6 Pixel 7a checklist when setting it up

1. Check the IMEI isn't blacklisted, financed or carrier-locked (eBay).
2. Factory reset and update to the latest Android.
3. Confirm Play Store → Settings → About → **Play Protect certification: Device is certified**.
   eBay phones sometimes arrive with an unlocked bootloader; "certified" implies stock and locked.
4. Developer Options:
   - Turn on **USB debugging**.
   - Turn on **Disable adb authorization timeout**, otherwise authorizations expire after 7 days
     without use.
5. Battery: enable a **charge limit (80%)** / Adaptive Charging if the Android version offers it.
   Charging 24/7 at 100% risks battery swelling.
6. Screen timeout: 1–2 min (OLED burn-in). Keep a PIN.
7. Leave Wi-Fi on. Doze doesn't apply while charging, so Wi-Fi and ADB stay available.
8. Plug in by USB, accept the Mac mini's ADB prompt ("Always allow"), then `adb devices`.

---

# 1. Existing Architecture

Current system:

```text
KaiOS phone
    |
    | HTTPS
    v
android.elliscode.com
    |
    v
Caddy / Node server
    |
    v
ADB
    |
    v
redroid Android container
```

The KaiOS client is intentionally designed for a tiny 240x294-ish display and limited KaiOS browser capabilities.

The existing implementation already supports things such as:

* Android screenshots
* JPEG frame delivery
* frame-change detection
* tap input
* swipes / gestures
* text input
* ADB keyboard
* location forwarding
* launching/interacting with Android apps
* photo/file injection
* persistent Android state
* authentication/session handling

The physical-device backend should reuse as much of this infrastructure as possible.

---

# 2. New Architecture

Add a generic Android device abstraction:

```text
                         android.elliscode.com
                                  |
                    +-------------+-------------+
                    |                           |
                  /redroid                   /realphone
                    |                           |
              RedroidDevice              PhysicalDevice
                    |                           |
                 Docker                     USB ADB
                    |                           |
                 redroid                 Physical Android
```

The web client should not need to know which backend it is using.

The backend should expose the same conceptual operations:

```text
getScreenshot()
tap(x, y)
swipe(...)
typeText(...)
pressBack()
pressHome()
launchApp(...)
setLocation(...)
pushFile(...)
pullFile(...)
```

---

# 3. Primary Goal

Make a physical Android phone behave like an **Android appliance**.

The phone will live permanently in the basement next to the Mac Mini.

Example:

```text
Basement:

Mac Mini
   |
   | USB-C
   |
   v
Physical Android Phone
   |
   +-- WhatsApp
   +-- McDonald's
   +-- Wawa
   +-- Dunkin
   +-- Chipotle
   +-- banking apps
   +-- other Android apps
```

The physical phone should ideally remain:

* stock Android
* bootloader locked
* unrooted
* Play Store certified
* connected to Wi-Fi
* connected to the Mac Mini by USB
* charging continuously
* accessible through ADB
* controllable through the existing web application

Do NOT modify the OS unnecessarily.

The purpose of the physical backend is specifically to provide apps with a genuine physical Android environment.

---

# 4. Why Two Backends?

The existing redroid implementation is extremely useful for development and experimentation.

For example:

```text
/redroid
```

can remain the easy-to-reset environment.

But some Android apps detect:

* emulator environments
* modified system images
* non-certified devices
* unusual hardware characteristics
* Play Integrity state
* other virtualization/environment properties

The physical phone provides a second environment for applications that behave differently on real hardware.

Example:

```text
McDonald's

redroid:
    rewards       -> works
    payment       -> does not work

realphone:
    rewards       -> test
    payment       -> test
```

Do not attempt to circumvent app security or integrity mechanisms.

The purpose of the physical backend is simply to run the application normally on an actual stock Android device.

---

# 5. Device Connection

The physical phone should connect to the Mac Mini using USB.

Expected:

```bash
adb devices
```

Example:

```text
List of devices attached
ABC123456789    device
```

The application should detect the physical device by serial number.

Do not expose ADB to the Internet.

ADB should remain local to the Mac Mini.

---

# 6. Device Configuration

The phone should initially be configured manually:

1. Factory reset phone if necessary.
2. Complete Android setup.
3. Connect to Wi-Fi.
4. Sign into Google account if required.
5. Install required applications.
6. Enable Developer Options.
7. Enable USB debugging.
8. Connect USB cable to Mac Mini.
9. Accept the computer's ADB authorization prompt.
10. Verify:

```bash
adb devices
```

The phone should remain **bootloader locked**.

Do not require root.

Do not install Magisk.

Do not install a custom ROM.

Do not modify system partitions.

The entire point of this backend is to preserve as much of the normal physical Android environment as possible.

---

# 7. AndroidDevice Interface

Create an interface/abstract class along the lines of:

```javascript
class AndroidDevice {
    async getScreenshot() {}
    async tap(x, y) {}
    async swipe(x1, y1, x2, y2, duration) {}
    async typeText(text) {}
    async pressBack() {}
    async pressHome() {}
    async launchApp(packageName) {}
    async setLocation(latitude, longitude) {}
    async pushFile(localPath, remotePath) {}
    async pullFile(remotePath, localPath) {}
}
```

Do not necessarily use these exact method names if the existing project has better conventions.

The important architectural requirement is:

**the web application should interact with an AndroidDevice rather than directly knowing whether the device is redroid or physical.**

---

# 8. Redroid Backend

Refactor the current implementation minimally.

Create something conceptually like:

```text
RedroidDevice extends AndroidDevice
```

It should continue using the existing ADB/container setup.

Do not rewrite the working redroid functionality unless necessary.

Existing behavior is the reference implementation.

---

# 9. Physical Backend

Create:

```text
PhysicalDevice extends AndroidDevice
```

The physical backend should use the normal ADB connection:

```bash
adb -s DEVICE_SERIAL ...
```

Examples:

### Screenshot

```bash
adb -s DEVICE_SERIAL exec-out screencap -p
```

### Tap

```bash
adb -s DEVICE_SERIAL shell input tap X Y
```

### Swipe

```bash
adb -s DEVICE_SERIAL shell input swipe X1 Y1 X2 Y2 DURATION
```

### Back

```bash
adb -s DEVICE_SERIAL shell input keyevent KEYCODE_BACK
```

### Home

```bash
adb -s DEVICE_SERIAL shell input keyevent KEYCODE_HOME
```

### Launch application

Use the existing mechanism if already implemented.

Do not hardcode package names into the generic device abstraction.

---

# 10. Screenshot Pipeline

Reuse the existing screenshot/frame system.

The KaiOS client should not care whether the screenshot originated from:

```text
redroid
```

or:

```text
physical Android
```

Continue using the existing optimization where possible:

```text
Android screenshot
      |
      v
hash / compare
      |
      +---- unchanged --> don't send new image
      |
      +---- changed ----> JPEG --> KaiOS
```

The goal is low bandwidth and acceptable performance on KaiOS.

Do not introduce WebRTC merely because the physical phone is real.

The existing low-bandwidth screenshot approach is intentional.

---

# 11. Coordinate Handling

The physical phone will likely have a completely different screen resolution from redroid.

Do not assume:

```text
240x294
```

is the Android display resolution.

The KaiOS client operates in its own coordinate space.

The backend should know the actual Android display dimensions:

```bash
adb shell wm size
```

or equivalent.

Translate KaiOS coordinates into Android coordinates.

Conceptually:

```text
KaiOS client
240 x 294
     |
     | normalized coordinate
     v
Android device
1080 x 2400
```

Prefer normalized coordinates where practical:

```text
x = 0.0 ... 1.0
y = 0.0 ... 1.0
```

This allows the same client to work across:

* redroid
* Pixel
* Motorola
* other future devices

---

# 12. Physical Device Discovery

At server startup:

```bash
adb devices
```

Find the configured physical device.

Configuration should support something like:

```text
ANDROID_BACKEND=realphone
ANDROID_DEVICE_SERIAL=ABC123456789
```

and:

```text
ANDROID_BACKEND=redroid
```

for the existing implementation.

Eventually support:

```text
ANDROID_BACKEND=auto
```

if useful.

---

# 13. Routes

Maintain the existing application structure.

Add explicit routes:

```text
/redroid
/realphone
```

Both routes should instantiate the appropriate AndroidDevice implementation.

Example:

```text
GET /redroid
    -> client configured for redroid

GET /realphone
    -> client configured for physical Android
```

The actual frontend code should preferably be shared.

Do not duplicate the entire client.

Instead:

```text
AndroidRemoteClient
        |
        +---- backend = redroid
        |
        +---- backend = realphone
```

---

# 14. Authentication

Reuse the existing authentication/session mechanism.

Do not create a second authentication system for the physical phone.

Both:

```text
/redroid
/realphone
```

should use the same user authentication.

The physical device is potentially more sensitive because it may eventually contain:

* WhatsApp
* banking apps
* payment applications
* personal accounts

Therefore, do not weaken authentication merely because the system is currently private.

---

# 15. Location

Reuse the existing location-forwarding mechanism.

The physical device should receive location information using normal Android mechanisms where possible.

Do not root the device merely to inject location.

First investigate standard ADB/developer mechanisms and/or the existing companion-agent approach.

The goal is for applications to receive a plausible location while keeping the device otherwise stock.

---

# 16. Accessibility Agent

Investigate building a small Android application:

```text
com.elliscode.androidagent
```

This would be installed on the physical Android phone.

Potential responsibilities:

* accessibility service
* UI hierarchy inspection
* semantic clicking
* text entry
* gestures
* device status
* communication with the Mac Mini
* optional screenshot assistance
* optional location integration

Do not make this mandatory for the first physical-device prototype.

First get:

```text
USB ADB
+
screenshots
+
tap
+
swipe
+
keyboard
```

working.

Then investigate AccessibilityService.

Potential future capability:

```text
"click the Pay button"
```

instead of:

```text
"tap x=812, y=1937"
```

This could make automation much more robust across screen sizes.

---

# 17. Important Security Constraint

Never expose:

```text
ADB
port 5555
Android debugging
```

to the public Internet.

The public Internet should only see the existing authenticated web application.

Architecture:

```text
Internet
   |
   v
Caddy
   |
   v
Node server
   |
   v
local ADB
   |
   v
Android phone
```

ADB remains bound to the basement Mac Mini.

---

# 18. Physical Device Power Management

Investigate Android settings that prevent the phone from becoming unusable after sitting connected for days/weeks.

Desired behavior:

```text
Phone powered
Phone charging
Wi-Fi connected
Screen normally off
ADB available
Apps remain installed
Device does not sleep in a way that breaks remote access
```

Do not disable security mechanisms unnecessarily.

In particular, do not automatically remove:

* lock screen security
* Play Protect
* Google security features

unless testing demonstrates a specific need.

---

# 19. Initial Physical-Phone MVP

Do NOT attempt everything at once.

Build this sequence:

### Step 1

Connect phone:

```bash
adb devices
```

### Step 2

Create:

```text
PhysicalDevice
```

### Step 3

Implement screenshot:

```text
GET /realphone/frame
```

### Step 4

Implement:

```text
tap
```

### Step 5

Implement:

```text
swipe
```

### Step 6

Implement:

```text
back
home
```

### Step 7

Implement text entry.

### Step 8

Connect existing KaiOS UI.

### Step 9

Test:

```text
Chrome
Settings
Google Play
```

### Step 10

Test:

```text
WhatsApp
McDonald's
```

Only after this works should the accessibility agent be developed.

---

# 20. Success Criteria

The project is successful when:

```text
KaiOS phone
    |
    v
android.elliscode.com/realphone
    |
    v
Mac Mini
    |
    v
USB
    |
    v
Physical Android phone
```

allows me to:

* see the Android screen
* tap
* swipe
* type
* press Back
* press Home
* launch applications
* provide location
* use installed Android applications

with approximately the same experience as the existing redroid implementation.

---

# 21. Future Architecture

Eventually support multiple physical Android devices:

```text
Mac Mini
│
├── Pixel 6a
│      └── /realphone/1
│
├── Android Phone #2
│      └── /realphone/2
│
└── redroid
       └── /redroid
```

Then potentially:

```text
android.elliscode.com/
    /redroid
    /realphone
    /realphone/1
    /realphone/2
```

The frontend should remain device-agnostic.

---

# 22. Design Philosophy

This project should remain intentionally simple.

Prefer:

```text
USB
ADB
Node
HTTP/WebSocket
JPEG
KaiOS JavaScript
```

over introducing a huge remote-desktop stack.

The current system works because it exploits the fact that the KaiOS client only needs:

```text
screen image
+
input events
```

Continue using that principle.

The physical Android phone is simply another Android backend.

---

# 23. First Task for Claude

Before changing code:

1. Inspect the existing repository.
2. Identify the current ADB abstraction, if any.
3. Identify the screenshot pipeline.
4. Identify input handling.
5. Identify authentication.
6. Identify location forwarding.
7. Identify the current redroid-specific assumptions.
8. Propose the smallest refactor necessary to introduce `PhysicalDevice`.
9. Do not rewrite working redroid code.
10. Then implement the physical-device MVP incrementally.

Do not make architectural changes merely for theoretical cleanliness.

The existing redroid implementation is working in production/test use and should remain functional throughout the refactor.
