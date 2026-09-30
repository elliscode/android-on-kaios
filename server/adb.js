// Thin wrappers around the `adb` CLI. All commands go through execFile with argument
// arrays, so nothing from the client is ever interpolated into a host shell.
const path = require('path');
const { execFile, spawn } = require('child_process');

const SERIAL = process.env.ADB_SERIAL || 'localhost:5555';

function adb(args, opts) {
  return new Promise((resolve, reject) => {
    execFile('adb', ['-s', SERIAL].concat(args),
      Object.assign({ encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, opts),
      (err, stdout, stderr) => {
        if (err) {
          err.message += ' ' + (stderr ? stderr.toString() : '');
          return reject(err);
        }
        resolve(stdout);
      });
  });
}

function connect() {
  return new Promise((resolve) => {
    execFile('adb', ['connect', SERIAL], () => resolve());
  }).then(configure);
}

function isConnected() {
  return new Promise((resolve) => {
    execFile('adb', ['-s', SERIAL, 'get-state'], (err, stdout) => resolve(!err && stdout.trim() === 'device'));
  });
}

// Runtime window settings that Android resets on every boot, so they're reapplied on each connect.
// The display is nearly square (240x276 shape), so Android letterboxes portrait-locked apps (e.g.
// McDonald's) into a narrow column. This makes letterboxed apps use the full display instead.
function configure() {
  return Promise.all([
    adb(['shell', 'cmd', 'window', 'set-letterbox-style',
      '--isDisplayAspectRatioEnabledForFixedOrientationLetterbox', 'true']).catch(() => {}),
    adb(['push', HELPERS_JAR, HELPERS_DEVICE_JAR]).catch(() => {}),
  ]);
}

// Java helpers (helper/*.java, built by scripts/build-helper.sh), pushed on every connect.
const HELPERS_JAR = path.join(__dirname, 'helpers.jar');
const HELPERS_DEVICE_JAR = '/data/local/tmp/helpers.jar';

// Only one UiAutomation (accessibility) connection can exist at a time, so the UI dump and the
// accessibility click run one after another.
let uiAutomationQueue = Promise.resolve();
function withUiAutomation(fn) {
  const run = uiAutomationQueue.then(fn, fn);
  uiAutomationQueue = run.catch(() => {});
  return run;
}

// Accessibility click (helper/A11yClick.java): clicks the element at a point the way a screen
// reader does. Used when an app ignores injected touches (e.g. WhatsApp's registration screen).
function a11yClick(x, y) {
  return withUiAutomation(async () => {
    const out = await adb(['shell', 'CLASSPATH=' + HELPERS_DEVICE_JAR + ':/system/framework/uiautomator.jar',
      'app_process', '/system/bin', 'A11yClick', String(x), String(y)]);
    return JSON.parse(out.toString().trim().split('\n').pop());
  });
}

// Screen capture helper (helper/ScreenCap.java), kept running as root. Unlike screencap it also
// captures FLAG_SECURE windows (e.g. Chick-fil-A's QR code), which screencap refuses to capture.
// Each newline on its stdin returns one frame in screencap's raw format. Needs `su` (redroid is a
// userdebug build); if it fails, capture falls back to screencap and retries the helper later.
const SECURE_CAPTURE_TIMEOUT_MS = 5000;
const SECURE_CAPTURE_RETRY_MS = 30000;

let helper = null; // { proc, chunks, length, pending }
let secureCaptureRetryAt = 0;

function startHelper() {
  const proc = spawn('adb', ['-s', SERIAL, 'shell', '-T',
    "su 0 sh -c 'CLASSPATH=" + HELPERS_DEVICE_JAR + " app_process /system/bin ScreenCap'"]);
  const h = { proc, chunks: [], length: 0, pending: null };
  proc.stdout.on('data', (chunk) => {
    h.chunks.push(chunk);
    h.length += chunk.length;
    readFrame(h);
  });
  proc.stderr.on('data', (d) => console.error('screen helper:', d.toString().trim()));
  proc.stdin.on('error', () => {}); // the exit handler reports it
  const exited = (err) => {
    if (helper === h) helper = null;
    settle(h, new Error('screen helper exited' + (err ? ': ' + err.message : '')));
  };
  proc.on('error', exited); // adb couldn't be started
  proc.on('exit', () => exited());
  return h;
}

// Resolves the pending request once a whole frame (header plus pixels) has arrived.
function readFrame(h) {
  if (h.length < 16) return;
  if (h.chunks.length > 1) h.chunks = [Buffer.concat(h.chunks)];
  const buf = h.chunks[0];
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const size = 16 + width * height * 4;
  if (h.length < size) return;
  h.chunks = h.length > size ? [buf.subarray(size)] : [];
  h.length -= size;
  if (!width || !height) return settle(h, new Error('screen helper capture failed'));
  settle(h, null, { width, height, pixels: buf.subarray(16, size) });
}

function settle(h, err, shot) {
  const p = h.pending;
  if (!p) return;
  h.pending = null;
  clearTimeout(p.timer);
  if (err) p.reject(err);
  else p.resolve(shot);
}

function secureCapture() {
  if (!helper) helper = startHelper();
  const h = helper;
  return new Promise((resolve, reject) => {
    if (h.pending) return reject(new Error('screen helper busy'));
    const timer = setTimeout(() => {
      settle(h, new Error('screen helper timed out'));
      h.proc.kill(); // a late frame would be taken as the reply to the next request
    }, SECURE_CAPTURE_TIMEOUT_MS);
    h.pending = { resolve, reject, timer };
    h.proc.stdin.write('\n');
  });
}

// Raw RGBA framebuffer: { width, height, pixels }.
async function screencapRaw() {
  if (Date.now() >= secureCaptureRetryAt) {
    try {
      return await secureCapture();
    } catch (err) {
      console.error(err.message + '; using screencap (secure windows stay hidden) for now');
      secureCaptureRetryAt = Date.now() + SECURE_CAPTURE_RETRY_MS;
      if (helper) helper.proc.kill();
    }
  }
  // Android 10+ header is 16 bytes: width, height, format, colorspace.
  const buf = await adb(['exec-out', 'screencap']);
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const headerLen = buf.length - width * height * 4;
  if (headerLen < 12 || headerLen > 16) throw new Error('Unexpected screencap size ' + buf.length);
  return { width, height, pixels: buf.subarray(headerLen) };
}

function tap(x, y) {
  return adb(['shell', 'input', 'tap', String(x), String(y)]);
}

function swipe(x1, y1, x2, y2, ms) {
  return adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]);
}

