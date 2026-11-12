// bridges/phone/bridge.ts
// One process per iPhone line. Polls the phone's SMServer for new messages
// and forwards them to the agent server; sends replies back out the same phone.
//   POST /send {to, text?, files?, audio?}    X-Bridge-Key -> 200 {ok, verified, guid?}
//   POST /typing {to, active?}                X-Bridge-Key -> 200 {ok}  (never fails the caller)
//   POST /tapback {to, guid, kind}            X-Bridge-Key -> 200 {ok} | 501 without the tweak
//   POST /send-card {to, bundleId, ...}       X-Bridge-Key -> 200 {ok, guid} | 501 without the tweak
//   GET  /attachment?path=&key=               an inbound file, proxied from the phone
//   GET  /health                              -> {status, phone, tweak}
// Run: node bridges/phone/bridge.ts lines/phone1.env
// The line file holds that phone's settings (see lines/example.env); the
// shared .env holds BRIDGE_KEY and SERVER_URL. The tweak (ios/tweak/) is
// optional: TWEAK_URL and TWEAK_SECRET turn on tapbacks and cards, and with
// TWEAK_SSH (to copy files onto the phone) native files and voice notes.
// Without it files go through SMServer, which silently drops them on
// rootless phones, so every file send is checked on the phone.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { env, envBool, envInt, loadEnvFile, requireEnv } from '../../src/config.ts';
import { createLogger, tail } from '../../src/log.ts';
import { HttpError, header, json, parseJson, safeEqual, startHttp } from '../../src/http.ts';
import type { Req } from '../../src/http.ts';
import { createForwarder } from '../forward.ts';
import { attachmentAllowed, attachmentUrl, fileRoute, mimeFor } from '../attachments.ts';
import { parseSendRequest, parseTapbackRequest, parseTypingRequest } from '../outbound.ts';
import { createSmServer, asRowId } from './smserver.ts';
import { createTweakClient } from './tweak.ts';
import { createPhoneShell } from './ssh.ts';
import { chatsToRead, emptyState, isForwardable, isGroupChat, isPhoneAttachmentPath, pendingRows, rowAttachments, senderOf, settle } from './inbound.ts';
import type { InboundState } from './inbound.ts';

const lineFile = process.argv[2] ?? env('LINE_ENV_FILE');
if (!lineFile || !existsSync(lineFile)) throw new Error('usage: node bridges/phone/bridge.ts lines/<line>.env');
// The line file first: loadEnvFile never overwrites a variable already set.
loadEnvFile(lineFile);
loadEnvFile();

