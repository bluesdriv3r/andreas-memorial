// CloudFront Function, viewer-request event, runtime cloudfront-js-2.0.
//
// Guards everything under /admin with the session cookie that POST /api/login sets
// (lambda/index.mjs). The cookie is "<user>.<expiry>.<hmac>": the username, the expiry
// in Unix seconds and HMAC-SHA256(SESSION_KEY, "<user>.<expiry>") as hex. It is
// stateless: removing a user ends that user's sessions, rotating the key ends all
// (../set-password.sh + apply).
//
//   /admin, /admin/gallery   page      -> 301 to the trailing-slash URL
//   /admin/, /admin/gallery/ page      -> <path>index.html
//   /admin/files/<key>       original  -> uploads bucket key uploads/<key>
//   /admin/api/...           API       -> passed through to the Lambda origin,
//                                         which checks the cookie a second time
//
// Without a valid session, pages and originals redirect to the login page so a
// bookmarked page or an image opened in a new tab comes back after login; the API
// answers 401 for the page scripts to handle.
//
// SESSION_KEY and USERS are injected by Terraform from var.session_key and the keys of
// var.admin_users.

var crypto = require('crypto');

var SESSION_KEY = '${session_key}';
var USERS = ${admin_users};
var COOKIE = '__Host-mem_admin';
var FILES_PREFIX = '/admin/files/';
var API_PREFIX = '/admin/api/';

// Constant-time comparison of two equal-length hex strings.
function equal(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function validSession(request) {
    var cookie = request.cookies[COOKIE];
    var match = cookie && /^([a-z0-9-]{1,32})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(cookie.value);
    if (!match || USERS.indexOf(match[1]) === -1 || parseInt(match[2], 10) * 1000 <= Date.now()) return false;
    var expected = crypto.createHmac('sha256', SESSION_KEY).update(match[1] + '.' + match[2]).digest('hex');
    return equal(expected, match[3]);
}

function deny(uri) {
    if (uri.indexOf(API_PREFIX) === 0) {
        return {
            statusCode: 401,
            statusDescription: 'Unauthorized',
            headers: { 'cache-control': { value: 'no-store' } }
        };
    }
    return {
        statusCode: 302,
        statusDescription: 'Found',
        headers: {
            location: { value: '/login/index.html?next=' + encodeURIComponent(uri) },
            'cache-control': { value: 'no-store' }
        }
    };
}

function handler(event) {
    var request = event.request;
    var uri = request.uri;

    if (!validSession(request)) {
        return deny(uri);
    }

    if (uri.indexOf(FILES_PREFIX) === 0) {
        // The behavior was chosen on the original path; only the origin sees this one.
        request.uri = '/uploads/' + uri.slice(FILES_PREFIX.length);
    } else if (uri.slice(-1) === '/') {
        request.uri = uri + 'index.html';
    } else if (uri.indexOf(API_PREFIX) !== 0 && uri.slice(uri.lastIndexOf('/')).indexOf('.') === -1) {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: uri + '/' } }
        };
    }

    return request;
}
