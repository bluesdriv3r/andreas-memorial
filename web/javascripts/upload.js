// Guest upload flow — resumable S3 multipart uploads.
//
// 1. GET /api/config for the limits and whether uploads are still open.
// 2. Picking files starts the upload: POST /api/upload creates one multipart upload
//    per file and returns a presigned PUT URL for each part (8 MiB each).
// 3. Parts go straight to S3, one file's parts in sequence, two files at a time.
//    A failed part is retried with backoff; an expired URL is refreshed through
//    POST /api/upload/resume, which also reports the parts S3 already holds.
// 4. POST /api/upload/complete assembles the file once every part is stored.
//
// Resuming: every started upload is remembered in localStorage by file fingerprint
// (name, size, modification time). "Nochmal versuchen" — or picking
// the same file again after a reload — continues from the last stored part instead
// of starting over. S3 discards unfinished uploads after a day.

const CONCURRENCY = 2;
const PART_ATTEMPTS = 4;           // per part, waits 1 s, 2 s, 4 s in between
const REFRESH_ROUNDS = 3;          // resume calls per file before giving up
const STORE_KEY = 'memorial-upload:v1';
const STORE_TTL_MS = 20 * 3600 * 1000;   // below the bucket's 1-day cleanup

// Mirrors the API's extension list (lambda/index.mjs) for browsers that report no type.
const PHOTO_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?|dng)$/i;
const VIDEO_EXT = /\.(mov|mp4|m4v|3gp|webm|avi)$/i;

const $ = (id) => document.getElementById(id);
const input = $('mu-files');
const pick = $('mu-pick');
const retry = $('mu-retry');
const nameField = $('mu-uploader');
const limits = $('mu-limits');
const message = $('mu-message');
const list = $('mu-list');

let config = null;
let items = [];
let busy = false;
let wakeLock = null;

// --- Formatting and messages -----------------------------------------------------

const mb = (bytes) =>
    `${(bytes / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;

// "1 Datei ist" / "3 Dateien sind": count, noun and verb agree.
const files = (n, one = '', many = '') => `${n} ${n === 1 ? `Datei${one}` : `Dateien${many}`}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showMessage(kind, text) {
    message.dataset.kind = kind;
    message.textContent = text;
    message.hidden = false;
}

function hideMessage() {
    message.hidden = true;
}

// --- Remembered uploads (localStorage; the page works without it) ---------------

const fingerprint = (file) => `${file.name}|${file.size}|${file.lastModified}`;

function loadStore() {
    try {
        const store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        const now = Date.now();
        return Object.fromEntries(Object.entries(store).filter(([, t]) => now - t.startedAt < STORE_TTL_MS));
    } catch {
        return {};
    }
}

function saveStore(store) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
        // Private mode or storage full: resuming within this page view still works.
    }
}

function remember(item) {
    const store = loadStore();
    store[fingerprint(item.file)] = { ...item.target, startedAt: Date.now() };
    saveStore(store);
}

function forget(item) {
    const store = loadStore();
    delete store[fingerprint(item.file)];
    saveStore(store);
}

// --- Controls --------------------------------------------------------------------

function setPickerEnabled(enabled) {
    input.disabled = !enabled;
    pick.classList.toggle('is-disabled', !enabled);
    pick.setAttribute('aria-disabled', String(!enabled));
}

