---
title: Fotos teilen
hide:
  - navigation
  - toc
  - footer
---

<figure class="mu-portrait">
  <img id="mu-portrait" src="images/portrait.jpg" width="1086" height="1233" alt="Porträt" fetchpriority="high">
</figure>

<blockquote class="mu-quote">
  <p>Live long and prosper! 🖖</p>
</blockquote>

# Fotos und Videos teilen

<!-- upload.js moves this button into the header, at its right-hand end. -->
[:material-qrcode:](#mu-qr){ #mu-qr-open .md-header__button .md-icon title="QR-Code zeigen" aria-label="QR-Code zum Weitergeben zeigen" }

!!! info "Gut zu wissen"

    Alle Fotos und Videos, die du hier hochlädst, zeigen wir bei der Lebensfeier in einer
    Diashow. Lade also bitte nur Bilder hoch, die alle sehen dürfen. Bis dahin sieht sie
    niemand außer uns – auch die anderen Gäste nicht.

<div class="mu-form">
  <div class="mu-field">
    <label for="mu-uploader">Dein Name <span class="mu-optional">(optional – damit wir wissen, von wem die Bilder sind)</span></label>
    <input id="mu-uploader" type="text" maxlength="60" autocomplete="name" enterkeyhint="done">
  </div>
  <input id="mu-files" class="mu-visually-hidden" type="file" multiple accept="image/*,video/*,.heic,.heif" disabled>
  <label for="mu-files" id="mu-pick" class="mu-button is-disabled">Fotos &amp; Videos hochladen</label>
  <p id="mu-limits" class="mu-limits">Einen Moment bitte …</p>
  <div id="mu-message" class="mu-message" role="status" aria-live="polite" hidden></div>
  <button type="button" id="mu-retry" class="mu-button mu-button--secondary" hidden>Nochmal versuchen</button>
  <ul id="mu-list" class="mu-list"></ul>
</div>

<!-- upload.js moves this link into the footer bar. The admin area is protected by its
     login, not by hiding this link. -->
[Management](admin/gallery/){ #mu-management .mu-footer-link }

<dialog id="mu-qr" class="mu-qr" aria-labelledby="mu-qr-title">
  <p id="mu-qr-title" class="mu-qr-title">Seite weitergeben</p>
  <p class="mu-limits">Einfach mit der Handykamera scannen – ganz ohne Anmeldung.</p>
  <img id="mu-qr-image" class="mu-qr-image" alt="QR-Code zu dieser Seite" width="320" height="320" hidden>
  <div id="mu-qr-placeholder" class="mu-qr-placeholder">QR-Code kommt noch</div>
  <p id="mu-qr-url" class="mu-qr-url"></p>
  <form method="dialog"><button class="mu-button mu-button--secondary">Schließen</button></form>
</dialog>

<script type="module" src="javascripts/upload.js"></script>
