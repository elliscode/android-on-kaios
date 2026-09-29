// KaiOS 3.0.1 / Gecko 84 client. XHR only (no fetch), ES5-style syntax, no build step.
(function () {
  'use strict';

  // Android runs at an integer multiple of the 240x276 usable area (see docker-compose.yml).
  // The frame is shown 240px wide; if it's taller than 276px, a 276px-tall window of it is visible
  // and key 8 pans it in half-screen steps (e.g. 960x2208 -> 240x552 -> top, middle, bottom).
  // Android px = (phone px + pan offset) * scale, where scale = frame width / 240.
  var VIEW_WIDTH = 240;
  var VIEW_HEIGHT = 276;
  var POLL_MS = 1000;

  var screen = document.getElementById('screen');
  var kb = document.getElementById('kb');
  var msg = document.getElementById('msg');
  var photo = document.getElementById('photo');
  var msgTimer = null;

  var lastHash = '';
  var lastUrl = null;
  var androidKeyboard = false; // Android reports an input field has its keyboard up
  var dismissed = false;       // user closed our text box; stays closed until the next tap
  var pan = 0;                 // index into panOffsets(): which window of the frame is visible
  var panDir = 1;              // 1 = next press pans down, -1 = up (bounces at top and bottom)
  var original = null;         // Android field's text when the box opened (null = not loaded yet)
  var openCount = 0;           // identifies the current opening, to ignore stale /field replies
  var HINT = 'Enter=send  Back=close';

  // Session CSRF token, embedded in the page by the server. Sent with every request.
  var csrfMeta = document.querySelector('meta[name="csrf"]');
  var CSRF = csrfMeta ? csrfMeta.getAttribute('content') : '';

  // Opens an XHR with the CSRF header. A 401 means the session is gone: reload to the login page.
  function request(method, path) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.setRequestHeader('X-CSRF-Token', CSRF);
    xhr.addEventListener('load', function () {
      if (xhr.status === 401) location.reload();
    });
    return xhr;
  }

  function post(path, body) {
    var xhr = request('POST', path);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(body));
  }

  function poll() {
    var xhr = request('GET', '/frame?h=' + encodeURIComponent(lastHash));
    xhr.responseType = 'blob';
    xhr.timeout = 10000;
    xhr.onload = function () {
      setKeyboard(xhr.getResponseHeader('X-Keyboard') === '1');
      if (xhr.status === 200) {
        lastHash = xhr.getResponseHeader('X-Hash') || '';
        var url = URL.createObjectURL(xhr.response);
        screen.src = url;
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = url;
      }
      setTimeout(poll, POLL_MS);
    };
    xhr.onerror = xhr.ontimeout = function () {
      setTimeout(poll, POLL_MS);
    };
    xhr.send();
  }

  function setKeyboard(shown) {
    if (shown && !androidKeyboard) dismissed = false;
    androidKeyboard = shown;
    if (shown && !dismissed) {
      openTextBox();
    } else {
      closeTextBox();
    }
  }

  function textBoxOpen() {
    return kb.style.display === 'block';
  }

  function openTextBox() {
    if (textBoxOpen()) return;
    kb.value = '';
    original = null;
    kb.placeholder = 'Loading...';
    kb.style.display = 'block';
    kb.focus();
    loadFieldText(++openCount);
  }

  // Pre-fill with the Android field's current text, all selected, so typing replaces it and
  // moving the cursor lets you edit it. Skipped if the user already started typing.
  function loadFieldText(id) {
    var xhr = request('GET', '/field');
    xhr.responseType = 'json';
    xhr.timeout = 15000;
    xhr.onloadend = function () {
      if (id !== openCount || !textBoxOpen()) return;
      kb.placeholder = HINT;
      var text = xhr.status === 200 && xhr.response && typeof xhr.response.text === 'string' ? xhr.response.text : '';
      if (kb.value) return; // user typed first; their text will replace the field
      original = text;
      kb.value = text;
      kb.select();
    };
    xhr.send();
  }

  function closeTextBox() {
    if (!textBoxOpen()) return;
    kb.style.display = 'none';
    kb.value = '';
    kb.blur();
  }

  function dismissTextBox() {
    dismissed = true;
    closeTextBox();
  }

  screen.addEventListener('click', function (e) {
    // Clicking the screen while the text box is open just closes it (no tap sent).
    if (textBoxOpen()) {
      dismissTextBox();
      return;
    }
    dismissed = false;
    if (!screen.naturalWidth) return; // no frame yet
    var scale = screen.naturalWidth / VIEW_WIDTH;
    var y = e.clientY + panOffsets()[pan];
    post('/tap', { x: Math.round(e.clientX * scale), y: Math.round(y * scale) });
  });

  kb.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Changed -> replace the Android field's text with ours (empty clears it).
      // Unchanged -> press Enter on Android (e.g. submit a search).
      if (kb.value !== original) {
        post('/text', { text: kb.value, replace: true });
      } else {
        post('/text', { text: '', enter: true });
      }
      dismissTextBox();
    } else if ((e.key === 'Backspace' && !kb.value) ||
               e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
      // Close without sending, instead of letting the browser navigate back.
      e.preventDefault();
      dismissTextBox();
    }
  });

  function showMessage(text) {
    msg.textContent = text;
    msg.style.display = 'block';
    clearTimeout(msgTimer);
    msgTimer = setTimeout(function () { msg.style.display = 'none'; }, 4000);
  }

  // Key 7: send the phone's own location to Android (replacing the default).
  function shareLocation() {
    if (!navigator.geolocation) {
      showMessage('No location support in this browser');
      return;
    }
    if (window.isSecureContext === false) {
      showMessage('Location needs the https:// address');
      return;
    }
    showMessage('Getting location...');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var c = pos.coords;
      var xhr = request('POST', '/location');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onloadend = function () {
        showMessage(xhr.status === 204
          ? 'Location set: ' + c.latitude.toFixed(4) + ', ' + c.longitude.toFixed(4)
          : 'Server failed to set location');
      };
      xhr.send(JSON.stringify({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy }));
    }, function (err) {
      showMessage('Location failed: ' + (err.message || 'error ' + err.code));
    }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 });
  }

  // Key 9: take a photo with the phone's camera (or pick one) and put it in Android's gallery.
  photo.addEventListener('change', function () {
    var file = photo.files && photo.files[0];
    if (!file) return;
    showMessage('Sending photo...');
    var xhr = request('POST', '/photo');
    xhr.setRequestHeader('Content-Type', file.type || 'image/jpeg');
    xhr.timeout = 120000;
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) showMessage('Sending photo... ' + Math.round(e.loaded * 100 / e.total) + '%');
    };
    xhr.onloadend = function () {
      showMessage(xhr.status === 200 ? 'Photo added to Android gallery' : 'Photo failed (' + xhr.status + ')');
    };
    xhr.send(file);
    photo.value = ''; // allow choosing another photo later
  });

  // Top offsets (px) of the visible window: every half screen from the top down to the bottom.
  // For 240x552 that's [0, 138, 276] = top, middle, bottom.
  function panOffsets() {
    var max = 0;
    if (screen.naturalWidth) {
      max = Math.max(0, Math.round(screen.naturalHeight * VIEW_WIDTH / screen.naturalWidth) - VIEW_HEIGHT);
    }
    var offsets = [];
    for (var y = 0; y < max; y += VIEW_HEIGHT / 2) offsets.push(y);
    offsets.push(max);
    return offsets;
  }

  function showPan(n) {
    pan = n;
    screen.style.marginTop = (-panOffsets()[pan]) + 'px';
  }

  // Top -> middle -> bottom -> middle -> top -> ...
  function panNext() {
    var last = panOffsets().length - 1;
    if (last === 0) return;
    if (pan + panDir < 0 || pan + panDir > last) panDir = -panDir;
    showPan(pan + panDir);
  }

  // Keys (ignored while typing in the text box):
  //   2 = scroll Android up, 0 = scroll Android down, 8 = pan top -> middle -> bottom -> middle -> top,
  //   7 = share the phone's location with Android, 9 = take a photo into Android's gallery,
  //   4 = open/close Android's notification shade. (1 is left alone: it's the KaiOS browser's zoom.)
  var SCROLL_KEYS = { '2': 'up', '0': 'down' };

  document.addEventListener('keydown', function (e) {
    if (textBoxOpen()) return;
    if (e.key === '7') {
      e.preventDefault();
      shareLocation();
      return;
    }
    if (e.key === '4') {
      e.preventDefault();
      post('/notifications', {});
      return;
    }
    if (e.key === '9') {
      e.preventDefault();
      photo.click();
      return;
    }
    if (e.key === '8') {
      e.preventDefault();
      panNext();
      return;
    }
    var dir = SCROLL_KEYS[e.key];
    if (!dir) return;
    e.preventDefault();
    post('/scroll', { dir: dir });
  });

  // Keep the pan valid if the frame size changes (e.g. Android resolution changed).
  screen.addEventListener('load', function () {
    if (pan >= panOffsets().length) {
      panDir = 1;
      showPan(0);
    }
  });

  poll();
})();
