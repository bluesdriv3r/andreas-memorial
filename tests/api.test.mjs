// Offline tests for the API function (lambda/index.mjs). No AWS account needed: S3 is
// replaced by an in-memory mock, and the hand-written SigV4 presigning is compared with
// the AWS SDK's own presigner. Run with:  npm install && npm test
//
// Each check prints PASS or FAIL; the process exits non-zero if any check fails.

Object.assign(process.env, {
  UPLOADS_BUCKET: 'test-bucket', AWS_REGION: 'eu-central-1', UPLOAD_DEADLINE: '2099-01-01T00:00:00Z',
  MAX_FILES: '20', MAX_PHOTO_BYTES: String(50 * 1048576), MAX_VIDEO_BYTES: String(300 * 1048576),
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'IQoJb3JpZ2luX2VjE//token+with/slash==',
  // Written by set-password.sh for the password 'correct horse battery'.
  ADMIN_USERS: JSON.stringify({ markus: 'pbkdf2_sha256$600000$32f18017cc838c9be15e2c05110b9885$f8ed876ad273a2002229dd04ab654fd93c18605e60548853731dbd4aae6d6976', marie: 'pbkdf2_sha256$600000$32f18017cc838c9be15e2c05110b9885$f8ed876ad273a2002229dd04ab654fd93c18605e60548853731dbd4aae6d6976' }),
  ADMIN_OWNERS: JSON.stringify(['marie']),
  SESSION_KEY: 'a'.repeat(64), SESSION_HOURS: '12',
});
const api = await import('../lambda/index.mjs');
const { createHmac } = await import('node:crypto');
const { S3Client, UploadPartCommand } = await import('@aws-sdk/client-s3');
const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// --- Mock S3 -------------------------------------------------------------------
const uploads = new Map(); const calls = []; const objects = []; const deleted = [];
api.setS3Client({ send: async (cmd) => {
  const n = cmd.constructor.name, i = cmd.input; calls.push([n, i]);
  if (n === 'DeleteObjectCommand') { deleted.push(i.Key); return {}; }
  if (n === 'ListObjectsV2Command') return { Contents: objects.map(([Key, Size]) => ({ Key, Size, LastModified: new Date('2026-10-03T19:04:11Z') })), IsTruncated: false };
  if (n === 'CreateMultipartUploadCommand') { const id = 'up' + uploads.size + '.x_y-z~'; uploads.set(id, { key: i.Key, parts: new Map(), meta: i.Metadata, type: i.ContentType }); return { UploadId: id }; }
  const u = uploads.get(i.UploadId);
  if (!u || u.key !== i.Key) { const e = new Error('nope'); e.name = 'NoSuchUpload'; throw e; }
  if (n === 'ListPartsCommand') return { Parts: [...u.parts].map(([PartNumber, Size]) => ({ PartNumber, Size, ETag: `"e${PartNumber}"` })), IsTruncated: false };
  if (n === 'CompleteMultipartUploadCommand') { u.completed = i.MultipartUpload.Parts; return {}; }
  if (n === 'AbortMultipartUploadCommand') { uploads.delete(i.UploadId); return {}; }
  throw new Error('unexpected ' + n);
}});
const ev = (method, path, body) => ({ requestContext: { http: { method } }, rawPath: path, body: body && JSON.stringify(body) });
const call = async (...a) => { const r = await api.handler(ev(...a)); return { ...r, json: JSON.parse(r.body) }; };
const MB = 1048576, P = 8 * MB;

