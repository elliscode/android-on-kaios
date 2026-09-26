// Thin wrappers around the `adb` CLI. All commands go through execFile with argument
// arrays, so nothing from the client is ever interpolated into a host shell.
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

function keyevent(code) {
  return adb(['shell', 'input', 'keyevent', String(code)]);
}

// Sends Unicode text through the ADBKeyBoard IME. Base64 keeps the payload to [A-Za-z0-9+/=],
// which is safe for the device-side shell that `adb shell` runs.
function inputText(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64]);
}

async function keyboardShown() {
  const out = (await adb(['shell', 'dumpsys', 'input_method'])).toString();
  return /mInputShown=true/.test(out);
}

module.exports = { connect, screencapRaw, tap, keyevent, inputText, keyboardShown };
