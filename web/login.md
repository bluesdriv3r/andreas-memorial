---
title: Anmelden
hide:
  - navigation
  - toc
  - footer
---

# Anmelden

<!-- method="post": should the script not run, the password never lands in a URL. -->
<div class="mu-auth">
  <p class="mu-lede">Dieser Bereich ist privat.</p>
  <div id="mu-message" class="mu-message" data-kind="error" role="alert" hidden></div>
  <form id="mu-login" class="mu-form" method="post" action="/api/login">
    <div class="mu-field">
      <label for="mu-username">Benutzername</label>
      <input type="text" id="mu-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    </div>
    <div class="mu-field">
      <label for="mu-password">Passwort</label>
      <input type="password" id="mu-password" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit" class="mu-button">Anmelden</button>
  </form>
</div>

<script type="module" src="../javascripts/login.js"></script>
