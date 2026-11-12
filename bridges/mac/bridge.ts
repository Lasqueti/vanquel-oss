// bridges/mac/bridge.ts
// The Mac line: this Mac mini's own Messages account as an iMessage line.
//   inbound   watcher.ts reads chat.db and forwards to the agent server
//   POST /send     {to, text?, files?, audio?}   X-Bridge-Key -> 200 {ok}
//   POST /typing   {to, active?}                 X-Bridge-Key -> 200 {ok} | 501 (MAC_TYPING off)
//   POST /tapback  {to, guid, kind}              X-Bridge-Key -> 200 {ok} | 501 (applescript)
//   GET  /attachment?path=&key=                  an inbound file, from ~/Library/Messages/Attachments only
//   GET  /health
// sender.ts does the sending. Needs Full Disk Access for the Node binary (to
// read chat.db), and a signed-in Messages.app. See docs/MAC-MINI.md.
// Run: npm run bridge:mac

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { env, envBool, envInt, loadEnvFile, requireEnv } from '../../src/config.ts';
import { createLogger, tail } from '../../src/log.ts';
import { HttpError, header, json, parseJson, safeEqual, startHttp } from '../../src/http.ts';
import type { Req } from '../../src/http.ts';
import { createForwarder } from '../forward.ts';
import { attachmentUrl, fileRoute, localAttachmentHandler } from '../attachments.ts';
import { parseSendRequest, parseTapbackRequest, parseTypingRequest } from '../outbound.ts';
import { createWatcher, expandHome } from './watcher.ts';
import type { WatcherState } from './watcher.ts';
import { NotSupported, createSender, defaultRun, tapbackCommand, typingCommand } from './sender.ts';
import type { SendVia } from './sender.ts';

loadEnvFile();
const log = createLogger('mac-bridge');
const line = env('MAC_LINE_ID', 'mac');
const bridgeKey = requireEnv('BRIDGE_KEY');
const port = envInt('MAC_BRIDGE_PORT', 3101);
const publicUrl = env('MAC_BRIDGE_PUBLIC_URL', `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const dbPath = env('MESSAGES_DB_PATH', join(homedir(), 'Library/Messages/chat.db'));
const attachmentsRoot = env('MESSAGES_ATTACHMENTS_PATH', join(homedir(), 'Library/Messages/Attachments'));
const statePath = env('MAC_STATE_PATH', 'data/mac-bridge.json');

function loadState(): WatcherState {
    try {
        return existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as WatcherState) : { cursor: 0 };
    } catch {
        log.warn(`state file unreadable; starting from the newest message`);
        return { cursor: 0 };
    }
}

mkdirSync(dirname(statePath), { recursive: true });
const db = new DatabaseSync(dbPath, { readOnly: true });
const watcher = createWatcher({
    db,
    line,
    forward: createForwarder(env('SERVER_URL', 'http://127.0.0.1:3000'), bridgeKey),
    state: loadState(),
    save: (state) => writeFileSync(statePath, JSON.stringify(state)),
    log: (m) => log.info(m),
    attachmentUrl: (path) => attachmentUrl(publicUrl, bridgeKey, path),
});
watcher.initialize();

let lastScanError = '';
let lastScanAt = '';
async function scan(): Promise<void> {
    try {
        const count = await watcher.scan();
        if (count) log.info(`forwarded ${count} message(s)`);
        lastScanError = '';
        lastScanAt = new Date().toISOString();
    } catch (error) {
        lastScanError = (error as Error).message;
        log.error(`scan failed: ${lastScanError}`);
    }
}

// fs.watch catches most writes at once; the interval catches the rest.
let debounce: NodeJS.Timeout | undefined;
watch(dirname(dbPath), (_event, name) => {
    if (name && !String(name).startsWith('chat.db')) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => void scan(), 250);
});
setInterval(() => void scan(), envInt('MAC_POLL_MS', 2000));

const senderOptions = { via: env('MAC_SEND_VIA', 'imsg') as SendVia, imsgPath: env('IMSG_PATH', 'imsg') };
const send = createSender({ ...senderOptions, timeoutMs: envInt('MAC_SEND_TIMEOUT_MS', 30_000) });

// ---- Typing ----
// Messages.app is regularly slow to answer, and a typing bubble is a nicety:
// off unless MAC_TYPING=1, one at a time, a 5 s limit, and a minute's rest
// after a failure so a wedged Messages is not hammered.
const typingEnabled = envBool('MAC_TYPING');
let typingBusy = false;
let typingRestUntil = 0;
async function typing(to: string): Promise<{ ok: boolean; reason?: string }> {
    if (typingBusy) return { ok: false, reason: 'busy' };
    if (Date.now() < typingRestUntil) return { ok: false, reason: 'resting after a failure' };
    typingBusy = true;
    try {
        const { command, args } = typingCommand(senderOptions, to);
        const result = await defaultRun(command, args, 5_000);
        if (result.code === 0) return { ok: true };
        typingRestUntil = Date.now() + 60_000;
        log.warn(`typing for ${tail(to)} failed (exit ${result.code}); resting a minute`);
        return { ok: false, reason: 'failed' };
    } finally {
        typingBusy = false;
    }
}

function requireKey(req: Req): void {
    if (!safeEqual(header(req, 'x-bridge-key'), bridgeKey)) throw new HttpError(401, 'bad bridge key');
}

const server = startHttp({
    'GET /health': () => json(lastScanError ? 503 : 200, { status: lastScanError ? 'degraded' : 'ok', line, lastScanAt, lastError: lastScanError }),
    'POST /send': async (req) => {
        requireKey(req);
        const { to, text, files, audio } = parseSendRequest(parseJson(req));
        try {
            await send(to, text, { files, audio });
        } catch (error) {
            if (error instanceof NotSupported) throw new HttpError(501, error.message);
            log.error(`send to ${tail(to)} failed: ${(error as Error).message}`);
            throw new HttpError(502, 'send failed');
        }
        return json(200, { ok: true });
    },
    // Never throws to the caller past the key and body checks: typing is a nicety.
    'POST /typing': async (req) => {
        requireKey(req);
        const { to, active } = parseTypingRequest(parseJson(req));
        if (!typingEnabled || senderOptions.via !== 'imsg') return json(501, { ok: false, error: 'typing is off on this line (MAC_TYPING=1 with imsg turns it on)' });
        if (!active) return json(200, { ok: true });
        try {
            return json(200, await typing(to));
        } catch (error) {
            log.warn(`typing for ${tail(to)}: ${(error as Error).message}`);
            return json(200, { ok: false, reason: 'failed' });
        }
    },
    'POST /tapback': async (req) => {
        requireKey(req);
        const { to, guid, kind } = parseTapbackRequest(parseJson(req));
        let command;
        try {
            command = tapbackCommand(senderOptions, to, guid, kind);
        } catch (error) {
            throw new HttpError(501, (error as Error).message);
        }
        const result = await defaultRun(command.command, command.args, 20_000);
        if (result.code !== 0) {
            log.warn(`tapback to ${tail(to)} failed (exit ${result.code})`);
            throw new HttpError(502, 'tapback failed');
        }
        return json(200, { ok: true });
    },
}, port, '127.0.0.1', (m) => log.error(m));

// Only files under Messages' own attachment store, never anything else the
// bridge could read (chat.db, the .env).
fileRoute(server, '/attachment', localAttachmentHandler(attachmentsRoot, bridgeKey, expandHome), (m) => log.error(m));

log.info(`line ${line} watching ${dbPath}`);
