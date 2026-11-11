// src/http.ts
// A very small HTTP layer on node:http, shared by the server, the bridges and
// the browser worker. Routes are "METHOD /path" keys; a trailing "/*" matches
// any suffix. Bodies are capped at 2 MB.

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface Req {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: IncomingHttpHeaders;
    rawBody: Buffer;
    remoteAddress: string;
    // The full request URL as the client sent it (needed for Twilio signatures).
    url: string;
}

export interface Res {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
}

export type Handler = (req: Req) => Promise<Res> | Res;

const MAX_BODY = 2 * 1024 * 1024;

export function json(status: number, body: unknown): Res {
    return { status, body };
}

export function parseJson<T = Record<string, unknown>>(req: Req): T {
    try {
        return JSON.parse(req.rawBody.toString('utf8') || '{}') as T;
    } catch {
        throw new HttpError(400, 'body is not JSON');
    }
}

export function parseForm(req: Req): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(req.rawBody.toString('utf8')));
}

export class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

export function isLoopback(address: string): boolean {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function header(req: Req, name: string): string {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export function findRoute(routes: Record<string, Handler>, method: string, path: string): Handler | undefined {
    const exact = routes[`${method} ${path}`];
    if (exact) return exact;
    for (const [key, handler] of Object.entries(routes)) {
        const [routeMethod, routePath] = key.split(' ');
        if (routeMethod === method && routePath.endsWith('/*') && path.startsWith(routePath.slice(0, -1))) return handler;
    }
    return undefined;
}

export function startHttp(routes: Record<string, Handler>, port: number, host: string, onError: (message: string) => void): Server {
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                response.writeHead(413).end();
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', async () => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const req: Req = {
                method: request.method ?? 'GET',
                path: url.pathname,
                query: url.searchParams,
                headers: request.headers,
                rawBody: Buffer.concat(chunks),
                remoteAddress: request.socket.remoteAddress ?? '',
                url: request.url ?? '/',
            };
            let res: Res;
            try {
                const handler = findRoute(routes, req.method, req.path);
                res = handler ? await handler(req) : json(404, { error: 'not found' });
            } catch (error) {
                const status = error instanceof HttpError ? error.status : 500;
                if (status >= 500) onError(`${req.method} ${req.path}: ${(error as Error).message}`);
                res = json(status, { error: status >= 500 ? 'internal error' : (error as Error).message });
            }
            const isText = typeof res.body === 'string';
            const payload = res.body === undefined ? '' : isText ? (res.body as string) : JSON.stringify(res.body);
            response.writeHead(res.status, {
                'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json',
                ...res.headers,
            });
            response.end(payload);
        });
    });
    server.listen(port, host);
    return server;
}
