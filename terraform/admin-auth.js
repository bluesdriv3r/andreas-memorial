// CloudFront Function, viewer-request event, runtime cloudfront-js-2.0.
//
// Guards everything under /admin with HTTP Basic Auth.
//
// All admin traffic — page, API and file downloads — lives below /admin/ on
// purpose: browsers resend a Basic Auth credential pre-emptively only for paths
// at or below the one that was authenticated (RFC 7617 §2.2), so fetch() calls
// from the admin page to /admin/api/ and /admin/files/ carry it without a
// second prompt.
//
//   /admin, /admin/          page      -> /admin/index.html
//   /admin/files/<key>       download  -> uploads bucket key uploads/<key>
//   /admin/api/...           API       -> passed through to the Lambda origin
//
// EXPECTED is sha256(base64("user:password")), injected by Terraform from
// var.credential_sha256. Only the digest is ever stored — not the password.

var crypto = require('crypto');

var EXPECTED = '${credential_sha256}';
var REALM = 'Basic realm="Memorial Admin", charset="UTF-8"';
var FILES_PREFIX = '/admin/files/';

function unauthorized() {
    return {
        statusCode: 401,
        statusDescription: 'Unauthorized',
        headers: {
            'www-authenticate': { value: REALM },
            'cache-control': { value: 'no-store' }
        }
    };
}

function handler(event) {
    var request = event.request;

    // Header names in the event object are always lowercase.
    var auth = request.headers.authorization && request.headers.authorization.value;
    if (!auth || auth.indexOf('Basic ') !== 0) {
        return unauthorized();
    }

    var presented = crypto.createHash('sha256').update(auth.slice(6)).digest('hex');
    if (presented !== EXPECTED) {
        return unauthorized();
    }

    var uri = request.uri;

    if (uri === '/admin') {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: '/admin/' } }
        };
    }

    if (uri === '/admin/') {
        request.uri = '/admin/index.html';
    } else if (uri.indexOf(FILES_PREFIX) === 0) {
        // The behavior was chosen on the original path; only the origin sees this one.
        request.uri = '/uploads/' + uri.slice(FILES_PREFIX.length);
    }

    return request;
}
