// POST helper for the Lambda API behind CloudFront, shared by the upload and login pages.
// Errors carry the HTTP status (0 = no connection) and the API's German message.

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export async function api(path, payload) {
    const body = JSON.stringify(payload);
    let response;
    try {
        response = await fetch(path, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                // CloudFront's origin access control needs the body hash for a POST
                // to the Lambda function URL; Lambda rejects unsigned payloads.
                'x-amz-content-sha256': await sha256Hex(body),
            },
            body,
        });
    } catch {
        throw new ApiError(0, 'keine Verbindung');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error || `Serverfehler ${response.status}`);
    return data;
}
