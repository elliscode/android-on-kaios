# Unplugging and replugging the iPhone

What to do when you take the iPhone off this Mac (to install apps, sign in to things, take it
somewhere) and later plug it back in. Setup itself is in [IPHONE.md](IPHONE.md).

## The short version

- **Before unplugging:** nothing is required.
- **After plugging back in:** unlock the phone, then start WebDriverAgent (WDA) again:
  `./scripts/ios/start-wda.sh`. With autostart installed, it restarts by itself.
- **Away 6 days or more:** re-sign first (`./scripts/ios/resign-wda.sh`), because a free Apple ID's
  signature lasts 7 days.

Anything you do on the phone while it's unplugged is fine: install App Store apps (they don't count
toward the free account's 3-app limit), sign in to accounts, change settings. None of that affects
WDA.

## What survives unplugging, and what doesn't

| Stays set | Stops |
| --- | --- |
| The Mac pairing ("Trust This Computer") | WDA. It runs as an Xcode test over USB, so unplugging ends it |
| Developer Mode, Enable UI Automation | A location shared with key 7: the phone goes back to its own GPS until WDA is back |
| Your trusted developer profile | |
| The WDA app on the phone (until its signature expires) | |
| The iPhone server: it waits and reconnects when WDA is back | |

## Before unplugging

Nothing is required. Optionally:
- **If you started WDA by hand** (`start-wda.sh` in a terminal), it exits on its own when the phone
  is unplugged. Pressing Ctrl+C first just keeps its log quieter.
- **If you'll be away 6 days or more,** check when the signature expires (see below) and re-sign now
  while the phone is still plugged in. Re-signing starts a fresh 7 days.

## After plugging back in

1. **Unlock the phone.** WDA can't start on a locked phone, and it can't unlock one. If the phone
   restarted while it was away, you also need your passcode this once.
2. If the phone asks **"Trust This Computer?"**, tap Trust. It usually remembers, but it can ask
   again after an iOS update or if trust was reset.
3. Check **Auto-Lock is still Never** (Settings → Display & Brightness), in case you changed it
   while using the phone.
4. **Start WDA:**
   - **Started by hand:** run `./scripts/ios/start-wda.sh` and wait for `ServerURLHere`.
   - **Autostart installed:** nothing to do. The `iphone-wda` service retries every 10 seconds, so
     it's back within about half a minute of the phone being plugged in and unlocked.
5. **Check it's working:** `curl -s 127.0.0.1:8100/status` shows `"ready" : true`. Then reload
   `https://iphone.elliscode.com` on the flip phone; the screen updates within a few seconds.
   There's no need to restart the iPhone server.
6. **If you use a shared location,** press **7** again, or wait: the server re-applies a saved
   location within 10 seconds.

## Away for 6 days or more (the 7-day signature)

A free Apple ID signs WDA for **7 days**. When it runs out, the phone won't open WDA:
`start-wda.sh` fails with an error about the app, its profile or its code signature, and on the
phone the WebDriverAgentRunner icon may appear dimmed or say it's no longer available.

Re-signing needs the phone **plugged in and unlocked**, because the build is signed for this
specific phone. So while the phone is away, re-signing can't happen, even automatically. That
includes autostart's `iphone-resign` service: it runs every 6 days and at login, and if the phone
is away at that moment, that attempt fails and the next one is 6 days later.

**Check when the current signature expires:**

```sh
security cms -D -i ios/build/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app/embedded.mobileprovision \
  | plutil -extract ExpirationDate raw -o - -
```

**Re-sign** (phone plugged in and unlocked):
- **Autostart installed:** `./scripts/ios/resign-wda.sh`. It rebuilds, then restarts the `iphone-wda`
  service.
- **Started by hand:** stop WDA (Ctrl+C), run `./scripts/ios/build-wda.sh`, then
  `./scripts/ios/start-wda.sh`.

Rule of thumb: after any absence of 6 days or more, re-sign before starting WDA. It takes a couple
of minutes and does no harm if the signature wasn't expired yet.

## Other edge cases

- **Re-signing fails with an account or provisioning error.** Xcode's Apple ID sign-in may have
  expired. Open Xcode → Settings → Accounts, sign in again if it asks, and re-run
  `./scripts/ios/build-wda.sh`. The full error is in `ios/build.log`.
- **"Untrusted Developer" when WDA starts.** Trust the profile again: Settings → General → VPN &
  Device Management → your Apple ID → Trust. This happens if you deleted WDA from the phone
  (removing the last app from a developer removes the trust), or after re-signing with a new
  certificate.
- **You deleted the WebDriverAgentRunner app from the phone.** No problem: `start-wda.sh` installs
  it again. You may need to trust the profile again (see above).
- **iOS updated while the phone was away.** The first connection afterwards can take several
  minutes while the Mac prepares the phone for development (Xcode shows "Preparing…"). If the new
  iOS is newer than this Xcode supports, update Xcode first. Developer Mode stays on across updates.
- **Developer Mode got turned off** (for example by erasing the phone): Settings → Privacy &
  Security → Developer Mode → on, restart, and confirm. Then check Settings → Developer → Enable UI
  Automation.
- **The phone is plugged in but not detected.** Check `xcrun devicectl list devices`: it should say
  `connected`. Try another cable or port (some cables only charge), and unlock the phone.
- **`start-wda.sh` stops at a `Password:` prompt** (after lines like "Executed 0 tests"). The Mac's
  developer tools security is off: press Ctrl+C, run `sudo DevToolsSecurity -enable` once, then
  start WDA again.
- **Nothing works and it isn't clear why.** Run `./scripts/ios/start-wda.sh` in a terminal and read
  the first error it prints. With autostart installed, look in `logs/iphone-wda.log` and
  `logs/iphone-resign.log`.
