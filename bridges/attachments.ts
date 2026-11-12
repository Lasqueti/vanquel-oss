// bridges/attachments.ts
// Inbound files, shared by both bridges. A person's photo or voice note is
// never copied to the agent server: the bridge forwards a link to its own
//   GET /attachment?path=<path>&key=<key>
// and streams the file when the server asks for it.
//
// THE KEY in the link is an HMAC of the path under BRIDGE_KEY, so a link opens
// that one file and nothing else, and BRIDGE_KEY itself never lands in a URL
// or a log. A request may instead send the full key as X-Bridge-Key.
//
// WHY A FILE ROUTE. src/http.ts answers with JSON or text only. fileRoute()
// puts one GET path in front of the server startHttp built, streams bytes for
// it, and hands every other request to the original handler unchanged.

import { createHmac } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { basename, extname, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { safeEqual } from '../src/http.ts';

export interface InboundAttachment {
    url: string;
    mimeType: string;
    fileName: string;
}

const MIME: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.heic': 'image/heic', '.heif': 'image/heif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.m4a': 'audio/mp4', '.caf': 'audio/x-caf', '.mp3': 'audio/mpeg', '.wav': 'audio/x-wav', '.amr': 'audio/amr',
    '.pdf': 'application/pdf', '.vcf': 'text/vcard', '.txt': 'text/plain', '.json': 'application/json',
};

export function mimeFor(fileName: string): string {
    return MIME[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

export function attachmentKey(bridgeKey: string, path: string): string {
    return createHmac('sha256', bridgeKey).update(path, 'utf8').digest('hex').slice(0, 32);
}

export function attachmentUrl(baseUrl: string, bridgeKey: string, path: string): string {
    return `${baseUrl}/attachment?${new URLSearchParams({ path, key: attachmentKey(bridgeKey, path) })}`;
}

// True when the request may read `path`: the link's own key, or the bridge key.
export function attachmentAllowed(bridgeKey: string, path: string, key: string, headerKey: string): boolean {
    if (headerKey && safeEqual(headerKey, bridgeKey)) return true;
    return Boolean(key) && safeEqual(key, attachmentKey(bridgeKey, path));
}

// The real path of `requested` when it is a file inside `root`, else null.
// realpath on both sides, so neither "../" nor a symlink can step outside.
export function pathInside(root: string, requested: string): string | null {
    try {
        const realRoot = realpathSync(root);
        const real = realpathSync(requested);
        return real.startsWith(realRoot + sep) ? real : null;
    } catch {
        return null;
    }
}

export type FileReply =
    | { status: number; error: string }
    | { status: 200; contentType: string; bytes: Buffer }
    | { status: 200; contentType: string; stream: Readable };

export type FileHandler = (query: URLSearchParams, headers: IncomingHttpHeaders) => Promise<FileReply>;

export function fileRoute(server: Server, path: string, handler: FileHandler, onError: (message: string) => void): void {
    const original = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method !== 'GET' || url.pathname !== path) {
            for (const listener of original) listener.call(server, req, res);
            return;
        }
        req.resume();
        handler(url.searchParams, req.headers)
            .then((reply) => {
                if ('error' in reply) {
                    res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: reply.error }));
                } else if ('bytes' in reply) {
                    res.writeHead(200, { 'Content-Type': reply.contentType, 'Content-Length': String(reply.bytes.length) }).end(reply.bytes);
                } else {
                    res.writeHead(200, { 'Content-Type': reply.contentType });
                    reply.stream.on('error', () => res.destroy());
                    reply.stream.pipe(res);
                }
            })
            .catch((error: unknown) => {
                onError(`GET ${path}: ${(error as Error).message}`);
                if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'internal error' }));
            });
    });
}

// GET /attachment for files on this Mac: the link's key, then a real path
// inside root. resolve turns the stored path into a filesystem one (~/...).
export function localAttachmentHandler(root: string, bridgeKey: string, resolve: (path: string) => string = (path) => path): FileHandler {
    return async (query, headers) => {
        const requested = query.get('path') ?? '';
        if (!attachmentAllowed(bridgeKey, requested, query.get('key') ?? '', String(headers['x-bridge-key'] ?? ''))) return { status: 401, error: 'bad key' };
        const real = pathInside(root, resolve(requested));
        if (!real) return { status: 403, error: 'not an attachment' };
        return { status: 200, contentType: mimeFor(basename(real)), stream: createReadStream(real) };
    };
}
