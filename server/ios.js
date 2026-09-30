// iPhone backend: a real iPhone over USB, through WebDriverAgent (WDA, Appium's XCUITest runner)
// on the phone. scripts/ios/start-wda.sh runs it and forwards 127.0.0.1:8100 to it over USB; WDA
// itself listens only on the phone's loopback (see scripts/ios/build-wda.sh), not on Wi-Fi.
//
// Exports the same functions as adb.js (server/index.js picks one with DEVICE). Frames are the
// iPhone screenshot scaled to 960 px wide (4x the client's 240), at the phone's own aspect ratio;
// the client works out its pan stops (key 8) from the frame size. Tap and swipe coordinates arrive
// in those frame pixels and are converted to iOS points here.
const sharp = require('sharp');

const WDA = process.env.WDA_URL || 'http://127.0.0.1:8100';
const REQUEST_TIMEOUT_MS = 15000;
const FRAME_WIDTH = 960;
const KEYBOARD_CHECK_MS = 3000; // finding the keyboard walks the UI tree, so not every frame

let sessionId = null;
let screen = null; // { widthPt, heightPt, scale: frame px per point, contentHeight: frame px }
let notificationsOpen = false;

// --- WDA HTTP ------------------------------------------------------------------------------------

async function wda(method, path, body) {
  const res = await fetch(WDA + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('WDA ' + method + ' ' + path + ': ' + ((json.value && json.value.message) || res.status));
    err.wdaError = json.value && json.value.error;
    throw err;
  }
  return json.value;
}

async function ensureSession() {
  if (sessionId) return sessionId;
  const value = await wda('POST', '/session', { capabilities: { alwaysMatch: {} } });
  sessionId = value.sessionId;
  const size = await wda('GET', '/session/' + sessionId + '/window/size');
  screen = { widthPt: size.width, heightPt: size.height, scale: FRAME_WIDTH / size.width };
  screen.contentHeight = Math.round(size.height * screen.scale);
  return sessionId;
}

// A session command; recreates the session once if WDA restarted and forgot it.
async function command(method, path, body) {
  try {
    return await wda(method, '/session/' + (await ensureSession()) + path, body);
  } catch (err) {
    if (err.wdaError !== 'invalid session id') throw err;
    sessionId = null;
    return wda(method, '/session/' + (await ensureSession()) + path, body);
  }
}

// Frame pixels -> iOS points.
function toPoint(x, y) {
  return {
    x: Math.min(x, FRAME_WIDTH - 1) / screen.scale,
    y: Math.min(y, screen.contentHeight - 1) / screen.scale,
  };
}

// A drag without a long press first (a long press would start drag-and-drop or jiggle mode).
async function drag(from, to, velocity, holdSeconds) {
  await command('POST', '/wda/pressAndDragWithVelocity', {
    fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
    pressDuration: 0.05, holdDuration: holdSeconds, velocity,
  });
}

// --- Device interface (same as adb.js) -----------------------------------------------------------

async function isConnected() {
  try {
    const status = await wda('GET', '/status');
    return !!(status && status.ready);
  } catch (err) {
    return false;
  }
}

// Doesn't wait for WDA: the server starts anyway, and capture reconnects when WDA comes up.
async function connect() {
  sessionId = null;
  if (await isConnected()) {
    await ensureSession().catch((err) => console.error('WDA session failed:', err.message));
  } else {
    console.error('WebDriverAgent not reachable at ' + WDA + ' (run scripts/ios/start-wda.sh)');
  }
}