// Copies a local file into Android's shared storage and indexes it, so it shows up in the gallery
// and in apps' photo pickers.
async function pushMedia(localPath, devicePath) {
  await adb(['push', localPath, devicePath], { timeout: 60000 });
  // Scan now so the gallery gets its size and date immediately (not just the file name).
  await adb(['shell', 'content', 'call', '--uri', 'content://media', '--method', 'scan_file',
    '--arg', devicePath.replace(/^\/sdcard\//, '/storage/emulated/0/')]);
}

// Opens Android's notification shade, or closes it if it's already open.
async function toggleNotifications() {
  const out = (await adb(['shell', 'dumpsys', 'window', 'displays'])).toString();
  const open = /mCurrentFocus=Window\{[^}]*NotificationShade/.test(out);
  await adb(['shell', 'cmd', 'statusbar', open ? 'collapse' : 'expand-notifications']);
  return !open;
}

function keyevent(code) {
  return adb(['shell', 'input', 'keyevent', String(code)]);
}

function pressEnter() {
  return keyevent(66); // KEYCODE_ENTER
}

// Navigation keys from the phone (Call, 6). Android's own Back button is on screen (3-button
// navigation); * and # are swipes from the cursor (see /scroll).
const KEYCODES = { home: 3, switcher: 187 };

function key(name) {
  return keyevent(KEYCODES[name]);
}

// Sends Unicode text through the ADBKeyBoard IME. Base64 keeps the payload to [A-Za-z0-9+/=],
// which is safe for the device-side shell that `adb shell` runs.
function inputText(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64]);
}

// Mock location: the container has no GPS, and Google's network location has no Wi-Fi/cell data,
// so apps get no location at all. Test providers replace "gps" and "network" with a fixed point.
// Android forgets them on reboot, so setupMockLocation() runs again after each (re)connect.
const MOCK_PROVIDERS = ['gps', 'network'];

async function setupMockLocation() {
  await adb(['shell', 'appops', 'set', 'com.android.shell', 'android:mock_location', 'allow']);
  for (const p of MOCK_PROVIDERS) {
    await adb(['shell', 'cmd', 'location', 'providers', 'add-test-provider', p,
      '--supportsAltitude', '--supportsSpeed', '--supportsBearing']);
    await adb(['shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', p, 'true']);
  }
}

async function setMockLocation(lat, lng, accuracy) {
  for (const p of MOCK_PROVIDERS) {
    await adb(['shell', 'cmd', 'location', 'providers', 'set-test-provider-location', p,
      '--location', lat + ',' + lng, '--accuracy', String(accuracy)]);
  }
}

// Test providers mark every location as mock, which apps can see. The GNSS HAL
// (helper/gnss/service.cpp, in the image) reports this property as real GPS fixes instead. Test
// providers would override its "gps" provider, so they're removed when it's running.
const GNSS_PROPERTY = 'vendor.gnss.location';

async function hasGnss() {
  const out = await adb(['shell', 'getprop', 'init.svc.vendor.gnss-kaios']);
  return out.toString().trim() === 'running';
}

async function removeMockLocation() {
  for (const p of MOCK_PROVIDERS) {
    await adb(['shell', 'cmd', 'location', 'providers', 'remove-test-provider', p]).catch(() => {});
  }
}

function setGnssLocation(lat, lng, accuracy) {
  return adb(['shell', 'setprop', GNSS_PROPERTY, lat + ',' + lng + ',' + accuracy]);
}

// Clears the focused field through ADBKeyBoard (deletes all text around the cursor).
function clearText() {
  return adb(['shell', 'am', 'broadcast', '-a', 'ADB_CLEAR_TEXT']);
}

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

// Text of the focused input field, read from a UI hierarchy dump (~2 s).
// Caveat: for an empty field Android reports its hint (placeholder) as the text.
async function focusedFieldText() {
  const xml = (await withUiAutomation(() =>
    adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 10000 }))).toString();
  const nodes = xml.match(/<node [^>]*>/g) || [];
  const attr = (node, name) => {
    const m = node.match(new RegExp(' ' + name + '="([^"]*)"'));
    return m ? decodeXml(m[1]) : '';
  };
  const focused = nodes.filter((n) => attr(n, 'focused') === 'true');
  const field = focused.find((n) => /EditText|AutoCompleteTextView/.test(attr(n, 'class'))) || focused[0];
  if (!field || attr(field, 'password') === 'true') return '';
  return attr(field, 'text');
}

