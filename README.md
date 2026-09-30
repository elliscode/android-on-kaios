# android-on-kaios

Run Android apps in a container on a Mac, and use them from a KaiOS 3.0.1 phone (Gecko 84).

```
KaiOS browser --HTTPS--> Caddy (:443, android.elliscode.com) --> Node server (127.0.0.1:8080) --adb--> redroid (:5555)
```

- Access is gated by a login (see [Public access and login](#public-access-and-login)).

- Android runs natively in a container via [redroid](https://github.com/remote-android/redroid-doc) (Android 14, arm64) with MindTheGapps (Play Store / Play Services).
- Android's screen is **960x2208 at 480 dpi**: 4x the phone's 240x276 area wide and two of those screens tall, so apps see a normal tall phone (320x736 dp). A near-square screen made apps letterbox or clip. The phone shows one half at a time. The resolution is set only in `docker-compose.yml`; the client works out the scale and number of pages from the frame size.
- The phone polls `/frame` every 1000 ms. The server hashes each raw screenshot and only sends a JPEG when it changed (else `204`).
- Clicking the screenshot taps the same spot on Android. If the screen hasn't changed at all 700 ms later (some screens, like WhatsApp registration, ignore simulated touches), the server retries it as an accessibility click on the element there, the way a screen reader does (`helper/A11yClick.java`).
- Key **7** sends the phone's own location to Android, which reports it as a real GPS fix (the container has no GPS; see the GNSS HAL below). Until then it's the White House. It's saved in `server/location.json` and reapplied after reboots. This needs HTTPS, because browsers only allow location on secure pages.
- Key **4** opens or closes Android's notification shade. (Key 1 is left to the KaiOS browser, which uses it for zoom.)
- **Call** goes to the home screen and **6** opens the app switcher (recent apps). Android's own Back button is on screen.
- Key **9** opens the phone's camera (or photo picker). The photo is uploaded, saved to Android's `DCIM/Camera` and indexed, so you can attach it from the gallery in any app. There's no live camera passthrough, because Android here has no camera HAL.
- Key **8** pans the view: top → middle → bottom → middle → top, in evenly spaced steps of at most half a screen.
- Swipes start **where the KaiOS cursor is**, so with two scrollable panes the one under the cursor moves. **0** scrolls down and **2** scrolls up (a slow swipe of about 60% of one half); **\*** swipes left-to-right and **#** right-to-left (previous / next page, carousels). Near an edge, a swipe is shortened to stay on the screen.
- When Android shows its keyboard, a native text box appears at the top, pre-filled with the field's current text (all selected: type to replace it, or move the cursor to edit it). Enter replaces the Android field's text with the box's; Enter without changes presses Enter on Android. Backspace on an empty box, Back/Escape, or clicking the screenshot closes it. (For an empty field, Android may report its grey placeholder as text, so that shows up pre-filled; just type over it.)

The same page can also control a **real iPhone** at `iphone.elliscode.com`: see [IPHONE.md](IPHONE.md).

Moving to another Mac (image, data and all): see [MOVING-TO-ANOTHER-MAC.md](MOVING-TO-ANOTHER-MAC.md).

Planned (not started): moving to the official Android Emulator for a virtual camera. See [EMULATOR-MIGRATION.md](EMULATOR-MIGRATION.md).

## Setup

Needs OrbStack, `adb`, and Node 18+.

```sh
./scripts/build-gnss.sh        # once: builds the GPS HAL into docker/overlay (uses a Docker toolchain)
./scripts/build-image.sh       # once: builds redroid-gapps:14
docker compose up -d           # first boot takes ~2 min
./scripts/setup-device.sh      # installs ADBKeyBoard IME, sideloads anything in ./apks
./scripts/build-helper.sh      # once: builds server/helpers.jar (accessibility clicks, secure-screen capture)
cd server && npm install && npm start
caddy run --config Caddyfile   # from the project folder, in another terminal (brew install caddy)
```

**After a Mac/OrbStack restart, run `docker compose up -d` again.** Android deliberately doesn't auto-start, because the binder permission fix has to run first.

Then on the phone, open `https://android.elliscode.com` in the KaiOS browser (from home the first time, to log in).

### Starting everything automatically

`./scripts/install-autostart.sh` registers Android, the server and Caddy as login items (launchd agents). The server and Caddy restart by themselves if they crash. Logs go to `logs/`, and login codes appear in `logs/server.log` (`tail -f logs/server.log`).
- **Needs:** automatic login (System Settings → Users & Groups) and OrbStack set to start at login.
- **Uninstall:** `./scripts/install-autostart.sh --uninstall`.

## Public access and login

The server listens only on `127.0.0.1:8080`. **Caddy** (`Caddyfile`) serves `https://android.elliscode.com` with an automatic Let's Encrypt certificate and forwards to it.

**One-time network setup:**
- **DNS:** an `A` record for `android.elliscode.com` pointing at the home public IP.
- **Router:** forward TCP 443 to this Mac.

**Logging in** (`server/auth.js`):
- **The code:** opening the site without a session shows "ENTER THE CODE SHOWN ON THE SCREEN". Each page load prints a new 8-digit code in the server log, `[login] code 12345678 for 192.168.0.57 (home)`, and reloading invalidates the previous one.
- **Home only:** codes are only issued, and only accepted, for requests from the home network. That means private LAN addresses, or the home's own public IP, which is whatever `android.elliscode.com` resolves to (refreshed every 5 minutes). Anything else is logged as `(not home)` and refused. It isn't counted against the limit, so strangers can't lock you out.
- **Attempt limit:** 2 code attempts per rolling hour, total. Each code allows one guess.
- **After login:**
  - **Cookie:** a 128-character `[a-zA-Z0-9]` cookie (`Secure; HttpOnly; SameSite=Strict`).
  - **CSRF token:** a 128-character token embedded in the page.
  - **Where it works:** both last **4 months** and work from anywhere, not just home.
  - **Every request** must carry both, or it gets a 401 and the page returns to the login screen.
- **Sessions** are stored hashed in `server/sessions.json`. To log everyone out: `node server/auth.js --revoke-all`, then restart the server.

**If the router can't loop the public address back** (the site doesn't open from home Wi-Fi), uncomment the LAN block in `Caddyfile` and use `https://<mac-lan-ip>` at home. It's a separate login with its own cookie.

### Installing apps

- **Play Store:** the device is uncertified. Open the Play Store once, re-run `./scripts/setup-device.sh` to print the GSF Android ID, register it at https://www.google.com/android/uncertified, wait, then sign in.
- **Sideload:** put `.apk` files in `./apks/` (or a folder per app for split APKs) and re-run `./scripts/setup-device.sh`. They must be arm64 builds.

## Keeping your data (Google login, apps)

Android's `/data` is the Docker volume `android-on-kaios_android-data`. It survives `docker compose down`/`up`, container recreates, image rebuilds and config changes like resolution. **Only `docker compose down -v` or `docker volume rm` deletes it.**

- `./scripts/backup-data.sh` saves it to `backups/android-data-<date>.tar.gz` (Android is stopped briefly).
- `./scripts/restore-data.sh backups/<file>.tar.gz` puts a backup back.

## OrbStack workarounds (in `docker-compose.yml` / `docker/overlay`)

OrbStack's Linux kernel differs from what redroid expects. Each of these was a boot failure:

| Problem | Fix |
| --- | --- |
| No 32-bit compat → Android 13's init aborts | Use Android 14 `64only` image |
| `/dev/binder*` are root-only (0600) → services can't open binder | `binder-perms` one-shot service chmods them to 0666 in the OrbStack VM |
| No PSI → `lmkd` exits → system_server hangs, Watchdog kills it | Fake `/sys/module/lowmemorykiller` (`docker/sysmodule`) so lmkd runs in legacy mode |
| Simulated Bluetooth HAL crash-loops → system_server hangs | Bluetooth HAL disabled and `android.hardware.bluetooth` feature removed |
| Play Protect stalls `adb install` forever | `setup-device.sh` disables adb install verification |
| No telephony feature → WhatsApp only offers companion (tablet) mode | `docker/overlay/.../android-on-kaios-telephony.xml` declares phone hardware (no real modem/SIM) |
| WhatsApp's registration screen ignores injected touches (anti-automation) | Taps with no visible effect are retried as accessibility clicks |
| Near-square display → portrait-locked apps (McDonald's) letterboxed into a narrow column | Server sets letterbox to use the display aspect ratio on every adb connect (resets on boot) |
| Play Services has no location permissions (setup wizard is skipped) → its fused location returns nothing, so apps like McDonald's find no nearby restaurant and can't load a code | `setup-device.sh` grants them to `com.google.android.gms` |
| No GPS hardware; test-provider locations are all marked mock | A GNSS HAL (`helper/gnss`, built by `build-gnss.sh`) reports the location the server sets (`vendor.gnss.location`) as real GPS fixes |
| Apps mark some screens `FLAG_SECURE` (Chick-fil-A's QR code) → `screencap` refuses to capture them | A root helper (`helper/ScreenCap.java`, kept running) captures through WindowManager with secure layers included; falls back to `screencap` if it fails |

## API

All endpoints except `GET /`, `GET /login.js` and `POST /login` need the session cookie plus an `X-CSRF-Token` header.

| Endpoint | Description |
| --- | --- |
| `POST /login {code}` | Exchanges the current code for a session (home network only; 2 per hour) |
| `GET /frame?h=<hash>` | `200` JPEG (full Android resolution) or `204` if `h` is current. Headers: `X-Hash`, `X-Keyboard: 0\|1` |
| `POST /tap {x, y}` | Android coordinates |
| `POST /scroll {dir, x, y}` | `dir` (where the content goes) is `up`, `down`, `left` or `right`; the swipe starts at `x, y` (device px, e.g. the cursor), or the middle if omitted |
| `GET /field` | `{text}` of the focused Android field (~2 s, via a UI dump) |
| `POST /notifications` | Toggles the notification shade |
| `POST /key {name}` | `home` or `switcher` |
| `POST /photo` (image body) | Saves the image to Android's camera folder as JPEG |
| `GET/POST /location {lat, lng, accuracy}` | Location Android reports to apps |
| `POST /text {text, replace, enter}` | `replace` clears the field first; types Unicode text via ADBKeyBoard; `enter` sends KEYCODE_ENTER |
