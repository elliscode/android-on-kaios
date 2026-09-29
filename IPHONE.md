# iPhone at iphone.elliscode.com

The same KaiOS page, controlling a real iPhone plugged into this Mac by USB.

```
KaiOS → Caddy (:443, iphone.elliscode.com) → Node server (DEVICE=ios, 127.0.0.1:8081)
      → WebDriverAgent over USB (iproxy, 127.0.0.1:8100) → iPhone
```

- **WebDriverAgent (WDA)** is Appium's XCUITest runner: a test app on the phone with an HTTP API for
  screenshots, taps, drags, typing and the Home button. `idb` can't do this: its tap and typing
  commands only work on the iOS Simulator.
- `server/ios.js` has the same functions as `server/adb.js`. It scales screenshots to 960 px wide
  (240 on the flip phone) at the phone's own aspect ratio, e.g. 960x2081. Key 8 pans top, middle,
  bottom, with the bottom stop ending exactly at the bottom of the iPhone's screen.
- It has its own logins (`server/sessions-iphone.json`) and location (`server/location-iphone.json`).

## Keys

| Key | iPhone |
| --- | --- |
| 2 / 0 | Scroll up / down |
| 8 | Pan the view |
| 4 | Open / close Notification Center |
| 7 | Set the iPhone's location to the flip phone's (XCTest location simulation). Until you do, the iPhone uses its own GPS |
| Call | Home screen |
| \* | Back: swipes in from the left edge. iOS has no Back button, so this only works where the app supports the swipe-back gesture. On the home screen it goes one page left (the leftmost is the Today View) |
| # | Swipes in from the right edge: the next home screen page, or back from the Today View to the home screen |
| 6 | App switcher |
| 9 | Not supported (photo upload is Android-only) |

The text box works as on Android: it opens when the iPhone's keyboard is up, and Enter types into the focused field.

## One-time setup

### On the iPhone
1. Plug it into this Mac, unlock it, and tap **Trust** (enter the passcode). `xcrun devicectl list
   devices` should show it without `unavailable`. If it never asks, try another cable: some are
   charge-only.
2. **Developer Mode:** Settings → Privacy & Security → Developer Mode → on, then restart and confirm.
   (The option only appears after the Mac has seen the phone; Xcode's Devices window, ⇧⌘2, can
   help trigger it.)
3. Settings → Developer → **Enable UI Automation** → on.
4. Settings → Display & Brightness → **Auto-Lock → Never**, and keep it plugged in. WDA can't unlock
   a locked phone.

### On the Mac
1. Xcode → Settings → Accounts → **+** → Apple ID (a free one works). This creates the signing
   certificate.
2. `brew install libimobiledevice` (for `iproxy`).
3. `./scripts/ios/build-wda.sh`. The first run creates `ios/config.env`: fill in `TEAM_ID`
   (instructions inside), then run it again. It downloads WDA, applies the network patch, and
   signs and builds it (a few minutes).
4. On the iPhone: Settings → General → **VPN & Device Management** → your Apple ID → **Trust**. This
   is needed once, after the first install.
5. DNS: add an A record for **iphone.elliscode.com** pointing at the same IP as
   android.elliscode.com. The router's port 443 forward already covers it. Caddy gets the
   certificate by itself once you reload it: `caddy reload --config Caddyfile`.

## Running it

By hand, in three terminals:

```sh
./scripts/ios/start-wda.sh            # WDA on the phone + USB forward; wait for "ServerURLHere"
cd server && npm run start:iphone     # the iPhone server on 127.0.0.1:8081
caddy run --config Caddyfile          # if Caddy isn't already running
```

Or automatically: once `ios/config.env` exists, `./scripts/install-autostart.sh` also installs:
- `iphone-wda` (WDA, restarted if it exits)
- `iphone-server` (the server, restarted if it exits)
- `iphone-resign` (see below)

Logs are in `logs/iphone-*.log`, including the login codes for iphone.elliscode.com.

Then open `https://iphone.elliscode.com` on the flip phone and log in with the code from the iPhone
server's log.

## Free Apple ID: re-signing every week

A free Apple ID signs WDA for **7 days**. The `iphone-resign` agent re-runs `build-wda.sh` every
6 days (and at login) and restarts WDA. If signing ever fails, for example because Xcode's Apple
ID session expired, iPhone control stops until you fix it:
1. Open Xcode → Settings → Accounts and sign in again if asked.
2. Run `./scripts/ios/resign-wda.sh`, or `./scripts/ios/build-wda.sh` if you start WDA by hand.
3. Check `logs/iphone-resign.log`.

A free Apple ID can have 3 of your own apps on the phone (WDA uses one). App Store apps don't count.
A paid developer account ($99/year) signs for a year, so the weekly re-sign isn't needed.

## Not reachable from the home network

This matches Android, where adb is only on `127.0.0.1:5555`. Out of the box, WDA listens on all of
the phone's networks with no password, so anyone on the Wi-Fi could control the phone. Here:
- `start-wda.sh` sets WDA's `USE_IP=127.0.0.1`, so its control server (port 8100) listens only on
  the phone's own loopback.
- `build-wda.sh` patches WDA so its screen-streaming (MJPEG) server (port 9100) uses that same
  address. Upstream binds it to every interface. If a new WDA version moves that code, the build
  fails instead of producing an exposed server.
- The Mac reaches WDA only through USB: `iproxy` (usbmux) arrives on the phone's loopback, and
  listens only on the Mac's 127.0.0.1. The iPhone server listens on 127.0.0.1:8081, behind Caddy
  and the login.

Check it, with the phone's Wi-Fi IP from Settings → Wi-Fi → (i):
`curl --max-time 3 http://<phone-ip>:8100/status` and `nc -z -w 3 <phone-ip> 9100` must both fail,
while `curl 127.0.0.1:8100/status` on the Mac works.

## Limits

- The phone must stay unlocked and on USB. After the phone restarts, unlock it once in person.
- Location (7) uses XCTest simulation (iOS 16.4+). Apps can tell it's simulated, and some may
  refuse it.
- DRM video appears black in screenshots.
- Each frame is a WDA screenshot, about 0.3 to 0.8 s. If that's too slow, WDA's MJPEG stream is an
  option (loopback-only as above).
