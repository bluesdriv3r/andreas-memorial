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
});
const api = await import('../lambda/index.mjs');
const { S3Client, UploadPartCommand } = await import('@aws-sdk/client-s3');
const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// --- Mock S3 -------------------------------------------------------------------
const uploads = new Map(); const calls = [];
api.setS3Client({ send: async (cmd) => {
  const n = cmd.constructor.name, i = cmd.input; calls.push([n, i]);
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
