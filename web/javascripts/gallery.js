// Admin gallery (/admin/gallery/): every uploaded photo, as /admin/api/list reports
// the uploads bucket, newest first. Videos stay on the download page.
//
// There are no thumbnails, so the tiles show the originals; loading="lazy" fetches
// only what scrolls into view. Each tile takes its photo's shape, so rows fill the
// width with landscape and portrait photos side by side. Formats the browser cannot
// draw (HEIC outside Safari, most TIFF) fall back to a placeholder on the image's error
// event. DNG is not even tried — no browser draws camera raw files. "Open" works for all.
//
// The slideshow is a native <dialog>: Esc closes it, ← and → step through all
// photos and wrap around at either end.

import { api } from './api.js';
import { fileUrl, loadFiles, mountHeaderLinks, photoUrl } from './admin-files.js';

mountHeaderLinks();

// Mirrors the photo extensions the API accepts (lambda/index.mjs).
const PHOTO_EXT = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|dng)$/i;
const NO_PREVIEW_EXT = /\.dng$/i;
// Material's "open-in-new" icon, as in the slideshow bar (gallery.md).
// Material's "trash-can-outline"; shown only to owners (canDelete from the list API).
const DELETE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5V3H9M7 6h10v13H7V6m2 2v9h2V8H9m4 0v9h2V8h-2Z"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3m-2 16H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7Z"/></svg>';

const $ = (id) => document.getElementById(id);
const grid = $('mu-gallery');
const summary = $('mu-summary');
const message = $('mu-message');
const dialog = $('mu-slideshow');
const slide = $('mu-slide');
const slideNone = $('mu-slide-none');
const counter = $('mu-counter');
const original = $('mu-original');

let photos = [];
let videos = 0;
let canDelete = false;
let current = 0;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Keys read "<time>_<uploader>_<random>.<ext>"; the uploader part is a slug.
const uploader = (photo) => photo.key.split('_')[1] || '';
const uploadedAt = (photo) =>
    new Date(photo.lastModified).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const caption = (photo) => [uploader(photo), uploadedAt(photo)].filter(Boolean).join(' · ');

function placeholder() {
    const none = document.createElement('span');
    none.className = 'mu-tile__none';
    none.textContent = 'Keine Vorschau';
    return none;
}

// tile is the <li>: once the photo's size is known, its row share follows the photo's
// shape (--ar in memorial.css), so landscape photos stay landscape.
function preview(photo, tile) {
    if (NO_PREVIEW_EXT.test(photo.key)) return placeholder();
    const img = document.createElement('img');
    img.loading = 'lazy'; // before src, or the browser starts loading at once
    img.decoding = 'async';
    img.alt = '';
    img.src = fileUrl(photo.key);
    img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
    img.addEventListener('load', () => {
        if (img.naturalHeight) tile.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(3));
    }, { once: true });
    return img;
}

function tile(photo, index) {
    const item = document.createElement('li');
    item.innerHTML = '<button type="button" class="mu-tile__open"></button>'
        + `<div class="mu-tile__meta"><span></span><a target="_blank" rel="noopener">${OPEN_ICON}Open</a></div>`;
    const open = item.querySelector('button');
    open.setAttribute('aria-label', `Diashow ab Bild ${index + 1} starten`);
    open.append(preview(photo, item));
    open.addEventListener('click', () => show(index));
    const label = item.querySelector('.mu-tile__meta span');
    label.textContent = uploader(photo) || uploadedAt(photo);
    label.title = caption(photo);
    item.querySelector('a').href = photoUrl(photo.key);
    if (canDelete) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'mu-tile__delete';
        remove.title = 'Delete';
        remove.setAttribute('aria-label', `Bild ${index + 1} löschen`);
        remove.innerHTML = DELETE_ICON;
        remove.addEventListener('click', () => deletePhoto(photo, remove));
        item.querySelector('.mu-tile__meta').append(remove);
    }
    return item;
}

// Permanent: the bucket keeps no old versions, hence the confirmation.
async function deletePhoto(photo, button) {
    if (!window.confirm(`„${caption(photo)}“ endgültig löschen? Das kann nicht rückgängig gemacht werden.`)) return;
    button.disabled = true;
    try {
        await api('/admin/api/delete', { key: photo.key });
        photos = photos.filter((other) => other !== photo);
        render();
    } catch (error) {
        button.disabled = false;
        message.dataset.kind = 'error';
        message.textContent = `Löschen fehlgeschlagen: ${error.message}`;
        message.hidden = false;
    }
}

function render() {
    summary.textContent = photos.length
        ? count(photos.length, 'Bild', 'Bilder')
            + (videos ? ` · ${count(videos, 'Video', 'Videos')} auf der Download-Seite` : '')
        : 'Noch keine Bilder hochgeladen.';
    grid.replaceChildren(...photos.map(tile));
}

function show(index) {
    current = (index + photos.length) % photos.length;
    const photo = photos[current];
    const drawable = !NO_PREVIEW_EXT.test(photo.key);
    slide.hidden = !drawable;
    slideNone.hidden = drawable;
    if (drawable) slide.src = fileUrl(photo.key);
    else slide.removeAttribute('src');
    slide.alt = caption(photo);
    counter.textContent = `${current + 1} / ${photos.length}`;
    original.href = photoUrl(photo.key);
    if (!dialog.open) dialog.showModal();

    // Warm the browser cache for the usual next step.
    const following = photos[(current + 1) % photos.length];
    if (!NO_PREVIEW_EXT.test(following.key)) new Image().src = fileUrl(following.key);
}

slide.addEventListener('error', () => {
    if (!slide.getAttribute('src')) return;
    slide.hidden = true;
    slideNone.hidden = false;
});
$('mu-prev').addEventListener('click', () => show(current - 1));
$('mu-next').addEventListener('click', () => show(current + 1));
$('mu-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(current - 1);
    else if (event.key === 'ArrowRight') show(current + 1);
});
// Stops a large original from loading on after the slideshow is closed.
dialog.addEventListener('close', () => slide.removeAttribute('src'));

async function init() {
    let files;
    try {
        ({ files, canDelete } = await loadFiles());
    } catch {
        summary.textContent = '';
        message.dataset.kind = 'error';
        message.textContent = 'Die Bilder konnten nicht geladen werden. Lad die Seite bitte neu.';
        message.hidden = false;
        return;
    }

    photos = files.filter((file) => PHOTO_EXT.test(file.key));
    videos = files.length - photos.length;
    render();
}

init();
