---
title: Galerie
hide:
  - navigation
  - toc
  - footer
---

# Galerie

<!-- admin-files.js moves these links into the header bar. -->
<div class="mu-header-links" markdown>
[:material-download: <span>Downloads</span>](../){ title="Downloads" }
[:material-logout: <span>Log out</span>](/api/logout){ title="Log out" }
</div>

<div class="mu-form mu-form--wide">
  <p id="mu-summary" class="mu-limits">Bilder werden geladen …</p>
  <div id="mu-message" class="mu-message" role="status" aria-live="polite" hidden></div>
</div>

<ul id="mu-gallery" class="mu-gallery"></ul>

<!-- The div keeps Markdown from wrapping the dialog's lines in <p> and <br>. -->
<div>
<dialog id="mu-slideshow" class="mu-slideshow" aria-label="Diashow">
  <img id="mu-slide" alt="">
  <p id="mu-slide-none" class="mu-slide-none" hidden>Keine Vorschau in diesem Browser – „Open“ öffnet die Datei.</p>
  <div class="mu-slideshow__bar">
    <button type="button" id="mu-prev" aria-label="Vorheriges Bild">‹</button>
    <span id="mu-counter"></span>
    <a id="mu-original" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3m-2 16H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7Z"/></svg>Open</a>
    <button type="button" id="mu-next" aria-label="Nächstes Bild">›</button>
    <button type="button" id="mu-close" aria-label="Diashow schließen">✕</button>
  </div>
</dialog>
</div>

<script type="module" src="../../javascripts/gallery.js"></script>
