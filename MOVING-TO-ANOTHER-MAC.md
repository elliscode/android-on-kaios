# Moving android-on-kaios to another Mac

This moves everything, including your Google login, WhatsApp registration and McDonald's
sign-in, from this Mac to another Apple Silicon Mac (e.g. a Mac mini M4). You don't need to set
anything up again on the Android side.

Three things move:

| What | Where it lives | How it moves |
| --- | --- | --- |
| The Android image (`redroid-gapps:14`, about 2.7 GB) | Docker on this Mac | `docker save`, then `docker load` |
| Android's data (logins, apps, chats, about 1.5 GB) | Docker volume `android-on-kaios_android-data` | `scripts/backup-data.sh`, then `scripts/restore-data.sh` |
| This project folder (server, phone page, scripts, certificates, saved location) | `~/git/android-on-kaios` | Copy the folder |

> **Never run both Macs at the same time.** It's the same Android device with the same WhatsApp
> registration. Two copies online at once can get WhatsApp logged out or the account flagged. Stop
> the old Mac before starting the new one.

## Prerequisites on the new Mac

You already have Homebrew. Install the rest:

```sh
brew install --cask orbstack                 # Docker + the Linux VM Android runs in
brew install node                            # Node.js (18 or newer) for the server
brew install --cask android-platform-tools   # adb, how the server talks to Android
brew install caddy                           # HTTPS for android.elliscode.com
```

Open **OrbStack** once after installing it and finish its first-run setup, so that `docker ps`
works.

You don't need Java, Python or the Android SDK. The prebuilt files (the Android image and
`server/a11y.jar`) come with you.

## Step 1: Pack everything up (on the old Mac)

1. **Stop the server:** press Ctrl-C in the terminal running `npm start`.

2. **Take a fresh backup of Android's data**, then stop Android so WhatsApp only runs in one place:
   ```sh
   cd ~/git/android-on-kaios
   ./scripts/backup-data.sh          # writes backups/android-data-<date>.tar.gz (~1 min)
   docker compose stop android
   ```

3. **Make a transfer folder and export the Android image into it** (a few minutes, about 1 GB
   compressed):
   ```sh
   mkdir -p ~/Desktop/android-move
   docker save redroid-gapps:14 | gzip > ~/Desktop/android-move/redroid-gapps-14.tar.gz
   ```

4. **Copy the project into the transfer folder**, leaving out things that are rebuilt or not
   needed:
   ```sh
   rsync -a \
     --exclude node_modules \
     --exclude docker/mindthegapps --exclude docker/mindthegapps.zip \
     --exclude 'docker/r8-*.jar' \
     ~/git/android-on-kaios/ ~/Desktop/android-move/android-on-kaios/
   ```
   This includes `backups/` (your data), `server/sessions.json` (so your phone stays logged in),
   `server/location.json` (your shared location), `server/a11y.jar`, `Caddyfile`, and the
   `docker/` overlays.

5. **Move `~/Desktop/android-move` to the new Mac:** use an external drive, AirDrop, or
   `scp -r ~/Desktop/android-move <user>@<mac-mini>.local:~/Desktop/`.

## Step 2: Unpack and start (on the new Mac)

1. **Put the project in place.** Keep the folder name **`android-on-kaios`**, because Docker names
   the data volume after it.
   ```sh
   mkdir -p ~/git
   mv ~/Desktop/android-move/android-on-kaios ~/git/
   cd ~/git/android-on-kaios
   ```

2. **Load the Android image:**
   ```sh
   docker load -i ~/Desktop/android-move/redroid-gapps-14.tar.gz
   docker image ls redroid-gapps          # should list redroid-gapps:14
   ```

3. **Start Android once.** This creates the data volume with a blank Android:
   ```sh
   docker compose up -d
   ```

4. **Restore your data over it.** Use the newest file in `backups/` and answer `y`:
   ```sh
   ls backups/
   ./scripts/restore-data.sh backups/android-data-<date>.tar.gz
   ```
   The script stops Android, replaces its data with the backup, and starts it again.

5. **Wait for Android to boot** (about 1–2 minutes). This should end by printing `1`:
   ```sh
   adb connect localhost:5555
   until [ "$(adb -s localhost:5555 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done; echo 1
   ```

6. **Start the server:**
   ```sh
   cd server
   npm install
   npm start
   ```
7. **Start Caddy** from the project folder, in another terminal:
   ```sh
   cd ~/git/android-on-kaios
   caddy run --config Caddyfile
   ```
   If macOS asks whether `caddy` may accept incoming network connections, click **Allow**.

## Step 3: Point the internet at the new Mac

1. **Get the new Mac's LAN IP address:** `ipconfig getifaddr en0` (or `en1` if it's on Wi-Fi and
   `en0` prints nothing).
2. **On your router, change the TCP 443 port forward** to point at the new Mac's LAN IP. If the
   new Mac is on a different home connection, also update the `android` A record to that home's
   public IP.
3. **On the KaiOS phone, open `https://android.elliscode.com`.** If you copied
   `server/sessions.json`, you're still logged in. Otherwise log in from home with the code from
   the server log.
4. **Check it works:**
   - The Android screen appears.
   - WhatsApp opens your chats.
   - The Play Store is still signed in.
   - McDonald's shows your code.

Everything else is automatic when the server connects: the tap fallback helper, the letterbox fix,
and your saved location.

If WhatsApp asks you to verify your number again, follow the same steps as the first time. That
means switching Play Services off during verification and back on afterwards; ask Claude to do it.
This shouldn't be needed, because WhatsApp's data comes across unchanged.

## After a reboot of the new Mac

1. Open OrbStack (or set it to start at login in its settings).
2. `cd ~/git/android-on-kaios && docker compose up -d`. This also re-applies the binder permission
   fix; Android doesn't auto-start without it.
3. `cd server && npm start`.
4. `caddy run --config Caddyfile` (from the project folder).

Android needs to run at least every couple of weeks, or WhatsApp logs out linked devices such as
your iPad's WhatsApp Web.

## Cleaning up the old Mac (once the new one is confirmed working)

Keep the old copy until you're sure. When you are:

```sh
cd ~/git/android-on-kaios
docker compose down            # removes the container; the data volume stays
# Optional, permanent: delete the old Android data and image
# docker volume rm android-on-kaios_android-data
# docker image rm redroid-gapps:14
```

## If something goes wrong

- **`docker compose up` fails, or Android never boots:** check that OrbStack is running
  (`docker ps`). Then look at `docker ps -a` and `docker logs android`. The OrbStack kernel
  workarounds in the README (binder, lmkd, Bluetooth) apply the same way on any Mac with OrbStack.
- **Taps work but no accessibility fallback** (the server log says `a11y.jar` not found):
  `server/a11y.jar` didn't get copied. Copy it over, or rebuild it with
  `./scripts/build-helper.sh`, which needs a JDK: `brew install openjdk`.
- **`https://android.elliscode.com` doesn't load:** check that Caddy is running and says it
  obtained a certificate, that the router forwards TCP 443 to this Mac, and that the A record
  points at your home IP (`dig +short android.elliscode.com`).
- **Want the image rebuilt instead of copied?** `./scripts/build-image.sh` downloads and builds it
  from scratch. Your data backup still restores on top of it.