let r = await call('GET', '/api/config');
ok(r.json.open === true && r.json.partSize === P && r.body.includes('"open":true'), 'config open, partSize 8 MiB');
ok((await call('POST', '/api/upload', { files: Array.from({ length: 21 }, (_, i) => ({ name: `${i}.jpg`, type: 'image/jpeg', size: 10 })) })).statusCode === 400, '21 files 400');
ok((await call('POST', '/api/upload', { files: [{ name: 'a.jpg', type: 'image/jpeg', size: 50 * MB + 1 }] })).statusCode === 400, 'photo 50 MB+1 400');
ok((await call('POST', '/api/upload', { files: [{ name: 'a.jpg', size: 1.5 }] })).statusCode === 400, 'fractional size 400');
ok((await call('POST', '/api/upload', { files: [{ name: 'x.exe', type: 'application/x-msdownload', size: 10 }] })).statusCode === 400, 'exe 400');
ok((await call('POST', '/api/upload', { files: [{ name: 'x.jxl', type: 'image/jxl', size: 10 }] })).statusCode === 400, 'unknown image format 400');
ok((await call('POST', '/api/upload', { files: [{ name: 'photo', type: 'image/heic', size: 10 }] })).statusCode === 200, 'no extension but known type 200');
const before = calls.length;
ok((await call('POST', '/api/upload', { files: [{ name: 'ok.jpg', type: 'image/jpeg', size: 10 }, { name: 'bad.exe', size: 10 }] })).statusCode === 400 && calls.length === before, 'mixed batch refused before any S3 call');
r = await api.handler({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/upload', body: 'null' });
ok(r.statusCode === 400, 'JSON null body 400');

// Valid batch: HEIC without type, 20 MB video → 3 parts.
r = await call('POST', '/api/upload', { uploader: 'Jürgen Müller', files: [{ name: 'IMG_1.HEIC', type: '', size: 3 * MB }, { name: 'clip.mov', type: 'video/quicktime', size: 20 * MB }] });
ok(r.statusCode === 200 && r.json.uploads.length === 2, 'valid batch 200');
const [h, v] = r.json.uploads;
ok(/^uploads\/[\dT-]+Z_juergen-mueller_[0-9a-f]{8}\.heic$/.test(h.key), `HEIC key ${h.key}`);
ok(uploads.get(h.uploadId).type === 'image/heic' && decodeURIComponent(uploads.get(h.uploadId).meta.uploader) === 'Jürgen Müller', 'content type + uploader metadata at create');
ok(h.parts.length === 1 && h.parts[0].size === 3 * MB, 'HEIC: 1 part of 3 MB');
ok(v.parts.length === 3 && v.parts.map((p) => p.size).join() === [P, P, 4 * MB].join(), 'video: 8+8+4 MB parts');
const u1 = new URL(v.parts[1].url);
ok(u1.host === 'test-bucket.s3.eu-central-1.amazonaws.com' && u1.searchParams.get('partNumber') === '2' && u1.searchParams.get('uploadId') === v.uploadId, 'part URL: regional host, partNumber, uploadId');
ok(u1.searchParams.get('X-Amz-SignedHeaders') === 'content-length;host', 'content-length is signed');
ok(u1.searchParams.get('X-Amz-Expires') === '3600', 'URL expires in 1 h');

// Complete before parts → 409; upload part 1 and 2, resume → only part 3 missing.
const U = uploads.get(v.uploadId);
const target = { key: v.key, uploadId: v.uploadId, size: 20 * MB };
ok((await call('POST', '/api/upload/complete', target)).statusCode === 409, 'complete with no parts 409');
U.parts.set(1, P); U.parts.set(2, P);
r = await call('POST', '/api/upload/resume', target);
ok(r.statusCode === 200 && r.json.done.join() === '1,2' && r.json.parts.map((p) => p.partNumber).join() === '3', 'resume: done 1,2; URL only for 3');
U.parts.set(2, 123);
r = await call('POST', '/api/upload/resume', target);
ok(r.json.done.join() === '1' && r.json.parts.map((p) => p.partNumber).join() === '2,3', 'resume: wrong-length part 2 is re-sent');
U.parts.set(2, P); U.parts.set(3, 4 * MB);
r = await call('POST', '/api/upload/complete', target);
ok(r.statusCode === 200 && U.completed.map((p) => p.ETag).join() === '"e1","e2","e3"', 'complete: all parts in order with ETags');

// Oversize at completion → abort.
r = await call('POST', '/api/upload', { files: [{ name: 'p.jpg', type: 'image/jpeg', size: 10 * MB }] });
const p = r.json.uploads[0]; const PU = uploads.get(p.uploadId);
PU.parts.set(1, P); PU.parts.set(2, 2 * MB); PU.parts.set(9, 45 * MB);
r = await call('POST', '/api/upload/complete', { key: p.key, uploadId: p.uploadId, size: 10 * MB });
ok(r.statusCode === 400 && !uploads.has(p.uploadId), 'parts beyond limit: 400 and aborted');
r = await call('POST', '/api/upload/complete', { key: p.key, uploadId: p.uploadId, size: 10 * MB });
ok(r.statusCode === 410, 'aborted upload: 410');
r = await call('POST', '/api/upload/resume', { key: p.key, uploadId: p.uploadId, size: 10 * MB });
ok(r.statusCode === 410, 'resume after abort: 410');

// Target validation.
for (const [label, t] of [
  ['foreign key prefix', { ...target, key: 'other/x.jpg' }],
  ['path traversal key', { ...target, key: 'uploads/../x.jpg' }],
  ['size above video max', { ...target, size: 301 * MB }],
  ['photo key with video size', { key: h.key, uploadId: h.uploadId, size: 60 * MB }],
  ['uploadId with slash', { ...target, uploadId: 'a/b' }],
  ['missing fields', {}],
]) ok((await call('POST', '/api/upload/resume', t)).statusCode === 400, `resume rejects ${label}`);

// Admin login, logout and session.
const PASSWORD = 'correct horse battery';
const login = (body) => api.handler(ev('POST', '/api/login', body));
const adminList = (cookies) => api.handler({ ...ev('GET', '/admin/api/list'), cookies });
ok(await api.checkPassword(PASSWORD, await api.hashPassword(PASSWORD, undefined, 1000)), 'hashPassword/checkPassword round trip');
ok(!(await api.checkPassword(PASSWORD, 'pbkdf2_sha256$x$y$z')), 'malformed stored hash refused');
r = await login({ username: 'markus', password: 'wrong password!' });
ok(r.statusCode === 401 && !r.cookies, 'wrong password: 401, no cookie');
r = await login({ username: 'nobody', password: PASSWORD });
ok(r.statusCode === 401 && !r.cookies, 'unknown user: 401, no cookie');
ok((await login({ password: PASSWORD })).statusCode === 401, 'missing username: 401');
ok((await login({ username: 'markus', password: ` ${PASSWORD}` })).statusCode === 401, 'password is not trimmed');
ok((await login({})).statusCode === 401, 'missing password: 401');
ok((await login({ username: 'hasOwnProperty', password: PASSWORD })).statusCode === 401, 'prototype key as username: 401');
ok((await api.handler({ ...ev('POST', '/api/login'), body: '{' })).statusCode === 400, 'malformed login body: 400');
r = await login({ username: ' Markus ', password: PASSWORD, next: '/admin/gallery/' });
const cookie = r.cookies?.[0] ?? '';
ok(r.statusCode === 200 && JSON.parse(r.body).next === '/admin/gallery/', 'login: 200 with next');
ok(/^__Host-mem_admin=markus\.\d+\.[0-9a-f]{64}; Path=\/; Max-Age=43200; Secure; HttpOnly; SameSite=Strict$/.test(cookie), `login cookie flags: ${cookie}`);
const session = cookie.split(';')[0];
for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '/admin/../api/x', '/admin/%2e%2e/x',
  '/api/logout', '/adminx', '/admin/?a=b', 'javascript:alert(1)']) {
  ok(api.safeNext(bad) === '/admin/gallery/', `next ${bad} -> /admin/gallery/`);
}
ok(api.safeNext('/admin/files/2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg') === '/admin/files/2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg', 'next: admin file kept');
r = await api.handler(ev('GET', '/api/logout'));
ok(r.statusCode === 303 && r.headers.location === '/login/index.html' && /^__Host-mem_admin=; Path=\/; Max-Age=0;/.test(r.cookies[0]), 'logout: 303 to login page, cookie cleared');