async function setBusy(value) {
    busy = value;
    setPickerEnabled(!value && config?.open);
    retry.disabled = value;
    nameField.disabled = value;

    // A phone that locks its screen suspends the page and the upload with it.
    try {
        if (value && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
        if (!value && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch {
        // Not supported or refused: nothing to do.
    }
}

// Leaving the page mid-upload would pause the remaining files.
window.addEventListener('beforeunload', (event) => {
    if (busy) event.preventDefault();
});

// --- File list -------------------------------------------------------------------

function kindOf(file) {
    if (PHOTO_EXT.test(file.name) || (file.type.startsWith('image/') && !VIDEO_EXT.test(file.name))) return 'photo';
    if (VIDEO_EXT.test(file.name) || file.type.startsWith('video/')) return 'video';
    return null;
}

function makeItem(file) {
    const item = { file, status: 'pending', error: '', target: null, parts: [], done: new Set(), stored: 0, inflight: 0 };
    const kind = kindOf(file);
    const max = kind === 'video' ? config.maxVideoBytes : config.maxPhotoBytes;

    if (!kind) {
        item.status = 'rejected';
        item.error = 'kein Foto oder Video';
    } else if (file.size === 0) {
        item.status = 'rejected';
        item.error = 'leere Datei';
    } else if (file.size > max) {
        item.status = 'rejected';
        item.error = `zu groß (${mb(file.size)}, max. ${mb(max)})`;
    }

    item.el = document.createElement('li');
    item.el.innerHTML = '<span class="mu-file"></span><progress max="100" value="0" hidden></progress><span class="mu-status"></span>';
    item.el.querySelector('.mu-file').textContent = file.name;
    list.append(item.el);
    render(item);
    return item;
}

const percent = (item) => Math.floor(((item.stored + item.inflight) / item.file.size) * 100);

function render(item) {
    const bar = item.el.querySelector('progress');
    const status = item.el.querySelector('.mu-status');
    item.el.dataset.status = item.status;
    bar.hidden = item.status !== 'uploading';
    bar.value = percent(item);

    const saved = item.stored > 0 ? ` (${percent(item)} % gesichert)` : '';
    const text = {
        pending: 'Wartet …',
        uploading: `Wird hochgeladen … ${percent(item)} %`,
        done: 'Hochgeladen ✓',
        failed: `Fehlgeschlagen – ${item.error}${saved}`,
        rejected: `Übersprungen – ${item.error}`,
    }[item.status];
    status.textContent = `${mb(item.file.size)} · ${text}`;
}

// --- API -------------------------------------------------------------------------

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function api(path, payload) {
    const body = JSON.stringify(payload);
    let response;
    try {
        response = await fetch(path, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                // CloudFront's origin access control needs the body hash for a POST
                // to the Lambda function URL; Lambda rejects unsigned payloads.
                'x-amz-content-sha256': await sha256Hex(body),
            },
            body,
        });
    } catch {
        throw new ApiError(0, 'keine Verbindung');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error || `Serverfehler ${response.status}`);
    return data;
}

// Applies a /resume answer: which parts S3 has, and fresh URLs for the rest.
function applyResume(item, data) {
    item.done = new Set(data.done);
    item.parts = data.parts;
    const partSize = data.partSize;
    item.stored = data.done.reduce((sum, n) => sum + Math.min(partSize, item.file.size - (n - 1) * partSize), 0);
}

// Gives every item in the batch a target: resumed where one is known, fresh otherwise.
async function prepare(batch) {
    const store = loadStore();
    const fresh = [];

    for (const item of batch) {
        const known = item.target || store[fingerprint(item.file)];
        if (!known) {
            fresh.push(item);
            continue;
        }
        try {
            const data = await api('/api/upload/resume', { key: known.key, uploadId: known.uploadId, size: item.file.size });
            item.target = { key: data.key, uploadId: data.uploadId, size: data.size };
            applyResume(item, data);
        } catch (error) {
            if (error.status === 0) throw error;
            // Expired, cleaned up or no longer valid: start this file again.
            forget(item);
            item.target = null;
            fresh.push(item);
        }
    }

    if (fresh.length > 0) {
        const { uploads } = await api('/api/upload', {
            uploader: nameField.value.trim(),
            files: fresh.map(({ file }) => ({ name: file.name, type: file.type, size: file.size })),
        });
        fresh.forEach((item, i) => {
            const grant = uploads[i];
            item.target = { key: grant.key, uploadId: grant.uploadId, size: grant.size };
            item.parts = grant.parts;
            item.done = new Set();
            item.stored = 0;
            remember(item);
        });
    }
}

// PUTs one part. Resolves 'ok' or 'expired' (S3 refused the URL); throws when the
// connection keeps failing.
async function putPart(item, part) {
    const start = (part.partNumber - 1) * config.partSize;
    const blob = item.file.slice(start, start + part.size);

    for (let attempt = 1; ; attempt++) {
        const status = await new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.upload.onprogress = (event) => {
                item.inflight = event.loaded;
                render(item);
            };
            xhr.onload = () => resolve(xhr.status);
            xhr.onerror = () => resolve(0);
            xhr.onabort = () => resolve(0);
            xhr.open('PUT', part.url);
            // The Blob sets Content-Length to exactly part.size, which the URL signs.
            xhr.send(blob);
        });
        item.inflight = 0;

        if (status >= 200 && status < 300) {
            item.done.add(part.partNumber);
            item.stored += part.size;
            render(item);
            return 'ok';
        }
        if (status === 403) return 'expired';
        if (attempt >= PART_ATTEMPTS) throw new ApiError(status, 'Verbindung unterbrochen');

        // Offline: wait for the connection (up to 30 s) instead of burning attempts.
        if (!navigator.onLine) {
            await Promise.race([new Promise((r) => window.addEventListener('online', r, { once: true })), sleep(30000)]);
        }
        await sleep(1000 * 2 ** (attempt - 1));
    }
}

async function uploadFile(item) {
    item.status = 'uploading';
    render(item);

    for (let round = 1; ; round++) {
        let expired = false;
        for (const part of item.parts) {
            if (item.done.has(part.partNumber)) continue;
            if ((await putPart(item, part)) === 'expired') {
                expired = true;
                break;
            }
        }

        if (!expired) {
            try {
                await api('/api/upload/complete', item.target);
                item.status = 'done';
                forget(item);
                render(item);
                return;
            } catch (error) {
                if (error.status === 410) {
                    forget(item);
                    item.target = null;
                }
                if (error.status !== 409) throw error;
            }
        }

        if (round >= REFRESH_ROUNDS) throw new ApiError(0, 'Upload unvollständig');
        applyResume(item, await api('/api/upload/resume', item.target));
    }
}

// --- Flow ------------------------------------------------------------------------

