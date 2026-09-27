const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const adb = require('./adb');
const auth = require('./auth');

// Only Caddy (on this Mac) talks to the server; it provides HTTPS for android.elliscode.com.
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CAPTURE_MS = 1000;
const IDLE_AFTER_MS = 5000; // stop capturing when no client has polled for this long
const JPEG_QUALITY = 70;
const LOCATION_FILE = path.join(__dirname, 'location.json');
const LOCATION_REFRESH_MS = 10000; // re-send so apps waiting for location updates get one
const DEFAULT_LOCATION = { lat: 38.8977, lng: -77.0365, accuracy: 10 }; // the White House

// Latest encoded frame and keyboard state, shared by all clients.
let frame = null; // { hash, jpeg, width, height }
let keyboard = false;
let lastPollAt = 0;
let inFlight = null; // the running capture, so concurrent callers share it
let timer = null;

function capture() {
  if (!inFlight) inFlight = doCapture().finally(() => { inFlight = null; });
  return inFlight;
}

async function doCapture() {
  try {
    const shot = await adb.screencapRaw();
    const hash = crypto.createHash('sha1').update(shot.pixels).digest('hex');
    if (!frame || frame.hash !== hash) {
      const jpeg = await sharp(shot.pixels, { raw: { width: shot.width, height: shot.height, channels: 4 } })
        .removeAlpha()
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      frame = { hash, jpeg, width: shot.width, height: shot.height };
    }
    keyboard = await adb.keyboardShown();
  } catch (err) {
    console.error('capture failed:', err.message.trim());
    await connect();
  }
}

// Location Android reports to apps. Set from the phone's GPS (key 7), saved across restarts.
let location = loadLocation();

function loadLocation() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8'));
    if (validLocation(l)) return l;
  } catch (err) { /* no saved location yet */ }
  return DEFAULT_LOCATION;
}

function validLocation(l) {
  return l && Number.isFinite(l.lat) && Number.isFinite(l.lng) &&
    Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180 &&
    Number.isFinite(l.accuracy) && l.accuracy > 0;
}

async function applyLocation() {
  try {
    await adb.setMockLocation(location.lat, location.lng, location.accuracy);
  } catch (err) {
    // Providers are gone after an Android reboot: set them up again, then retry.
    await adb.setupMockLocation();
    await adb.setMockLocation(location.lat, location.lng, location.accuracy);
  }
}

// adb connect plus everything Android forgets on reboot.
async function connect() {
  await adb.connect();
  await applyLocation().catch((err) => console.error('location failed:', err.message.trim()));
}

setInterval(() => { applyLocation().catch(() => {}); }, LOCATION_REFRESH_MS);

function loop() {
  timer = null;
  if (Date.now() - lastPollAt > IDLE_AFTER_MS) return; // idle: wait for the next poll to restart
  capture().then(() => {
    if (!timer) timer = setTimeout(loop, CAPTURE_MS);
  });
}

function wake() {
  lastPollAt = Date.now();
  if (!timer) loop(); // concurrent loop() calls share one capture and schedule one timer
}

// Capture again shortly after an input so the phone sees the result on its next poll.
function recaptureSoon() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loop, 300);
}

const app = express();
app.set('trust proxy', 'loopback'); // client IP from Caddy's X-Forwarded-For, trusted only from 127.0.0.1
app.use(express.json({ limit: '16kb' }));

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

// The app page with the session's CSRF token and style.css / app.js inlined.
function appPage(csrf) {
  return readPublic('index.html')
    .replace('<!--CSRF-->', () => '<meta name="csrf" content="' + csrf + '">')
    .replace('<!--STYLE-->', () => '<style>\n' + readPublic('style.css') + '</style>')
    .replace('<!--SCRIPT-->', () => '<script>\n' + readPublic('app.js') + '</script>');
}

// Logged in: the app. Otherwise: the login page (and, from home, a new code in the log).
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = auth.session(req);
  if (s) return res.type('html').send(appPage(s.csrf));
  const issued = auth.startAttempt(req, res);
  res.type('html').send(readPublic('login.html')
    .replace('<!--NOTICE-->', () => issued ? '' : 'Login is only available from the home network'));
});

app.get('/login.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('js').send(readPublic('login.js'));
});

app.post('/login', auth.login);

// Everything below requires a session cookie plus the X-CSRF-Token header.
app.use(auth.requireSessionAndCsrf);

