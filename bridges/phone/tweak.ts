// bridges/phone/tweak.ts
// Client for the on-phone tweak (ios/tweak/, port 8799): native cards and
// balloons, photos and voice notes as native attachments, tapbacks, plain
// text into groups, and two read-only sms.db reads (message status, inbound
// GamePigeon cards). Nothing here touches SMServer.
//
// PROTOCOL. Form-encoded POSTs and plain GETs with the shared secret in an
// X-Tweak-Secret header. The tweak answers plain text: "OK ..." (often with
// guid=<message guid>) or "ERR ...". An ERR, or any status but 2xx, throws.
//
// FILES. The tweak sends files that are already ON the phone. With a `shell`
// (TWEAK_SSH in the line file) every local file is copied to the phone's
// stage dir first, mode 0644 (a 0600 copy can land where SpringBoard, running
// as mobile, cannot read it), and removed after the tweak answers (it copies
// what it keeps first). Without one, paths are passed through as phone paths.
//
// VERIFY. sendMessage: on the phone only proves a local insert. After a photo
// send, /poc/message-status reads the phone's own sms.db: attachments=<n> is
// how many files the ONE message carries, which is what proves a stacked
// bundle landed whole.
//
// GAMES. iOS 15 inserts a GamePigeon balloon sent from SpringBoard but never
// transports it; MobileSMS can. With `gameUrl` (TWEAK_GAME_URL, :8800)
// balloons go to MobileSMS's listener, relaunching Messages over SSH when iOS
// has suspended it.

import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { curl } from './smserver.ts';
import { safeSuffix, shellQuote } from './ssh.ts';
import type { PhoneShell } from './ssh.ts';

export interface TweakConfig {
    url: string;
    secret: string;
    fetchImpl?: typeof fetch;
    // Optional extras, all off unless set:
    gameUrl?: string;
    shell?: PhoneShell;
    stageDir?: string;
    viaCurl?: boolean;
    sleep?: (ms: number) => Promise<void>;
}

export interface GameRow {
    rowId: number;
    guid: string;
    chat: string;
    isFromMe: boolean;
    payloadBase64: string;
    balloonBundleId: string;
    [key: string]: unknown;
}

export interface MessageStatus {
    found: boolean;
    rowId: number;
    sent: boolean;
    delivered: boolean;
    error: number;
    attachments: number | null;
}

// "OK found=1 rowid=812 sent=1 delivered=0 error=0 attachments=3", or null
// for an ERR or anything else.
export function parseMessageStatus(text: string): MessageStatus | null {
    if (!text.startsWith('OK found=')) return null;
    const values = new Map([...text.matchAll(/\b(\w+)=(-?\d+)/g)].map((match) => [match[1], Number(match[2])]));
    return {
        found: values.get('found') === 1,
        rowId: values.get('rowid') ?? 0,
        sent: values.get('sent') === 1,
        delivered: values.get('delivered') === 1,
        error: values.get('error') ?? 0,
        attachments: values.get('attachments') ?? null,
    };
}

export function parseReply(endpoint: string, status: number, body: string): { guid: string | null; raw: string } {
    const raw = body.trim();
    if (status < 200 || status >= 300) throw new Error(`tweak ${endpoint} answered ${status}: ${raw.slice(0, 200)}`);
    if (!raw.startsWith('OK')) throw new Error(`tweak ${endpoint} refused: ${raw.slice(0, 200)}`);
    return { guid: /\bguid=(\S+)/.exec(raw)?.[1] ?? null, raw };
}

// One row of /poc/read-games ({rowid, guid, chatGuid, bundleId, payloadB64}),
// with the tweak's own fields kept alongside.
export function toGameRow(raw: Record<string, unknown>): GameRow {
    return {
        ...raw,
        rowId: Number(raw.rowid ?? raw.rowId ?? 0),
        guid: String(raw.guid ?? ''),
        chat: String(raw.chatGuid ?? raw.chat ?? ''),
        isFromMe: raw.isFromMe === true || raw.is_from_me === 1,
        payloadBase64: String(raw.payloadB64 ?? raw.payloadBase64 ?? ''),
        balloonBundleId: String(raw.bundleId ?? raw.balloonBundleId ?? ''),
    };
}

const RETRYABLE_TAPBACK = ['ERR could not resolve chat', 'ERR message item not loaded'];

function isLocalFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

