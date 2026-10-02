// Admin login (/login/). POST /api/login checks the password and sets the session
// cookie; from then on terraform/admin-auth.js lets /admin requests through.
//
// ?next= is the admin path the gate redirected from. The API re-validates it and
// answers with the path to open, so a crafted link cannot turn this page into an
// open redirect.

import { api } from './api.js';

const form = document.getElementById('mu-login');
const username = document.getElementById('mu-username');
const password = document.getElementById('mu-password');
const message = document.getElementById('mu-message');
const button = form.querySelector('button');
const next = new URLSearchParams(window.location.search).get('next') || '/admin/gallery/';

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    message.hidden = true;
    try {
        const data = await api('/api/login', { username: username.value, password: password.value, next });
        // The fragment (a photo key on /admin/photo/) survived the redirect to this page.
        const target = /^\/admin(\/|$)/.test(data.next) ? data.next : '/admin/gallery/';
        window.location.assign(target + window.location.hash);
    } catch (error) {
        message.textContent = error.status === 0
            ? 'Keine Verbindung – versuch es bitte noch einmal.'
            : error.message;
        message.hidden = false;
        button.disabled = false;
        password.select();
    }
});
