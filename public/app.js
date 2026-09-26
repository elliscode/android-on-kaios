// KaiOS 3.0.1 / Gecko 84 client. XHR only (no fetch), ES5-style syntax, no build step.
(function () {
  'use strict';

  // Android runs at an integer multiple of the 240x276 usable area (see docker-compose.yml).
  // Phone px * scale = Android px, where scale comes from the received frame's width.
  var VIEW_WIDTH = 240;
  var POLL_MS = 1000;

  var screen = document.getElementById('screen');
  var kb = document.getElementById('kb');

  var lastHash = '';
  var lastUrl = null;
  var androidKeyboard = false; // Android reports an input field has its keyboard up
  var dismissed = false;       // user closed our text box; stays closed until the next tap

  function post(path, body) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(body));
  }

  function poll() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/frame?h=' + encodeURIComponent(lastHash), true);
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
    kb.style.display = 'block';
    kb.focus();
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
    post('/tap', { x: Math.round(e.clientX * scale), y: Math.round(e.clientY * scale) });
  });

  kb.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Text -> type it. Empty -> press Enter on Android (e.g. submit a search).
      if (kb.value) {
        post('/text', { text: kb.value });
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

  poll();
})();