export function createTweakClient(config: TweakConfig) {
    const fetchImpl = config.fetchImpl ?? fetch;
    const sleep = config.sleep ?? ((ms: number) => delay(ms));
    const base = config.url.replace(/\/+$/, '');
    const stageDir = (config.stageDir ?? '/var/mobile').replace(/\/+$/, '');

    async function http(method: 'GET' | 'POST', url: string, timeoutSeconds: number, fields?: Record<string, string>): Promise<{ status: number; body: string }> {
        const headers: Record<string, string> = { 'X-Tweak-Secret': config.secret };
        const body = fields ? new URLSearchParams(fields).toString() : undefined;
        if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        if (config.viaCurl) return curl(method, url, headers, body === undefined ? undefined : Buffer.from(body, 'utf8'), timeoutSeconds);
        const response = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutSeconds * 1000) });
        return { status: response.status, body: await response.text() };
    }

    async function post(endpoint: string, fields: Record<string, string>, timeoutSeconds: number, at = base) {
        const { status, body } = await http('POST', `${at}${endpoint}`, timeoutSeconds, fields);
        return parseReply(endpoint, status, body);
    }

    // Local files onto the phone. Returns the phone paths and a cleanup.
    async function stage(files: string[], kind: string): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
        const shell = config.shell;
        if (!shell) return { paths: files, cleanup: async () => {} };
        const stamp = `${Math.trunc(Date.now() / 1000)}_${randomBytes(4).toString('hex')}`;
        const scratch = mkdtempSync(join(tmpdir(), 'vq-stage-'));
        const staged: string[] = [];
        const cleanup = async () => {
            rmSync(scratch, { recursive: true, force: true });
            if (staged.length) await shell.exec(`rm -f ${staged.map(shellQuote).join(' ')}`).catch(() => undefined);
        };
        try {
            for (const [index, file] of files.entries()) {
                const local = join(scratch, `${index}-${basename(file)}`);
                copyFileSync(file, local);
                chmodSync(local, 0o644);
                const remote = `${stageDir}/vq-${kind}-${stamp}-${index}${safeSuffix(file, '.bin')}`;
                await shell.copyTo(local, remote);
                staged.push(remote);
            }
        } catch (error) {
            await cleanup();
            throw error;
        }
        return { paths: staged, cleanup };
    }

    // Stage the named fields that point at local files.
    async function stageFields(fields: Record<string, string>, names: string[]) {
        const local = names.filter((name) => fields[name] && config.shell && isLocalFile(fields[name]));
        const { paths, cleanup } = await stage(local.map((name) => fields[name]), 'card');
        const out = { ...fields };
        local.forEach((name, index) => {
            out[name] = paths[index];
        });
        return { fields: out, cleanup };
    }

    async function ping(at = base, host = ''): Promise<boolean> {
        try {
            const { status, body } = await http('GET', `${at}/poc/ping`, 5);
            return status === 200 && body.startsWith('pong') && (!host || body.includes(`host=${host}`));
        } catch {
            return false;
        }
    }

    async function messageStatus(guid: string): Promise<string> {
        const { status, body } = await http('GET', `${base}/poc/message-status?guid=${encodeURIComponent(guid)}`, 10);
        if (status < 200 || status >= 300) throw new Error(`tweak /poc/message-status answered ${status}`);
        return body.trim();
    }

    // Polls message-status until `done` says yes, the phone reports an error,
    // or the time runs out. null when sms.db could not be read at all.
    async function waitForStatus(guid: string, done: (status: MessageStatus) => boolean, attempts = 15, intervalMs = 1000): Promise<MessageStatus | null> {
        let last: MessageStatus | null = null;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            await sleep(intervalMs);
            const text = await messageStatus(guid).catch(() => '');
            const status = parseMessageStatus(text);
            if (!status) continue;
            last = status;
            if (status.error !== 0) throw new Error(`the phone reports error=${status.error} for ${guid}`);
            if (done(status)) return status;
        }
        return last;
    }

    // MobileSMS's listener, cold-relaunching Messages when iOS suspended it.
    async function gameBase(): Promise<string> {
        const gameUrl = config.gameUrl?.replace(/\/+$/, '');
        if (!gameUrl) return base;
        if (await ping(gameUrl, 'MobileSMS')) return gameUrl;
        if (config.shell) await config.shell.exec("killall MobileSMS 2>/dev/null; sleep 1; uiopen 'sms:'", 25_000).catch(() => undefined);
        for (let attempt = 0; attempt < 24; attempt += 1) {
            if (await ping(gameUrl, 'MobileSMS')) return gameUrl;
            await sleep(500);
        }
        throw new Error('the MobileSMS game listener did not come up');
    }

    // POST /poc/send-balloon: to, bundleId, payloadBase64 or payloadFile,
    // breadcrumb, replyToGuid (the move this one updates in place).
    async function sendBalloon(fields: Record<string, string>): Promise<{ guid: string | null; raw: string }> {
        const staged = await stageFields(fields, ['payloadFile']);
        try {
            return await post('/poc/send-balloon', staged.fields, 45, await gameBase());
        } finally {
            await staged.cleanup();
        }
    }

    // POST /poc/send-card: to, bundleId, payloadFile or payloadBase64,
    // imageFile (the inline card image), breadcrumb.
    async function sendCard(fields: Record<string, string>): Promise<{ guid: string | null; raw: string }> {
        const staged = await stageFields(fields, ['payloadFile', 'imageFile']);
        try {
            return await post('/poc/send-card', staged.fields, 45);
        } finally {
            await staged.cleanup();
        }
    }

    // Files on ONE message (a stacked bundle), or with audio one file as a
    // native voice note. Text, if any, goes first as its own message.
    async function sendPhoto(to: string, filePaths: string[], options: { audio?: boolean; text?: string } = {}): Promise<{ guid: string | null; raw: string; verified: boolean }> {
        const files = filePaths.filter(Boolean);
        if (!files.length) throw new Error('no files to send');
        if (options.audio && files.length !== 1) throw new Error('a voice note is exactly one file');
        if (options.text?.trim()) await post('/poc/send-text', { to, text: options.text.trim() }, 30);
        const { paths, cleanup } = await stage(files, options.audio ? 'voice' : 'photo');
        let reply: { guid: string | null; raw: string };
        try {
            const fields: Record<string, string> = { to };
            if (paths.length > 1) fields.filePaths = paths.join('|');
            else fields.filePath = paths[0];
            if (options.audio) fields.audio = '1';
            reply = await post('/poc/send-photo', fields, 45 + 20 * (paths.length - 1));
        } finally {
            await cleanup();
        }
        if (!reply.guid) return { ...reply, verified: false };
        const status = await waitForStatus(reply.guid, (s) => s.found && (s.attachments === null || s.attachments >= files.length));
        if (status?.found && status.attachments !== null && status.attachments < files.length) {
            throw new Error(`only ${status.attachments} of ${files.length} file(s) landed on the phone (guid ${reply.guid})`);
        }
        return { ...reply, verified: Boolean(status?.found) };
    }

    // POST /poc/send-tapback: to, guid, type. A message that just arrived can
    // beat the phone's lookup by a few seconds, so only the tweak's explicit
    // lookup failures are retried (0.5, 1, 2, 4 s): nothing was sent yet.
    async function sendTapback(fields: Record<string, string>): Promise<string> {
        for (let attempt = 0; ; attempt += 1) {
            const { status, body } = await http('POST', `${base}/poc/send-tapback`, 15, fields);
            const raw = body.trim();
            if (status >= 200 && status < 300 && raw.startsWith('OK')) return raw;
            if (status === 200 && attempt < 4 && RETRYABLE_TAPBACK.some((prefix) => raw.startsWith(prefix))) {
                await sleep(500 * 2 ** attempt);
                continue;
            }
            throw new Error(`tweak /poc/send-tapback refused (${status}): ${raw.slice(0, 200)}`);
        }
    }

    // Inbound GamePigeon cards newer than afterRowId, oldest first.
    async function readGames(afterRowId: number, limit: number): Promise<GameRow[]> {
        const { status, body } = await http('GET', `${base}/poc/read-games?afterRowid=${Math.trunc(afterRowId)}&limit=${Math.trunc(limit)}`, 20);
        const text = body.trim();
        if (status < 200 || status >= 300) throw new Error(`tweak /poc/read-games answered ${status}: ${text.slice(0, 200)}`);
        if (text.startsWith('ERR')) throw new Error(`tweak /poc/read-games: ${text.slice(0, 200)}`);
        let rows: unknown;
        try {
            rows = JSON.parse(text);
        } catch (error) {
            throw new Error(`tweak /poc/read-games sent bad JSON: ${(error as Error).message}`);
        }
        return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object').map(toGameRow) : [];
    }

    // POST /poc/send-text: plain text by the tweak, which also reaches an
    // existing group (pass its iMessage;+;chat... guid).
    async function sendText(to: string, text: string): Promise<{ guid: string | null; raw: string }> {
        return post('/poc/send-text', { to, text }, 30);
    }

    return {
        ping: () => ping(),
        sendBalloon, sendCard, sendPhoto, sendTapback, messageStatus, readGames,
        sendText, waitForStatus,
    };
}

export type TweakClient = ReturnType<typeof createTweakClient>;