async function run(batch) {
    if (batch.length > 0) {
        await setBusy(true);
        hideMessage();
        retry.hidden = true;
        batch.forEach((item) => { item.status = 'pending'; item.error = ''; render(item); });

        try {
            await prepare(batch);
            let next = 0;
            const worker = async () => {
                while (next < batch.length) {
                    const item = batch[next++];
                    try {
                        await uploadFile(item);
                    } catch (error) {
                        item.status = 'failed';
                        item.error = error.message;
                        render(item);
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
        } catch (error) {
            batch.forEach((item) => {
                if (item.status !== 'done') {
                    item.status = 'failed';
                    item.error = error.message;
                    render(item);
                }
            });
        }

        await setBusy(false);
    }
    summarize();
}

function summarize() {
    const count = (status) => items.filter((item) => item.status === status).length;
    const done = count('done');
    const failed = count('failed');
    const rejected = count('rejected');
    const skipped = rejected ? ` ${files(rejected)} haben wir übersprungen (siehe Liste).` : '';

    if (failed > 0) {
        showMessage('error',
            `Hoppla – ${files(failed, ' ist', ' sind')} noch nicht ganz angekommen. Was schon ` +
            'übertragen ist, bleibt gespeichert. Prüf kurz dein Internet und tipp auf ' +
            `„Nochmal versuchen“ – es geht genau dort weiter, wo es aufgehört hat.${skipped}`);
        retry.hidden = false;
    } else if (done > 0) {
        showMessage('success', `Danke dir! ${files(done, ' ist', ' sind')} angekommen. ♥${skipped}`);
        pick.textContent = 'Noch mehr Fotos & Videos hochladen';
    } else if (rejected > 0) {
        showMessage('error', `Das hat leider nicht geklappt – keine der Dateien ließ sich hochladen.${skipped}`);
    }
}

input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    // Reset so that picking the same files again still fires `change`.
    input.value = '';
    if (picked.length === 0 || busy) return;

    if (picked.length > config.maxFiles) {
        showMessage('error',
            `Bitte wähl höchstens ${config.maxFiles} Dateien auf einmal aus – ` +
            'danach kannst du gleich weitere hochladen.');
        return;
    }

    list.replaceChildren();
    items = picked.map(makeItem);
    run(items.filter((item) => item.status === 'pending'));
});

retry.addEventListener('click', () => {
    run(items.filter((item) => item.status === 'failed'));
});

// --- QR code for passing the page on ---------------------------------------------

function setupQr() {
    const open = $('mu-qr-open');
    const dialog = $('mu-qr');
    const image = $('mu-qr-image');
    const placeholder = $('mu-qr-placeholder');
    if (!open || !dialog) return;

    // Move the button from the page body into the header: before the theme toggle when
    // dark mode is on, otherwise at the header's right-hand end.
    const header = document.querySelector('.md-header__inner');
    const paragraph = open.closest('p');
    if (header) {
        header.insertBefore(open, header.querySelector('.md-header__option') || null);
        if (paragraph && paragraph.textContent.trim() === '') paragraph.remove();
    }

    $('mu-qr-url').textContent = `${location.origin}/`;

    // images/qr.png is added at deployment (README checklist). Until then, or if it
    // fails to load, the placeholder stays.
    image.addEventListener('load', () => { image.hidden = false; placeholder.hidden = true; });
    image.addEventListener('error', () => { image.hidden = true; placeholder.hidden = false; });

    open.addEventListener('click', (event) => {
        event.preventDefault();
        if (!image.getAttribute('src')) image.src = 'images/qr.png';
        dialog.showModal();
    });
    // A tap on the backdrop closes the dialog too.
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });
}

// --- Portrait ----------------------------------------------------------------------

function setupPortrait() {
    const image = $('mu-portrait');
    if (!image) return;
    // The header carries the event title from Terraform; it is the most meaningful
    // alt text available without putting a name into the page source.
    const title = document.querySelector('.md-header__topic .md-ellipsis')?.textContent.trim();
    if (title) image.alt = title;
    // images/portrait.jpg is added at deployment (README checklist) and not in git, so a
    // checkout without it shows no broken-image icon, just no picture.
    const hide = () => { image.closest('figure').hidden = true; };
    image.addEventListener('error', hide);
    if (image.complete && image.naturalWidth === 0) hide();
}

// --- Start -----------------------------------------------------------------------

async function init() {
    try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        config = await response.json();
    } catch {
        limits.textContent = '';
        showMessage('error',
            'Der Upload klappt gerade nicht. Lad die Seite bitte in einem Moment ' +
            'noch einmal neu.');
        return;
    }

    if (!config.open) {
        limits.textContent = '';
        showMessage('info', 'Der Upload ist inzwischen geschlossen. Danke an alle, die Bilder geteilt haben! ♥');
        return;
    }

    nameField.maxLength = config.maxNameLength;
    limits.textContent =
        `Bis zu ${config.maxFiles} Dateien auf einmal · Fotos bis ${mb(config.maxPhotoBytes)} · ` +
        `Videos bis ${mb(config.maxVideoBytes)}`;
    setPickerEnabled(true);
}

setupPortrait();
setupQr();
init();
