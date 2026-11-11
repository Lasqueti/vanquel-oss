// bridges/mac/bridge.ts
// The Mac line: this Mac mini's own Messages account as an iMessage line.
//   inbound   watcher.ts reads chat.db and forwards to the agent server
//   outbound  POST /send {to, text} with X-Bridge-Key, sent by sender.ts
//   health    GET /health
// Needs Full Disk Access for the Node binary (to read chat.db), and a
// signed-in Messages.app. See docs/MAC-MINI.md. Run: npm run bridge:mac

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { env, envInt, loadEnvFile, requireEnv } from '../../src/config.ts';
import { createLogger, tail } from '../../src/log.ts';
import { HttpError, header, json, parseJson, safeEqual, startHttp } from '../../src/http.ts';
import { createForwarder } from '../forward.ts';
import { createWatcher } from './watcher.ts';
import type { WatcherState } from './watcher.ts';
import { createSender } from './sender.ts';
import type { SendVia } from './sender.ts';

loadEnvFile();
const log = createLogger('mac-bridge');
const line = env('MAC_LINE_ID', 'mac');
const bridgeKey = requireEnv('BRIDGE_KEY');
const dbPath = env('MESSAGES_DB_PATH', join(homedir(), 'Library/Messages/chat.db'));
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

const send = createSender({ via: env('MAC_SEND_VIA', 'imsg') as SendVia, imsgPath: env('IMSG_PATH', 'imsg'), timeoutMs: envInt('MAC_SEND_TIMEOUT_MS', 30_000) });

startHttp({
    'GET /health': () => json(lastScanError ? 503 : 200, { status: lastScanError ? 'degraded' : 'ok', line, lastScanAt, lastError: lastScanError }),
    'POST /send': async (req) => {
        if (!safeEqual(header(req, 'x-bridge-key'), bridgeKey)) throw new HttpError(401, 'bad bridge key');
        const body = parseJson(req);
        const to = String(body.to ?? '').trim();
        const text = String(body.text ?? '').trim();
        if (!to || !text) throw new HttpError(400, 'to and text are required');
        try {
            await send(to, text);
        } catch (error) {
            log.error(`send to ${tail(to)} failed: ${(error as Error).message}`);
            throw new HttpError(502, 'send failed');
        }
        return json(200, { ok: true });
    },
}, envInt('MAC_BRIDGE_PORT', 3101), '127.0.0.1', (m) => log.error(m));
log.info(`line ${line} watching ${dbPath}`);
