// Memorial upload API — one Lambda function URL behind CloudFront (Node.js 22).
//
//   GET  /api/config            public  limits + whether uploads are still open
//   POST /api/upload            public  start one S3 multipart upload per announced file
//   POST /api/upload/resume     public  parts already stored + fresh URLs for the rest
//   POST /api/upload/complete   public  verify the parts and assemble the object
//   GET  /admin/api/list        admin   object list; Basic Auth is enforced at the edge
//
// The function never touches file bytes. Every file is an S3 multipart upload in
// PART_SIZE chunks; the browser PUTs each part straight to the bucket with a
// presigned URL. That makes uploads resumable: after a dropped connection — or a
// reload, when the guest picks the same file again — only the missing parts are sent.
//
// Size limits are enforced twice: each part URL signs its exact Content-Length, so
// S3 rejects a larger body, and /complete assembles the object only when the stored
// parts add up to the announced size within the limit. Unfinished uploads are
// removed by the bucket's lifecycle rule (terraform/main.tf).
//
// Part URLs are signed by hand (SigV4 query auth, node:crypto): the presigner
// package is not guaranteed to ship with the runtime. The S3 client is.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
    S3Client,
    CreateMultipartUploadCommand,
    ListPartsCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';

const BUCKET = process.env.UPLOADS_BUCKET;
const REGION = process.env.AWS_REGION;
const DEADLINE = process.env.UPLOAD_DEADLINE;
const MAX_FILES = Number(process.env.MAX_FILES);
const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES);

const MAX_NAME_LENGTH = 60;
// 8 MiB: above S3's 5 MiB minimum for all but the last part, small enough that a
// dropped connection costs little. A 300 MB video is 38 parts.
export const PART_SIZE = 8 * 1024 * 1024;
// Part URLs expire after an hour; the page asks /resume for fresh ones when a part
// is refused, so a slow upload never stalls on an expired URL.
const URL_TTL_SECONDS = 3600;
// Uploads started before the deadline may still resume and complete this long after it.
const COMPLETE_GRACE_MS = 6 * 3600 * 1000;

// The extension decides both the stored Content-Type and the size class, so the
// same answer comes out at start, resume and complete. Browsers report an empty
// type for some formats (HEIC in desktop Chrome and Firefox), hence the fallback
// from type to extension.
const TYPE_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
    tif: 'image/tiff', tiff: 'image/tiff', dng: 'image/x-adobe-dng',
    mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v',
    '3gp': 'video/3gpp', webm: 'video/webm', avi: 'video/x-msvideo',
};
const EXT_BY_TYPE = Object.fromEntries(
    Object.entries(TYPE_BY_EXT).reverse().map(([ext, type]) => [type, ext]),
);

// Exactly the keys this function generates — nothing else can be resumed or completed.
const KEY_PATTERN = /^uploads\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[a-z0-9-]{1,40}_[0-9a-f]{8}\.([a-z0-9]{1,5})$/;

let s3 = new S3Client({ region: REGION });

// Test hook: lets a local harness substitute the S3 client.
export function setS3Client(client) {
    s3 = client;
}

// --- HTTP helpers --------------------------------------------------------------

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        body: JSON.stringify(body),
    };
}

const fail = (statusCode, error) => json(statusCode, { error });

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

function parseBody(event) {
    try {
        const raw = event.isBase64Encoded
            ? Buffer.from(event.body || '', 'base64').toString('utf8')
            : event.body || '';
        const body = JSON.parse(raw);
        if (body && typeof body === 'object') return body;
    } catch {
        // fall through
    }
    throw new HttpError(400, 'Da ist etwas durcheinandergeraten – lad die Seite bitte neu.');
}

const isOpen = (now = Date.now()) => now < Date.parse(DEADLINE);
const inGrace = (now = Date.now()) => now < Date.parse(DEADLINE) + COMPLETE_GRACE_MS;

// --- Validation ----------------------------------------------------------------

function extensionOf(name) {
    const match = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
}

const maxFor = (ext) => (TYPE_BY_EXT[ext].startsWith('video/') ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES);

// Returns { ext, contentType, max } or null when the file is not a known photo or video.
function classify(file) {
    const nameExt = extensionOf(file.name);
    const ext = TYPE_BY_EXT[nameExt] ? nameExt : EXT_BY_TYPE[String(file.type || '').toLowerCase()];
    if (!ext) return null;
    return { ext, contentType: TYPE_BY_EXT[ext], max: maxFor(ext) };
}

