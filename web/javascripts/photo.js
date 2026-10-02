// One photo (/admin/photo/#<key>), opened from the gallery's "Open": the picture, who
// uploaded it and when.
//
// The uploader's name comes as typed from the object's x-amz-meta-uploader header
// (percent-encoded by the API at upload), read with a HEAD request; uploads without a
// name show "Gast". The date is the object's Last-Modified: when the upload completed.

import { fileUrl, mountHeaderLinks } from './admin-files.js';

const NO_PREVIEW_EXT = /\.dng$/i;

const $ = (id) => document.getElementById(id);

mountHeaderLinks();

function fail(text) {
    $('mu-message').textContent = text;
    $('mu-message').hidden = false;
}

async function init() {
    let key = '';
    try {
        key = decodeURIComponent(window.location.hash.slice(1));
    } catch {
        // malformed escape: handled as an unknown key below
    }
    // Any listed key is fine: fileUrl() encodes it whole, and the gate and the bucket
    // policy decide what can be read.
    if (!key || key.length > 1024) {
        fail('Dieses Foto gibt es nicht.');
        return;
    }

    const url = fileUrl(key);
    let response;
    try {
        response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    } catch {
        fail('Keine Verbindung – lad die Seite bitte neu.');
        return;
    }
    if (response.redirected || response.status === 401) {
        // Session expired: the login page returns here, fragment included.
        window.location.assign(`/login/index.html?next=${encodeURIComponent(window.location.pathname)}${window.location.hash}`);
        return;
    }
    if (!response.ok) {
        fail('Dieses Foto gibt es nicht (mehr).');
        return;
    }

    let uploader = '';
    try {
        uploader = decodeURIComponent(response.headers.get('x-amz-meta-uploader') || '');
    } catch {
        // malformed metadata: fall back to the name in the key
    }
    const slug = key.split('_')[1] || '';
    const modified = new Date(response.headers.get('last-modified') || NaN);

    $('mu-photo-uploader').textContent = uploader || (slug === 'gast' ? 'Gast' : slug) || 'Unbekannt';
    $('mu-photo-date').textContent = Number.isNaN(modified.getTime())
        ? ''
        : modified.toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' });
    $('mu-photo-download').href = url;
    $('mu-photo-download').setAttribute('download', key);
    document.title = `${$('mu-photo-uploader').textContent} – ${document.title}`;

    const image = $('mu-photo-image');
    image.alt = `Foto von ${$('mu-photo-uploader').textContent}`;
    const showNone = () => { image.hidden = true; $('mu-photo-none').hidden = false; };
    image.addEventListener('error', showNone, { once: true });
    if (NO_PREVIEW_EXT.test(key)) showNone();
    else image.src = url;
    $('mu-photo').hidden = false;
}

init();
