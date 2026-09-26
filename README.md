# android-on-kaios

Run Android apps in a container on a Mac, and use them from a KaiOS 3.0.1 phone (Gecko 84).

```
KaiOS browser  --XHR-->  Node server (Mac, :8080)  --adb-->  redroid container (:5555)
```

- Android runs natively in a container via [redroid](https://github.com/remote-android/redroid-doc) (Android 14, arm64) with MindTheGapps (Play Store / Play Services).
- Android's screen is **960x2208 at 480 dpi**: 4x the phone's 240x276 area wide and two of those screens tall, so apps see a normal tall phone (320x736 dp). A near-square screen made apps letterbox or clip. The phone shows one half at a time. The resolution is set only in `docker-compose.yml`; the client works out the scale and number of pages from the frame size.
- The phone polls `/frame` every 1000 ms. The server hashes each raw screenshot and only sends a JPEG when it changed (else `204`).
- Clicking the screenshot taps the same spot on Android. If the screen hasn't changed at all 700 ms later (some screens, like WhatsApp registration, ignore simulated touches), the server retries it as an accessibility click on the element there, the way a screen reader does (`helper/A11yClick.java`).
- Key **7** sends the phone's own location to Android (GPS and network location are replaced by a fixed point, since the container has none). Until then it's the White House. It's saved in `server/location.json` and reapplied after reboots. This needs the HTTPS URL, because browsers only allow location on secure pages.
- Key **8** pans the view in half-screen steps: top → middle → bottom → middle → top. Key **0** scrolls the app down and **2** scrolls it up (a slow swipe of about 60% of one half).
- When Android shows its keyboard, a native text box appears at the top, pre-filled with the field's current text (all selected: type to replace it, or move the cursor to edit it). Enter replaces the Android field's text with the box's; Enter without changes presses Enter on Android. Backspace on an empty box, Back/Escape, or clicking the screenshot closes it. (For an empty field, Android may report its grey placeholder as text, so that shows up pre-filled; just type over it.)

## Setup

Needs OrbStack, `adb`, and Node 18+.

```sh
./scripts/build-image.sh       # once: builds redroid-gapps:14
docker compose up -d           # first boot takes ~2 min
./scripts/setup-device.sh      # installs ADBKeyBoard IME, sideloads anything in ./apks
./scripts/build-helper.sh      # once: builds server/a11y.jar (accessibility-click fallback; needs a JDK)
cd server && npm install && npm start
```

**After a Mac/OrbStack restart, run `docker compose up -d` again.** Android deliberately doesn't auto-start, because the binder permission fix has to run first.

Then on the phone, open `https://<mac-lan-ip>:8443` in the KaiOS browser and accept the self-signed certificate warning once (`ipconfig getifaddr en0` gives the IP). `http://<mac-lan-ip>:8080` works too, except for location sharing.

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

## API

| Endpoint | Description |
| --- | --- |
| `GET /frame?h=<hash>` | `200` JPEG (full Android resolution) or `204` if `h` is current. Headers: `X-Hash`, `X-Keyboard: 0\|1` |
| `POST /tap {x, y}` | Android coordinates |
| `POST /scroll {dir}` | `dir` is `up` or `down`; swipes through the middle of the screen |
| `GET /field` | `{text}` of the focused Android field (~2 s, via a UI dump) |
| `GET/POST /location {lat, lng, accuracy}` | Location Android reports to apps |
| `POST /text {text, replace, enter}` | `replace` clears the field first; types Unicode text via ADBKeyBoard; `enter` sends KEYCODE_ENTER |