const line = requireEnv('LINE_ID');
const log = createLogger(`phone-${line}`);
const bridgeKey = requireEnv('BRIDGE_KEY');
const port = requireEnvPort();
const publicUrl = env('PHONE_BRIDGE_PUBLIC_URL', `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const statePath = env('LINE_STATE_PATH', `data/phone-${line}.json`);
const viaCurl = envBool('SMSERVER_VIA_CURL');
const phone = createSmServer({ url: requireEnv('SMSERVER_URL').replace(/\/+$/, ''), password: requireEnv('SMSERVER_PASSWORD'), viaCurl, lookback: envInt('SMSERVER_LOOKBACK', 25), socketUrl: env('SMSERVER_SOCKET_URL') });
const forward = createForwarder(env('SERVER_URL', 'http://127.0.0.1:3000'), bridgeKey);
const shell = env('TWEAK_SSH') ? createPhoneShell({ target: env('TWEAK_SSH'), key: env('TWEAK_SSH_KEY') || undefined }) : undefined;
const tweak = env('TWEAK_URL') && env('TWEAK_SECRET')
    ? createTweakClient({ url: env('TWEAK_URL'), secret: env('TWEAK_SECRET'), gameUrl: env('TWEAK_GAME_URL') || undefined, shell, stageDir: env('TWEAK_STAGE_DIR', '/var/mobile'), viaCurl })
    : null;
const SMS_ROOT = '/var/mobile/Library/SMS';

function loadState(): InboundState {
    try {
        return existsSync(statePath) ? { ...emptyState(), ...(JSON.parse(readFileSync(statePath, 'utf8')) as InboundState) } : emptyState();
    } catch {
        log.warn('state file unreadable; starting fresh from the newest messages');
        return emptyState();
    }
}

mkdirSync(dirname(statePath), { recursive: true });
const state = loadState();
const save = () => writeFileSync(statePath, JSON.stringify(state));
let lastPollAt = '';
let lastError = '';

async function bootstrap(listed: Array<{ chat: string; marker: string }>): Promise<void> {
    let newest = 0;
    for (const { chat } of listed) {
        for (const row of await phone.rows(chat, 1)) newest = Math.max(newest, asRowId(row.ROWID));
    }
    // An empty scan commits nothing: a floor of 0 would forward every text on the phone.
    if (!newest) return;
    state.floor = newest;
    for (const { chat, marker } of listed) state.markers[chat] = marker;
    state.lastFullScan = Date.now();
    save();
    log.info(`first start: ignoring history up to row ${newest}`);
}

async function pass(): Promise<void> {
    const listed = await phone.chats();
    if (!state.floor) return bootstrap(listed);
    const now = Date.now();
    for (const chat of chatsToRead(state, listed, now)) {
        let settled = true;
        for (const row of pendingRows(state, chat, await phone.rows(chat))) {
            if (isForwardable(row)) {
                const attachments = rowAttachments(row).map((file) => ({
                    url: attachmentUrl(publicUrl, bridgeKey, file.path),
                    mimeType: file.mimeType || mimeFor(file.path),
                    fileName: file.path.split('/').pop() ?? file.path,
                }));
                const result = await forward({
                    line,
                    from: senderOf(chat, row),
                    text: String(row.text ?? '').replace(/\uFFFC/g, '').trim(),
                    guid: String(row.guid ?? `${line}-${asRowId(row.ROWID)}`),
                    isGroup: isGroupChat(chat),
                    chat,
                    service: typeof row.service === 'string' ? row.service : undefined,
                    ...(attachments.length ? { attachments } : {}),
                });
                if (result === 'retry') {
                    settled = false;
                    break;
                }
                if (result === 'refused') log.warn(`server refused row ${asRowId(row.ROWID)}; skipping it`);
            }
            settle(state, chat, row);
        }
        if (settled) state.markers[chat] = listed.find((entry) => entry.chat === chat)?.marker ?? '';
    }
    if (now - state.lastFullScan >= 60_000) state.lastFullScan = now;
    save();
}

async function loop(): Promise<void> {
    const every = envInt('POLL_MS', 3000);
    for (;;) {
        try {
            await pass();
            lastPollAt = new Date().toISOString();
            lastError = '';
        } catch (error) {
            lastError = (error as Error).message;
            log.warn(`poll failed: ${lastError}`);
        }
        await sleep(lastError ? every * 3 : every);
    }
}

function requireKey(req: Req): void {
    if (!safeEqual(header(req, 'x-bridge-key'), bridgeKey)) throw new HttpError(401, 'bad bridge key');
}

function requireTweak() {
    if (!tweak) throw new HttpError(501, 'this line has no tweak (set TWEAK_URL and TWEAK_SECRET in the line file)');
    return tweak;
}

const CARD_FIELDS = ['bundleId', 'payloadBase64', 'payloadFile', 'imageFile', 'breadcrumb', 'replyToGuid'];

const server = startHttp({
    'GET /health': async () => {
        const [phoneUp, tweakUp] = await Promise.all([phone.ping().catch(() => false), tweak ? tweak.ping() : Promise.resolve(null)]);
        const ok = phoneUp && !lastError;
        return json(ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', line, phone: phoneUp ? 'up' : 'down', tweak: tweakUp === null ? 'off' : tweakUp ? 'up' : 'down', lastPollAt, lastError });
    },
    'POST /send': async (req) => {
        requireKey(req);
        const { to, text, files, audio } = parseSendRequest(parseJson(req));
        // The tweak sends files already on the phone: it needs TWEAK_SSH to copy them there.
        const tweakFiles = tweak && shell ? tweak : null;
        if (audio && !tweakFiles) throw new HttpError(501, 'native voice notes need TWEAK_URL, TWEAK_SECRET and TWEAK_SSH on this line');
        try {
            if (!files.length) {
                const result = await phone.send(to, text, (ms) => sleep(ms));
                if (!result.verified) log.warn(`send to ${tail(to)} accepted but not seen on the phone yet`);
                return json(200, { ok: true, verified: result.verified });
            }
            if (tweakFiles) {
                const result = await tweakFiles.sendPhoto(to, files, { audio, text });
                return json(200, { ok: true, verified: result.verified, guid: result.guid });
            }
            const result = await phone.sendFiles(to, text, files, (ms) => sleep(ms));
            if (result.verified === false) {
                log.error(`send to ${tail(to)}: SMServer took ${files.length} file(s) but they never showed on the phone`);
                throw new HttpError(502, 'the files did not land on the phone');
            }
            return json(200, { ok: true, verified: result.verified === true });
        } catch (error) {
            if (error instanceof HttpError) throw error;
            log.error(`send to ${tail(to)} failed: ${(error as Error).message}`);
            throw new HttpError(502, 'send failed');
        }
    },
    // A typing bubble is a nicety: past the key and body checks this never fails.
    'POST /typing': async (req) => {
        requireKey(req);
        const { to, active } = parseTypingRequest(parseJson(req));
        try {
            const { upgraded } = await phone.typing(to, active);
            return json(200, { ok: upgraded });
        } catch (error) {
            log.warn(`typing for ${tail(to)} failed: ${(error as Error).message}`);
            return json(200, { ok: false });
        }
    },
    // SMServer's own tapback runs off SpringBoard's queue and crashed it on
    // iOS 15, so tapbacks go through the tweak only.
    'POST /tapback': async (req) => {
        requireKey(req);
        const { to, guid, kind } = parseTapbackRequest(parseJson(req));
        const client = requireTweak();
        try {
            await client.sendTapback({ to, guid, type: kind });
        } catch (error) {
            log.warn(`tapback to ${tail(to)} failed: ${(error as Error).message}`);
            throw new HttpError(502, 'tapback failed');
        }
        return json(200, { ok: true });
    },
    // imageFile present: an app card with an inline image (/poc/send-card);
    // otherwise an imageless balloon such as a game move (/poc/send-balloon).
    'POST /send-card': async (req) => {
        requireKey(req);
        const body = parseJson(req);
        const to = String(body.to ?? '').trim();
        const fields: Record<string, string> = { to };
        for (const name of CARD_FIELDS) if (typeof body[name] === 'string' && body[name]) fields[name] = body[name] as string;
        if (!to || !fields.bundleId || !(fields.payloadBase64 || fields.payloadFile)) throw new HttpError(400, 'to, bundleId and payloadBase64 or payloadFile are required');
        const client = requireTweak();
        try {
            const result = fields.imageFile ? await client.sendCard(fields) : await client.sendBalloon(fields);
            return json(200, { ok: true, guid: result.guid });
        } catch (error) {
            log.warn(`card to ${tail(to)} failed: ${(error as Error).message}`);
            throw new HttpError(502, 'card send failed');
        }
    },
}, port, '127.0.0.1', (m) => log.error(m));

// Inbound files: SMServer's /data first; rootless phones answer 404 there for
// every Attachments/ path, so then the file is pulled over SSH when TWEAK_SSH
// is set. Only Messages attachments: /data reads any file SMServer can see.
fileRoute(server, '/attachment', async (query, headers) => {
    const path = query.get('path') ?? '';
    if (!attachmentAllowed(bridgeKey, path, query.get('key') ?? '', String(headers['x-bridge-key'] ?? ''))) return { status: 401, error: 'bad key' };
    if (!isPhoneAttachmentPath(path)) return { status: 403, error: 'not a Messages attachment' };
    try {
        const { bytes, contentType } = await phone.fetchAttachment(path);
        return { status: 200, contentType, bytes };
    } catch (error) {
        if (!shell) {
            log.warn(`attachment fetch failed: ${(error as Error).message}`);
            return { status: 502, error: 'the phone did not serve the file' };
        }
    }
    const scratch = mkdtempSync(join(tmpdir(), 'vq-attachment-'));
    try {
        const local = join(scratch, 'file');
        await shell.copyFrom(`${SMS_ROOT}/${path}`, local);
        return { status: 200, contentType: mimeFor(path), bytes: readFileSync(local) };
    } catch (error) {
        log.warn(`attachment pull over SSH failed: ${(error as Error).message}`);
        return { status: 502, error: 'the phone did not serve the file' };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}, (m) => log.error(m));

function requireEnvPort(): number {
    const value = envInt('PHONE_BRIDGE_PORT', 0);
    if (!value) throw new Error('PHONE_BRIDGE_PORT is not set in the line file');
    return value;
}

log.info(`line ${line} polling ${env('SMSERVER_URL')}${tweak ? ' with the tweak' : ''}`);
void loop();