// Validates a { key, uploadId, size } triple from /resume or /complete.
function parseTarget(body) {
    const key = String(body.key || '');
    const uploadId = String(body.uploadId || '');
    const size = Number(body.size);
    const match = KEY_PATTERN.exec(key);
    if (!match || !TYPE_BY_EXT[match[1]] || !/^[\w.\-~]{1,1024}$/.test(uploadId)) {
        throw new HttpError(400, 'Da ist etwas durcheinandergeraten – lad die Seite bitte neu.');
    }
    const max = maxFor(match[1]);
    if (!Number.isInteger(size) || size < 1 || size > max) {
        throw new HttpError(400, 'Die Dateigröße passt nicht – lad die Seite bitte neu.');
    }
    return { key, uploadId, size, max };
}

// "Jürgen Müller" -> "juergen-mueller". Used in the key so the downloaded folder
// shows who sent each file; the untouched name travels as object metadata.
function slug(name) {
    // Letters that NFKD does not decompose into a base letter plus accent.
    const translit = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', ł: 'l', ø: 'o', æ: 'ae', œ: 'oe' };
    return name
        .toLowerCase()
        .replace(/[äöüßłøæœ]/g, (c) => translit[c])
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
}

function timestampForKey(date) {
    // 2026-10-03T19-04-11Z — sorts chronologically and is safe in every filesystem.
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

const partCount = (size) => Math.ceil(size / PART_SIZE);
const partLength = (size, n) => Math.min(PART_SIZE, size - (n - 1) * PART_SIZE);

// --- SigV4 query-string presigning ---------------------------------------------

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

// RFC 3986 encoding as SigV4 requires; encodeURIComponent leaves !'()* alone.
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signingKey(secretKey, dateStamp, region) {
    return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');
}

// Presigns an S3 request as a URL. `query` holds the operation's own parameters;
// every header in `headers` is signed, so the client must send exactly those values.
export function presignUrl({ method, key, query, headers, now = new Date(), expires = URL_TTL_SECONDS,
    credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
    } }) {
    // Regional, virtual-hosted endpoint: a new bucket can answer the global endpoint
    // with a 307 redirect for a while, which a browser request cannot follow cross-origin.
    const host = `${BUCKET}.s3.${REGION}.amazonaws.com`;
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261003T190411Z
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${REGION}/s3/aws4_request`;

    const allHeaders = { host, ...headers };
    const headerNames = Object.keys(allHeaders).map((h) => h.toLowerCase()).sort();
    const lowerHeaders = Object.fromEntries(Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), v]));

    const params = {
        ...query,
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
        'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expires),
        'X-Amz-SignedHeaders': headerNames.join(';'),
        ...(credentials.sessionToken && { 'X-Amz-Security-Token': credentials.sessionToken }),
    };
    const canonicalQuery = Object.entries(params)
        .map(([k, v]) => [rfc3986(k), rfc3986(String(v))])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');

    const canonicalUri = `/${key.split('/').map(rfc3986).join('/')}`;
    const canonicalHeaders = headerNames.map((h) => `${h}:${String(lowerHeaders[h]).trim()}\n`).join('');
    const canonicalRequest = [
        method, canonicalUri, canonicalQuery, canonicalHeaders, headerNames.join(';'), 'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, REGION))
        .update(stringToSign).digest('hex');

    return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function partUrls(key, uploadId, size, skip = new Set()) {
    const now = new Date();
    const parts = [];
    for (let n = 1; n <= partCount(size); n++) {
        if (skip.has(n)) continue;
        const length = partLength(size, n);
        parts.push({
            partNumber: n,
            size: length,
            url: presignUrl({
                method: 'PUT',
                key,
                query: { partNumber: String(n), uploadId },
                // Signed: S3 refuses a part whose body is not exactly this long.
                headers: { 'content-length': String(length) },
                now,
            }),
        });
    }
    return parts;
}

async function listParts(key, uploadId) {
    const parts = [];
    let PartNumberMarker;
    try {
        do {
            const page = await s3.send(new ListPartsCommand({
                Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumberMarker,
            }));
            parts.push(...(page.Parts ?? []));
            PartNumberMarker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
        } while (PartNumberMarker);
    } catch (error) {
        if (error.name === 'NoSuchUpload') throw new HttpError(410, 'Upload abgelaufen – tipp auf „Nochmal versuchen“, dann startet er neu.');
        throw error;
    }
    return parts;
}

// --- Routes --------------------------------------------------------------------

function config() {
    return json(200, {
        maxFiles: MAX_FILES,
        maxPhotoBytes: MAX_PHOTO_BYTES,
        maxVideoBytes: MAX_VIDEO_BYTES,
        maxNameLength: MAX_NAME_LENGTH,
        partSize: PART_SIZE,
        deadline: DEADLINE,
        open: isOpen(),
    });
}

async function start(event) {
    if (!isOpen()) throw new HttpError(403, 'Der Upload ist geschlossen.');

    const body = parseBody(event);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) throw new HttpError(400, 'Du hast keine Dateien ausgewählt.');
    if (files.length > MAX_FILES) throw new HttpError(400, `Bitte höchstens ${MAX_FILES} Dateien auf einmal.`);

    // Validate everything before starting any upload, so a refused batch leaves nothing behind.
    const planned = files.map((file) => {
        const kind = classify(file || {});
        if (!kind) throw new HttpError(400, `„${file?.name ?? '?'}“ ist leider kein Foto- oder Videoformat, das wir annehmen können.`);
        const size = Number(file.size);
        if (!Number.isInteger(size) || size < 1 || size > kind.max) {
            throw new HttpError(400, `„${file.name}“ ist leider zu groß (höchstens ${Math.round(kind.max / 1048576)} MB).`);
        }
        return { ...kind, size };
    });

    const uploader = String(body.uploader || '').trim().slice(0, MAX_NAME_LENGTH);
    const who = slug(uploader) || 'gast';
    const stamp = timestampForKey(new Date());

    const uploads = await Promise.all(planned.map(async ({ ext, contentType, size }) => {
        const key = `uploads/${stamp}_${who}_${randomBytes(4).toString('hex')}.${ext}`;
        const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
            Bucket: BUCKET,
            Key: key,
            ContentType: contentType,
            // S3 metadata travels as HTTP headers; percent-encoding keeps umlauts intact.
            ...(uploader && { Metadata: { uploader: encodeURIComponent(uploader) } }),
        }));
        return { key, uploadId: UploadId, size, partSize: PART_SIZE, parts: partUrls(key, UploadId, size) };
    }));

    return json(200, { uploads });
}

async function resume(event) {
    if (!inGrace()) throw new HttpError(403, 'Der Upload ist geschlossen.');
    const { key, uploadId, size } = parseTarget(parseBody(event));

    const stored = await listParts(key, uploadId);
    // A stored part counts only if it has the length this upload expects; anything
    // else is re-sent and overwritten.
    const done = new Set(stored
        .filter((p) => p.PartNumber <= partCount(size) && p.Size === partLength(size, p.PartNumber))
        .map((p) => p.PartNumber));

    return json(200, {
        key, uploadId, size, partSize: PART_SIZE,
        done: [...done].sort((a, b) => a - b),
        parts: partUrls(key, uploadId, size, done),
    });
}

async function complete(event) {
    if (!inGrace()) throw new HttpError(403, 'Der Upload ist geschlossen.');
    const { key, uploadId, size, max } = parseTarget(parseBody(event));

    const stored = (await listParts(key, uploadId)).sort((a, b) => a.PartNumber - b.PartNumber);
    const total = stored.reduce((sum, p) => sum + p.Size, 0);

    // A part number beyond the expected count means someone uploaded more than was
    // granted (URLs are only issued for 1..n): refuse and discard.
    if (total > max || stored.some((p) => p.PartNumber > partCount(size))) {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
        throw new HttpError(400, 'Die Datei ist zu groß – der Upload wurde verworfen.');
    }

    const complete = stored.length === partCount(size)
        && stored.every((p, i) => p.PartNumber === i + 1 && p.Size === partLength(size, i + 1));
    if (!complete) {
        // Not an error the guest caused: the page resumes and sends the missing parts.
        throw new HttpError(409, 'Upload noch nicht vollständig.');
    }

    await s3.send(new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: stored.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
    }));
    return json(200, { key, size: total });
}

async function list() {
    const files = [];
    let ContinuationToken;
    do {
        const page = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET, Prefix: 'uploads/', ContinuationToken,
        }));
        for (const object of page.Contents ?? []) {
            files.push({
                key: object.Key.slice('uploads/'.length),
                size: object.Size,
                lastModified: object.LastModified,
            });
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);

    return json(200, { files });
}

export async function handler(event) {
    const method = event.requestContext?.http?.method;
    const path = event.rawPath;

    try {
        if (method === 'GET' && path === '/api/config') return config();
        if (method === 'POST' && path === '/api/upload') return await start(event);
        if (method === 'POST' && path === '/api/upload/resume') return await resume(event);
        if (method === 'POST' && path === '/api/upload/complete') return await complete(event);
        if (method === 'GET' && path === '/admin/api/list') return await list();
        return fail(404, 'Nicht gefunden.');
    } catch (error) {
        if (error instanceof HttpError) return fail(error.statusCode, error.message);
        console.error(error);
        return fail(500, 'Da ist etwas schiefgelaufen. Versuch es bitte noch einmal.');
    }
}
