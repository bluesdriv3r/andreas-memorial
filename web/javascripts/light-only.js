// Dark mode is switched off for now (see the palette comment in mkdocs.yml). A browser
// that chose the dark scheme while it was still on keeps that choice in localStorage,
// and Material would restore it; this resets it to the light scheme.
//
// Material scopes the key by the site root, which is "/" on both pages.
(() => {
    try {
        localStorage.removeItem('/.__palette');
    } catch {
        // Storage blocked: then nothing was stored either.
    }
    document.body.setAttribute('data-md-color-scheme', 'default');
})();
