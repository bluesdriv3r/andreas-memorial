// Admin download page. Everything it calls sits below /admin/, so the browser
// resends the Basic Auth credential from the page prompt (see terraform/admin-auth.js).
//
//   /admin/api/list          -> [{ key, size, lastModified }]
//   /admin/files/<key>       -> the object uploads/<key>
//
// "Alle in einen Ordner herunterladen" uses the File System Access API, which only
// Chromium browsers on the desktop offer. Everywhere else the per-file links and
// download.sh remain.

const $ = (id) => document.getElementById(id);
const summary = $('mu-summary');
const tbody = $('mu-files');
const downloadAll = $('mu-download-all');
const message = $('mu-message');

const mb = (bytes) =>
    `${(bytes / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;

const fileUrl = (key) => `/admin/files/${encodeURIComponent(key)}`;

function showMessage(kind, text) {
    message.dataset.kind = kind;
    message.textContent = text;
    message.hidden = false;
}

function renderTable(files) {
    tbody.replaceChildren(...files.map((file) => {
        const row = document.createElement('tr');
        row.innerHTML = '<td><a download></a></td><td></td><td></td>';
        const link = row.querySelector('a');
        link.href = fileUrl(file.key);
        link.textContent = file.key;
        row.children[1].textContent = mb(file.size);
        row.children[2].textContent = new Date(file.lastModified).toLocaleString('de-DE');
        return row;
    }));
}

// Skips files already present with the same size, so a second run after new
// uploads only fetches what is missing.
async function saveAll(files) {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    let saved = 0;
    let skipped = 0;
    let failed = 0;

    downloadAll.disabled = true;
    for (const [i, file] of files.entries()) {
        showMessage('info', `${i + 1} / ${files.length}: ${file.key}`);
        try {
            const existing = await dir.getFileHandle(file.key).then((h) => h.getFile()).catch(() => null);
            if (existing && existing.size === file.size) {
                skipped++;
                continue;
            }
            const response = await fetch(fileUrl(file.key));
            if (!response.ok) throw new Error(String(response.status));
            const handle = await dir.getFileHandle(file.key, { create: true });
            await response.body.pipeTo(await handle.createWritable());
            saved++;
        } catch (error) {
            console.error(file.key, error);
            failed++;
        }
    }
    downloadAll.disabled = false;

    const text = `${saved} gespeichert, ${skipped} schon vorhanden, ${failed} fehlgeschlagen.`;
    showMessage(failed ? 'error' : 'success', failed ? `${text} Bitte erneut starten.` : text);
}

async function init() {
    let files;
    try {
        const response = await fetch('/admin/api/list', { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        ({ files } = await response.json());
    } catch (error) {
        summary.textContent = '';
        showMessage('error', `Liste konnte nicht geladen werden (${error.message}).`);
        return;
    }

    files.sort((a, b) => b.key.localeCompare(a.key));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    summary.textContent = `${files.length} Dateien · ${mb(total)} insgesamt`;
    renderTable(files);

    if (files.length === 0) return;
    if ('showDirectoryPicker' in window) {
        downloadAll.hidden = false;
        downloadAll.addEventListener('click', () => {
            saveAll(files).catch((error) => {
                // AbortError: the folder dialog was cancelled.
                if (error.name !== 'AbortError') showMessage('error', error.message);
                downloadAll.disabled = false;
            });
        });
    } else {
        showMessage('info',
            'Dieser Browser kann nicht in einen Ordner speichern. Dateien einzeln über die ' +
            'Liste laden, Chrome oder Edge am Computer verwenden, oder download.sh ausführen.');
    }
}

init();
