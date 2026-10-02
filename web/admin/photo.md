---
title: Foto
hide:
  - navigation
  - toc
  - footer
---

# Foto

<!-- admin-files.js moves these links into the header bar. -->
<div class="mu-header-links" markdown>
[:material-image-multiple: <span>Gallery</span>](../gallery/){ title="Gallery" }
[:material-download: <span>Downloads</span>](../){ title="Downloads" }
[:material-logout: <span>Log out</span>](/api/logout){ title="Log out" }
</div>

<div id="mu-message" class="mu-message" data-kind="error" role="alert" hidden></div>

<figure id="mu-photo" class="mu-photo" hidden>
  <img id="mu-photo-image" alt="">
  <p id="mu-photo-none" class="mu-tile__none" hidden>Keine Vorschau in diesem Browser – „Download“ lädt die Datei.</p>
  <figcaption class="mu-tile__meta">
    <span><strong id="mu-photo-uploader"></strong> · <span id="mu-photo-date"></span></span>
    <a id="mu-photo-download" download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7Z"/></svg>Download</a>
  </figcaption>
</figure>

<script type="module" src="../../javascripts/photo.js"></script>
