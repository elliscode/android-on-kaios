// Login page for KaiOS 3.0.1 / Gecko 84: XHR only (no fetch), ES5-style syntax.
// The 8-digit code is printed in the server log each time this page loads (from home only).
(function () {
  'use strict';

  var input = document.getElementById('code');
  var status = document.getElementById('status');
  var busy = false;

  input.focus();

  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var code = input.value.replace(/\D/g, '');
    if (code.length !== 8) {
      status.textContent = 'Enter all 8 digits';
      return;
    }
    if (busy) return;
    busy = true;
    status.textContent = 'Checking...';
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/login', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'json';
    xhr.onloadend = function () {
      busy = false;
      if (xhr.status === 200 && xhr.response && xhr.response.ok) {
        status.textContent = 'OK';
        location.replace('/');
        return;
      }
      input.value = '';
      status.textContent = (xhr.response && xhr.response.error) || 'Login failed (' + xhr.status + ')';
    };
    xhr.send(JSON.stringify({ code: code }));
  });
})();
