// Manifest callback page glue. Exchanges GitHub's one-time code only after an
// explicit click, shows the credentials once and keeps nothing.

import { convertManifest, forgetLaunch, pemFileName, readCallback } from './lib/callback.js';

const $ = (sel) => document.querySelector(sel);
const result = readCallback(location.search, sessionStorage);
// Drop the code from the address bar and history straight away.
history.replaceState(null, '', location.pathname);

function show(id) {
  for (const el of document.querySelectorAll('[data-step]')) el.hidden = el.id !== id;
}

function fail(message) {
  $('#error-message').textContent = message;
  show('step-error');
}

function clearSecrets() {
  for (const el of document.querySelectorAll('[data-secret]')) {
    if ('value' in el) el.value = '';
    else el.textContent = '';
  }
}

if (!result.ok) {
  fail(result.error);
} else {
  $('#host').textContent = result.host;
  show('step-confirm');
  $('#convert').addEventListener('click', async () => {
    $('#convert').disabled = true;
    forgetLaunch(sessionStorage);
    const converted = await convertManifest(fetch.bind(window), result.host, result.code);
    if (!converted.ok) {
      fail(converted.error);
      return;
    }
    const { app } = converted;
    $('#app-name').textContent = app.name;
    if (/^https:\/\//.test(app.htmlUrl ?? '')) $('#app-link').href = app.htmlUrl;
    $('#app-id').value = String(app.id);
    $('#client-id').value = app.clientId;
    $('#client-secret').value = app.clientSecret;
    $('#webhook-secret').value = app.webhookSecret ?? '(webhook inactive)';
    $('#pem').value = app.pem;
    const blobUrl = URL.createObjectURL(new Blob([app.pem], { type: 'application/x-pem-file' }));
    const download = $('#download');
    download.href = blobUrl;
    download.download = pemFileName(app);
    show('step-done');
    window.addEventListener('pagehide', () => {
      clearSecrets();
      URL.revokeObjectURL(blobUrl);
    });
  });
}

$('#clear').addEventListener('click', () => {
  clearSecrets();
  show('step-cleared');
});
