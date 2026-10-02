---
title: Uploads herunterladen
hide:
  - navigation
  - toc
  - footer
---

# Uploads herunterladen

<!-- admin-files.js moves these links into the header bar. -->
<div class="mu-header-links" markdown>
[:material-image-multiple: <span>Gallery</span>](gallery/){ title="Gallery" }
[:material-logout: <span>Log out</span>](/api/logout){ title="Log out" }
</div>

<div class="mu-form mu-form--wide">
  <p id="mu-summary" class="mu-limits">Liste wird geladen …</p>
  <button type="button" id="mu-download-all" class="mu-button" hidden>Alle in einen Ordner herunterladen</button>
  <div id="mu-message" class="mu-message" role="status" aria-live="polite" hidden></div>
</div>

!!! note "HEIC-Fotos für die Diashow"

    iPhone-Fotos kommen teils als `.heic` an. Auf dem Mac wandelt `sips` sie im
    Download-Ordner in JPEG um; die Originale bleiben erhalten:

    ```zsh
    for f in *.(heic|HEIC|heif|HEIF)(N); do sips -s format jpeg "$f" --out "${f%.*}.jpg"; done
    ```

    `download.sh` im Projektordner erledigt Download und Umwandlung in einem Schritt.

<div class="mu-table-wrap">
  <table class="mu-table">
    <thead><tr><th>Datei</th><th>Größe</th><th>Hochgeladen</th></tr></thead>
    <tbody id="mu-files"></tbody>
  </table>
</div>

<script type="module" src="../javascripts/admin.js"></script>
