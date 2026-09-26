// Thin wrappers around the `adb` CLI. All commands go through execFile with argument
// arrays, so nothing from the client is ever interpolated into a host shell.
const path = require('path');
const { execFile } = require('child_process');

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

// Runtime window settings that Android resets on every boot, so they're reapplied on each connect.
// The display is nearly square (240x276 shape), so Android letterboxes portrait-locked apps (e.g.
// McDonald's) into a narrow column. This makes letterboxed apps use the full display instead.
function configure() {
  return Promise.all([
    adb(['shell', 'cmd', 'window', 'set-letterbox-style',
      '--isDisplayAspectRatioEnabledForFixedOrientationLetterbox', 'true']).catch(() => {}),
    adb(['push', A11Y_JAR, A11Y_DEVICE_JAR]).catch(() => {}),
  ]);
}

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
const A11Y_JAR = path.join(__dirname, 'a11y.jar');
const A11Y_DEVICE_JAR = '/data/local/tmp/a11y.jar';

function a11yClick(x, y) {
  return withUiAutomation(async () => {
    const out = await adb(['shell', 'CLASSPATH=' + A11Y_DEVICE_JAR + ':/system/framework/uiautomator.jar',
      'app_process', '/system/bin', 'A11yClick', String(x), String(y)]);
    return JSON.parse(out.toString().trim().split('\n').pop());
  });
}

// Raw RGBA framebuffer. Android 10+ header is 16 bytes: width, height, format, colorspace.
async function screencapRaw() {
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

function keyevent(code) {
  return adb(['shell', 'input', 'keyevent', String(code)]);
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

module.exports = { connect, a11yClick, setupMockLocation, setMockLocation, screencapRaw, tap, swipe, keyevent, inputText, clearText, focusedFieldText, keyboardShown };
