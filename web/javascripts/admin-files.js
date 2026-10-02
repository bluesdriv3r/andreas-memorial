// Shared by the admin pages. Everything here sits below /admin/, behind the session
// gate (terraform/admin-auth.js), and the session cookie travels with every request.
//
//   /admin/api/list          -> { files: [{ key, size, lastModified }] }
//   /admin/files/<key>       -> the object uploads/<key>
//   /admin/photo/#<key>      -> one photo with uploader and upload date (photo.js)

// Moves the page's Gallery / Downloads / Log out links from the content into the header
// bar, at its right-hand end. Until then CSS keeps them hidden.
export function mountHeaderLinks() {
    const links = document.querySelector('.mu-header-links');
    const header = document.querySelector('.md-header__inner');
    if (links && header) header.append(links);
}

export const fileUrl = (key) => `/admin/files/${encodeURIComponent(key)}`;
// The key travels in the fragment: it never reaches the server, and the browser keeps
// it across the login redirect (login.js passes it on).
export const photoUrl = (key) => `/admin/photo/#${encodeURIComponent(key)}`;

// { files, canDelete }, files newest first: keys start with the upload time. canDelete
// only shows or hides delete buttons; the API checks it again. A 401 means the session
// has expired; the login page brings the admin back here afterwards.
export async function loadFiles() {
    const response = await fetch('/admin/api/list', { cache: 'no-store' });
    if (response.status === 401) {
        window.location.assign(`/login/index.html?next=${encodeURIComponent(window.location.pathname)}`);
        return new Promise(() => {}); // the page is leaving; nothing more to render
    }
    if (!response.ok) throw new Error(String(response.status));
    const { files, canDelete } = await response.json();
    return { files: files.sort((a, b) => b.key.localeCompare(a.key)), canDelete: canDelete === true };
}