objects.push(['uploads/2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg', 10], ['uploads/2026-10-03T19-04-12Z_x_00000000.png', 20]);
const [, exp, sig] = session.split('=')[1].split('.');
const flip = (c) => (c === '0' ? '1' : '0');
const mac = (payload) => createHmac('sha256', 'a'.repeat(64)).update(payload).digest('hex');
const past = Math.floor(Date.now() / 1000) - 1;
for (const [label, cookies] of [
  ['no cookie', undefined],
  ['empty cookie', ['__Host-mem_admin=']],
  ['forged signature', [`__Host-mem_admin=markus.${exp}.${'0'.repeat(64)}`]],
  ['tampered signature', [`__Host-mem_admin=markus.${exp}.${flip(sig[0])}${sig.slice(1)}`]],
  ['extended expiry', [`__Host-mem_admin=markus.${Number(exp) + 3600}.${sig}`]],
  ['other user, same signature', [`__Host-mem_admin=marie.${exp}.${sig}`]],
  ['expired', [`__Host-mem_admin=markus.${past}.${mac(`markus.${past}`)}`]],
  ['validly signed, user removed', [`__Host-mem_admin=hannah.${exp}.${mac(`hannah.${exp}`)}`]],
  ['old format without user', [`__Host-mem_admin=${exp}.${mac(exp)}`]],
  ['wrong cookie name', [`mem_admin=markus.${exp}.${sig}`]],
]) ok((await adminList(cookies)).statusCode === 401, `admin list, ${label}: 401`);
r = await adminList(['other=1', session]);
ok(r.statusCode === 200 && JSON.parse(r.body).files.map((f) => f.key).join() === '2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg,2026-10-03T19-04-12Z_x_00000000.png', 'admin list, valid session: 200 with keys');