async function keyboardShown() {
  const out = (await adb(['shell', 'dumpsys', 'input_method'])).toString();
  return /mInputShown=true/.test(out);
}

// Whether Android has the GNSS HAL; checked again after each (re)connect.
let gnss = null;

// Sets the location apps see: through the GNSS HAL if the image has it, else test providers.
async function setLocation(lat, lng, accuracy) {
  if (gnss === null) {
    gnss = await hasGnss();
    if (gnss) await removeMockLocation();
  }
  if (gnss) return setGnssLocation(lat, lng, accuracy);
  try {
    await setMockLocation(lat, lng, accuracy);
  } catch (err) {
    // Providers are gone after an Android reboot: set them up again, then retry.
    await setupMockLocation();
    await setMockLocation(lat, lng, accuracy);
  }
}

// The same interface as ios.js; server/index.js picks one with DEVICE.
module.exports = {
  title: 'Android',
  favicon: 'favicon.png', // in public/
  capabilities: { a11yFallback: true, photo: true, gps: false },
  connect: () => { gnss = null; return connect(); },
  clearLocation: () => Promise.resolve(), // never called: Android always has a location set
  isConnected, a11yClick, pushMedia, toggleNotifications, setLocation, screencapRaw, tap, swipe,
  pressEnter, key, inputText, clearText, focusedFieldText, keyboardShown,
};