app.get('/frame', async (req, res) => {
  wake();
  if (!frame) await capture();
  res.set('Cache-Control', 'no-store');
  res.set('X-Keyboard', keyboard ? '1' : '0');
  if (!frame) return res.status(503).end();
  res.set('X-Hash', frame.hash);
  if (req.query.h === frame.hash) return res.status(204).end();
  res.type('image/jpeg').send(frame.jpeg);
});

// Some screens ignore injected touches (WhatsApp registration). If the screen hasn't changed at
// all this long after a tap, the tap is retried as an accessibility click on the element there.
const TAP_FALLBACK_MS = 700;

app.post('/tap', async (req, res) => {
  const w = frame ? frame.width : 960;
  const h = frame ? frame.height : 2208;
  const x = Math.round(Number(req.body && req.body.x));
  const y = Math.round(Number(req.body && req.body.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y required' });
  const tx = Math.min(Math.max(x, 0), w - 1);
  const ty = Math.min(Math.max(y, 0), h - 1);
  let before;
  try {
    await capture();
    before = frame && frame.hash;
    await adb.tap(tx, ty);
    res.status(204).end();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  setTimeout(async () => {
    await capture();
    if (!frame || frame.hash !== before) return recaptureSoon(); // the tap did something
    try {
      const result = await adb.a11yClick(tx, ty);
      console.log('tap ignored at ' + tx + ',' + ty + '; accessibility click:', JSON.stringify(result));
    } catch (err) {
      console.error('accessibility click failed:', err.message.trim());
    }
    recaptureSoon();
  }, TAP_FALLBACK_MS);
});

// Scrolls by swiping vertically through the middle of the screen. A slow swipe (no fling)
// moves the content by about the swipe distance, so each press is predictable.
const SCROLL_FRACTION = 0.3; // of full screen height per press (~60% of one visible half)
const SCROLL_MS = 500;

app.post('/scroll', async (req, res) => {
  const dir = req.body && req.body.dir;
  if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: 'dir must be up or down' });
  const w = frame ? frame.width : 960;
  const h = frame ? frame.height : 1104;
  const x = Math.round(w / 2);
  const top = Math.round(h * (0.5 - SCROLL_FRACTION / 2));
  const bottom = Math.round(h * (0.5 + SCROLL_FRACTION / 2));
  try {
    // Scrolling down means dragging the content up, from bottom to top.
    if (dir === 'down') await adb.swipe(x, bottom, x, top, SCROLL_MS);
    else await adb.swipe(x, top, x, bottom, SCROLL_MS);
    recaptureSoon();
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Current text of the focused Android field, so the phone can pre-fill its text box.
app.get('/field', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ text: await adb.focusedFieldText() });
  } catch (err) {
    res.json({ text: '' }); // e.g. uiautomator can't dump while the screen is animating
  }
});

app.get('/location', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(location);
});

app.post('/location', async (req, res) => {
  const b = req.body || {};
  const l = { lat: Number(b.lat), lng: Number(b.lng), accuracy: Math.max(1, Math.round(Number(b.accuracy) || 10)) };
  if (!validLocation(l)) return res.status(400).json({ error: 'lat and lng required' });
  location = l;
  fs.writeFileSync(LOCATION_FILE, JSON.stringify(location));
  try {
    await applyLocation();
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Photo from the phone's camera (key 9): normalised to JPEG and saved to Android's camera folder,
// so it can be attached from the gallery in any app.
app.post('/photo', express.raw({ type: 'image/*', limit: '25mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'image body required' });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = 'KaiOS_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.jpg';
  const tmp = path.join(os.tmpdir(), 'android-on-kaios-' + process.pid + '-' + name);
  try {
    // rotate() applies the EXIF orientation; re-encoding also rejects anything that isn't an image.
    // withMetadata() keeps EXIF such as the time taken (orientation is reset after rotating).
    await sharp(req.body).rotate().withMetadata().jpeg({ quality: 90 }).toFile(tmp);
    await adb.pushMedia(tmp, '/sdcard/DCIM/Camera/' + name);
    res.json({ name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

app.post('/notifications', async (req, res) => {
  try {
    const open = await adb.toggleNotifications();
    recaptureSoon();
    res.json({ open });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/text', async (req, res) => {
  const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  const replace = !!(req.body && req.body.replace);
  const enter = !!(req.body && req.body.enter);
  try {
    if (replace) await adb.clearText();
    if (text) await adb.inputText(text);
    if (enter) await adb.keyevent(66); // KEYCODE_ENTER
    recaptureSoon();
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

connect().then(() => {
  app.listen(PORT, HOST, () => console.log('Listening on http://' + HOST + ':' + PORT));
});
