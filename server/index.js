const path = require('path');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const adb = require('./adb');

const PORT = Number(process.env.PORT) || 8080;
const CAPTURE_MS = 1000;
const IDLE_AFTER_MS = 5000; // stop capturing when no client has polled for this long
const JPEG_QUALITY = 70;

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
    await adb.connect();
  }
}

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

app.post('/text', async (req, res) => {
  const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  const enter = !!(req.body && req.body.enter);
  try {
    if (text) await adb.inputText(text);
    if (enter) await adb.keyevent(66); // KEYCODE_ENTER
    recaptureSoon();
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

adb.connect().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log('Listening on http://0.0.0.0:' + PORT));
});
