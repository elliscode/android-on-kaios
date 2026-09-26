# android-on-kaios

Run Android apps in a container on a Mac, and use them from a KaiOS 3.0.1 phone (Gecko 84).

```
KaiOS browser  --XHR-->  Node server (Mac, :8080)  --adb-->  redroid container (:5555)
```

- Android runs natively in a container via [redroid](https://github.com/remote-android/redroid-doc) (Android 14, arm64) with MindTheGapps (Play Store / Play Services).
- Android's screen is **960x1104 at 480 dpi = 4x the phone's 240x276 usable area**, so it renders sharp but lays out the same. The resolution is set only in `docker-compose.yml`. The client works out the scale from the frame width (phone px × 4 = Android px).
- The phone polls `/frame` every 1000 ms. The server hashes each raw screenshot and only sends a JPEG when it changed (else `204`).
- Clicking the screenshot taps the same spot on Android.
- When Android shows its keyboard, a native text box appears at the top. Enter sends the text, Enter on an empty box presses Enter on Android, and Backspace on an empty box, Back/Escape, or clicking the screenshot closes it.

## Setup

Needs OrbStack, `adb`, and Node 18+.

```sh
./scripts/build-image.sh       # once: builds redroid-gapps:14
docker compose up -d           # first boot takes ~2 min
./scripts/setup-device.sh      # installs ADBKeyBoard IME, sideloads anything in ./apks
cd server && npm install && npm start
```

**After a Mac/OrbStack restart, run `docker compose up -d` again.** Android deliberately doesn't auto-start, because the binder permission fix has to run first.

Then on the phone, open `http://<mac-lan-ip>:8080` in the KaiOS browser (`ipconfig getifaddr en0` gives the IP).

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

## API

| Endpoint | Description |
| --- | --- |
| `GET /frame?h=<hash>` | `200` JPEG (full Android resolution) or `204` if `h` is current. Headers: `X-Hash`, `X-Keyboard: 0\|1` |
| `POST /tap {x, y}` | Android coordinates |
| `POST /text {text, enter}` | Types Unicode text via ADBKeyBoard; `enter: true` sends KEYCODE_ENTER |
