// bridges/phone/smserver.ts
// Client for SMServer, the open-source app that serves a jailbroken iPhone's
// Messages over HTTP (github.com/iandwelker/smserver). Default port 8741.
// The calls this uses:
//   GET  /requests?password=<pw>                    log in; answers "true"
//   GET  /requests?chats=40                          newest chats
//   GET  /requests?messages=<chat>&num_messages=N&read_messages=false
//                                                    a chat's newest rows, newest first
//   POST /send   multipart: chat, text               send a message
//
// sms.db facts this leans on: ROWIDs come from one sequence for the whole
// phone and only go up; is_from_me is 0/1; item_type is 0 for a normal text.
//
// TRANSPORT. Plain fetch by default. Set SMSERVER_VIA_CURL=1 if this process
// cannot reach the phone's LAN address directly but a shell can (seen with
// pm2-launched processes on macOS, which failed with "No route to host" while
// curl from a terminal worked). Then every call shells out to curl.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type SmsRow = Record<string, unknown>;

export interface SmServerConfig {
    url: string;
    password: string;
    viaCurl: boolean;
    lookback: number;
    fetchImpl?: typeof fetch;
}

interface Answer {
    status: number;
    body: string;
}

const AUTH_REUSE_MS = 60_000;

export function asRowId(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value.trim());
    return 0;
}

export function isFromMe(row: SmsRow): boolean {
    return row.is_from_me === true || row.is_from_me === 1 || row.is_from_me === '1';
}

export function normalizeText(value: unknown): string {
    return String(value ?? '').normalize('NFKC').replace(/\r\n/g, '\n').trim();
}

export function multipartForm(fields: Record<string, string>): { body: Buffer; boundary: string } {
    const boundary = `----bridge-${randomUUID().replace(/-/g, '')}`;
    const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    return { body: Buffer.from(`${parts.join('')}--${boundary}--\r\n`, 'utf8'), boundary };
}

function curl(method: string, url: string, headers: Record<string, string>, body: Buffer | undefined, timeoutSeconds: number): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const marker = '\n__STATUS__';
        const args = ['-s', '-S', '--max-time', String(timeoutSeconds), '-X', method, '-w', `${marker}%{http_code}`];
        for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
        if (body) args.push('--data-binary', '@-');
        args.push(url);
        const child = spawn('curl', args, { stdio: [body ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        let err = '';
        child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => {
            err += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            const text = Buffer.concat(out).toString('utf8');
            const at = text.lastIndexOf(marker);
            if (code !== 0 || at < 0) {
                reject(new Error(`curl exit ${code}: ${err.trim().slice(0, 200)}`));
                return;
            }
            resolve({ status: Number(text.slice(at + marker.length)) || 0, body: text.slice(0, at) });
        });
        if (body && child.stdin) child.stdin.end(body);
    });
}

export function createSmServer(config: SmServerConfig) {
    const fetchImpl = config.fetchImpl ?? fetch;
    let authedAt = 0;

    async function request(method: string, path: string, options: { headers?: Record<string, string>; body?: Buffer; timeoutSeconds?: number } = {}): Promise<Answer> {
        const url = `${config.url}${path}`;
        const timeoutSeconds = options.timeoutSeconds ?? 15;
        try {
            const answer = config.viaCurl
                ? await curl(method, url, options.headers ?? {}, options.body, timeoutSeconds)
                : await fetchImpl(url, { method, headers: options.headers, body: options.body ? new Uint8Array(options.body) : undefined, signal: AbortSignal.timeout(timeoutSeconds * 1000) })
                    .then(async (r) => ({ status: r.status, body: await r.text() }));
            // A respring on the phone kills the login; the next call logs in again.
            if (answer.status === 401 || answer.status === 403) authedAt = 0;
            return answer;
        } catch (error) {
            authedAt = 0;
            throw error;
        }
    }

    async function getJson(params: Record<string, string | number>, timeoutSeconds = 15): Promise<unknown> {
        const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
        const answer = await request('GET', `/requests?${query}`, { timeoutSeconds });
        if (answer.status < 200 || answer.status >= 300) throw new Error(`SMServer GET answered ${answer.status}`);
        const head = answer.body.trim();
        return head.startsWith('{') || head.startsWith('[') ? JSON.parse(answer.body) : answer.body;
    }

    async function authenticate(): Promise<void> {
        if (Date.now() - authedAt < AUTH_REUSE_MS) return;
        const result = await getJson({ password: config.password }, 8);
        if (String(result).trim().toLowerCase() !== 'true') throw new Error('SMServer rejected the password');
        authedAt = Date.now();
    }

    // The newest chats, each with a marker that changes when the chat does.
    async function chats(): Promise<Array<{ chat: string; marker: string }>> {
        await authenticate();
        const data = (await getJson({ chats: 40 }, 12)) as { chats?: SmsRow[] };
        return (Array.isArray(data?.chats) ? data.chats : [])
            .map((entry) => ({ chat: String(entry.chat_identifier ?? '').trim(), marker: JSON.stringify([entry.time_marker ?? null, entry.has_unread ?? null, entry.latest_text ?? null]) }))
            .filter((entry) => entry.chat);
    }

    // read_messages=false: polling must never send anyone a read receipt.
    async function rows(chat: string, count = config.lookback): Promise<SmsRow[]> {
        await authenticate();
        const data = (await getJson({ messages: chat, num_messages: count, read_messages: 'false' })) as { texts?: SmsRow[] };
        return Array.isArray(data?.texts) ? data.texts.filter((row) => row && typeof row === 'object') : [];
    }

    async function newestOutbound(chat: string, text: string): Promise<number> {
        const expected = normalizeText(text);
        return (await rows(chat, 20))
            .filter((row) => isFromMe(row) && normalizeText(row.text) === expected)
            .reduce((max, row) => Math.max(max, asRowId(row.ROWID)), 0);
    }

    // Sends, then looks for the row on the phone. SMServer's 200 alone does not
    // prove a send: the phone's own list is the honest witness.
    async function send(chat: string, text: string, sleep: (ms: number) => Promise<void>): Promise<{ verified: boolean }> {
        await authenticate();
        const before = await newestOutbound(chat, text).catch(() => 0);
        const { body, boundary } = multipartForm({ chat, text });
        const answer = await request('POST', '/send', { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, timeoutSeconds: 30 });
        if (answer.status < 200 || answer.status >= 300) throw new Error(`SMServer /send answered ${answer.status}`);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await sleep(1000);
            if ((await newestOutbound(chat, text).catch(() => 0)) > before) return { verified: true };
        }
        return { verified: false };
    }

    async function ping(): Promise<boolean> {
        const answer = await request('GET', '/', { timeoutSeconds: 6 });
        return answer.status === 200;
    }

    return { chats, rows, send, ping };
}

export type SmServer = ReturnType<typeof createSmServer>;