// Raw RGBA frame: the screenshot scaled to 960 wide (e.g. 960x2081 for an iPhone 14 Pro).
async function screencapRaw() {
  await ensureSession();
  const png = Buffer.from(await wda('GET', '/screenshot'), 'base64');
  const pixels = await sharp(png)
    .resize({ width: FRAME_WIDTH, height: screen.contentHeight, fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { width: FRAME_WIDTH, height: screen.contentHeight, pixels };
}

async function tap(x, y) {
  await ensureSession();
  const p = toPoint(x, y);
  await command('POST', '/wda/tap', { x: p.x, y: p.y });
}

// Vertical: a steady drag that stops at the end (the hold stops any fling), like adb's slow swipe,
// so a scroll moves by the swipe distance. Sideways: no hold, so pages (home screen, carousels)
// snap over even when the swipe is shortened at the screen edge.
async function swipe(x1, y1, x2, y2, ms) {
  await ensureSession();
  const from = toPoint(x1, y1);
  const to = toPoint(x2, y2);
  const velocity = Math.hypot(to.x - from.x, to.y - from.y) / (ms / 1000);
  const sideways = Math.abs(to.x - from.x) > Math.abs(to.y - from.y);
  await drag(from, to, velocity, sideways ? 0 : 0.3);
}

async function inputText(text) {
  await command('POST', '/wda/keys', { value: [text] });
}

function pressEnter() {
  return inputText('\n');
}

async function activeElement() {
  try {
    const el = await command('GET', '/element/active');
    return el && (el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf']);
  } catch (err) {
    return null; // nothing focused
  }
}

async function clearText() {
  const id = await activeElement();
  if (id) await command('POST', '/element/' + id + '/clear');
}

async function focusedFieldText() {
  const id = await activeElement();
  if (!id) return '';
  const value = await command('GET', '/element/' + id + '/attribute/value');
  return typeof value === 'string' ? value : '';
}

let keyboard = { shown: false, checkedAt: 0 };

async function keyboardShown() {
  if (Date.now() - keyboard.checkedAt < KEYBOARD_CHECK_MS) return keyboard.shown;
  const found = await command('POST', '/elements', { using: 'class name', value: 'XCUIElementTypeKeyboard' });
  keyboard = { shown: Array.isArray(found) && found.length > 0, checkedAt: Date.now() };
  return keyboard.shown;
}

// Notification Center: pull down from the top-left edge; close by pushing it back up from the
// bottom edge. iOS has no query for whether it's open, so this tracks it (Home resets it).
async function toggleNotifications() {
  await ensureSession();
  const { widthPt: w, heightPt: h } = screen;
  if (notificationsOpen) await drag({ x: w / 2, y: h - 2 }, { x: w / 2, y: h * 0.3 }, 1500, 0);
  else await drag({ x: w * 0.2, y: 2 }, { x: w * 0.2, y: h * 0.6 }, 1500, 0);
  notificationsOpen = !notificationsOpen;
  return notificationsOpen;
}

// Call = home, 6 = app switcher (swipe up from the bottom and hold). (* and # are swipes from the
// cursor, see /scroll; iOS's Back gesture is * with the cursor at the left edge.)
async function key(name) {
  if (name === 'home') {
    notificationsOpen = false;
    return wda('POST', '/wda/homescreen');
  }
  await ensureSession();
  const { widthPt: w, heightPt: h } = screen;
  if (name === 'switcher') return drag({ x: w / 2, y: h - 2 }, { x: w / 2, y: h * 0.6 }, 600, 1);
  throw new Error('unknown key ' + name);
}

// XCTest location simulation (iOS 16.4+). Apps can see it's simulated (iOS 15+ API).
function setLocation(lat, lng) {
  return wda('POST', '/wda/simulatedLocation', { latitude: lat, longitude: lng });
}

// Back to the iPhone's real GPS (used until the flip phone shares a location with key 7).
function clearLocation() {
  return wda('DELETE', '/wda/simulatedLocation');
}

function unsupported() {
  return Promise.reject(new Error('not supported on iPhone'));
}

module.exports = {
  title: 'iPhone',
  favicon: 'favicon-iphone.png', // in public/ (Apple logo from Simple Icons, CC0)
  capabilities: { a11yFallback: false, photo: false, gps: true },
  connect, isConnected, a11yClick: unsupported, pushMedia: unsupported, toggleNotifications,
  setLocation, clearLocation, screencapRaw, tap, swipe, pressEnter, key, inputText, clearText, focusedFieldText,
  keyboardShown,
};
