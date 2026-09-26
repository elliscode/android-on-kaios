const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const adb = require('./adb');

const PORT = Number(process.env.PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const CERT_DIR = path.join(__dirname, 'certs');
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
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

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

app.post('/tap', async (req, res) => {
  const w = frame ? frame.width : 480;
  const h = frame ? frame.height : 552;
  const x = Math.round(Number(req.body && req.body.x));
  const y = Math.round(Number(req.body && req.body.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y required' });
  try {
    await adb.tap(Math.min(Math.max(x, 0), w - 1), Math.min(Math.max(y, 0), h - 1));
    recaptureSoon();
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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

// Self-signed certificate for HTTPS, created once. Browsers only give pages location access over
// HTTPS, so the phone uses https://<mac-ip>:8443 (accepting the certificate warning once).
function loadOrCreateCert() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4').map((i) => 'IP:' + i.address);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', key, '-out', cert, '-subj', '/CN=android-on-kaios',
      '-addext', 'subjectAltName=' + ['DNS:localhost'].concat(ips).join(',')], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

connect().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log('Listening on http://0.0.0.0:' + PORT));
  https.createServer(loadOrCreateCert(), app)
    .listen(HTTPS_PORT, '0.0.0.0', () => console.log('Listening on https://0.0.0.0:' + HTTPS_PORT));
});