ok(JSON.parse(r.body).canDelete === false, 'list: markus may not delete');

// Delete: owners only, generated keys only.
const ownerSession = `__Host-mem_admin=${api.sessionValue('marie')}`;
const del = (cookies, key) => api.handler({ ...ev('POST', '/admin/api/delete', { key }), cookies });
ok(JSON.parse((await adminList([ownerSession])).body).canDelete === true, 'list: owner marie may delete');
const k = '2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg';
ok((await del(undefined, k)).statusCode === 401 && deleted.length === 0, 'delete without session: 401');
ok((await del([session], k)).statusCode === 403 && deleted.length === 0, 'delete by non-owner: 403');
for (const bad of ['../site/index.html', 'x.jpg', '', '2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg/../../y']) {
  ok((await del([ownerSession], bad)).statusCode === 400, `delete rejects key ${JSON.stringify(bad)}`);
}
ok(deleted.length === 0, 'nothing deleted by refused requests');
r = await del([ownerSession], k);
ok(r.statusCode === 200 && deleted.join() === `uploads/${k}`, 'owner deletes uploads/<key>');
ok((await api.handler({ ...ev('GET', '/admin/api/delete'), cookies: [ownerSession] })).statusCode === 404, 'GET delete: 404');

// Signature cross-check against the AWS SDK presigner (same instant, same inputs).
const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
const client = new S3Client({ region: 'eu-central-1', credentials: creds });
const now = new Date('2026-10-03T19:04:11Z');
const key = 'uploads/2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg';
const sdkUrl = new URL(await getSignedUrl(client, new UploadPartCommand({ Bucket: 'test-bucket', Key: key, UploadId: 'abc.def-ghi_', PartNumber: 2, ContentLength: 8388608 }), { expiresIn: 3600, signingDate: now, signableHeaders: new Set(['content-length']) }));
console.log('      SDK signed headers:', sdkUrl.searchParams.get('X-Amz-SignedHeaders'), '| extra params:', [...sdkUrl.searchParams.keys()].filter((k) => !k.startsWith('X-Amz')).join(','));
const sdkQuery = Object.fromEntries([...sdkUrl.searchParams].filter(([k]) => !k.startsWith('X-Amz-')));
const mine = new URL(api.presignUrl({ method: 'PUT', key, query: sdkQuery, headers: { 'content-length': '8388608' }, now, credentials: creds }));
ok(mine.searchParams.get('X-Amz-SignedHeaders') === sdkUrl.searchParams.get('X-Amz-SignedHeaders'), 'signed headers match SDK');
ok(mine.searchParams.get('X-Amz-Signature') === sdkUrl.searchParams.get('X-Amz-Signature'), 'presignUrl signature matches AWS SDK');

// Deadline: closed start, but resume/complete within grace.
process.env.UPLOAD_DEADLINE = new Date(Date.now() - 3600e3).toISOString();
const late = await import('../lambda/index.mjs?late'); late.setS3Client({ send: async () => ({ Parts: [] }) });
const lcall = async (...a) => { const x = await late.handler(ev(...a)); return { ...x, json: JSON.parse(x.body) }; };
ok((await lcall('GET', '/api/config')).json.open === false, 'after deadline: config closed');
ok((await lcall('POST', '/api/upload', { files: [{ name: 'a.jpg', size: 10 }] })).statusCode === 403, 'after deadline: start 403');
ok((await lcall('POST', '/api/upload/resume', target)).statusCode === 200, 'after deadline, in grace: resume allowed');
process.env.UPLOAD_DEADLINE = new Date(Date.now() - 7 * 3600e3).toISOString();
const later = await import('../lambda/index.mjs?later'); later.setS3Client({ send: async () => ({ Parts: [] }) });
ok((await later.handler(ev('POST', '/api/upload/resume', target))).statusCode === 403, 'after grace: resume 403');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
