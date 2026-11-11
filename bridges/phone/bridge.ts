// bridges/phone/bridge.ts
// One process per iPhone line. Polls the phone's SMServer for new texts and
// forwards them to the agent server; sends replies back out the same phone.
//   POST /send {to, text}   X-Bridge-Key     -> 200 {ok, verified}
//   GET  /health                              -> 200 {status, phone}
// Run: node bridges/phone/bridge.ts lines/phone1.env
// The line file holds that phone's settings (see lines/example.env); the
// shared .env holds BRIDGE_KEY and SERVER_URL.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { env, envBool, envInt, loadEnvFile, requireEnv } from '../../src/config.ts';
import { createLogger, tail } from '../../src/log.ts';
import { HttpError, header, json, parseJson, safeEqual, startHttp } from '../../src/http.ts';
import { createForwarder } from '../forward.ts';
import { createSmServer, asRowId } from './smserver.ts';
import { chatsToRead, emptyState, isForwardable, isGroupChat, pendingRows, settle } from './inbound.ts';
import type { InboundState } from './inbound.ts';

const lineFile = process.argv[2] ?? env('LINE_ENV_FILE');
if (!lineFile || !existsSync(lineFile)) throw new Error('usage: node bridges/phone/bridge.ts lines/<line>.env');
// The line file first: loadEnvFile never overwrites a variable already set.
loadEnvFile(lineFile);
loadEnvFile();

const line = requireEnv('LINE_ID');
const log = createLogger(`phone-${line}`);
const bridgeKey = requireEnv('BRIDGE_KEY');
const statePath = env('LINE_STATE_PATH', `data/phone-${line}.json`);
const phone = createSmServer({ url: requireEnv('SMSERVER_URL').replace(/\/+$/, ''), password: requireEnv('SMSERVER_PASSWORD'), viaCurl: envBool('SMSERVER_VIA_CURL'), lookback: envInt('SMSERVER_LOOKBACK', 25) });
const forward = createForwarder(env('SERVER_URL', 'http://127.0.0.1:3000'), bridgeKey);

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
                const result = await forward({ line, from: chat, text: String(row.text).trim(), guid: String(row.guid ?? `${line}-${asRowId(row.ROWID)}`), isGroup: isGroupChat(chat), service: typeof row.service === 'string' ? row.service : undefined });
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

startHttp({
    'GET /health': async () => {
        const phoneUp = await phone.ping().catch(() => false);
        const ok = phoneUp && !lastError;
        return json(ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', line, phone: phoneUp ? 'up' : 'down', lastPollAt, lastError });
    },
    'POST /send': async (req) => {
        if (!safeEqual(header(req, 'x-bridge-key'), bridgeKey)) throw new HttpError(401, 'bad bridge key');
        const body = parseJson(req);
        const to = String(body.to ?? '').trim();
        const text = String(body.text ?? '').trim();
        if (!to || !text) throw new HttpError(400, 'to and text are required');
        try {
            const result = await phone.send(to, text, (ms) => sleep(ms));
            if (!result.verified) log.warn(`send to ${tail(to)} accepted but not seen on the phone yet`);
            return json(200, { ok: true, verified: result.verified });
        } catch (error) {
            log.error(`send to ${tail(to)} failed: ${(error as Error).message}`);
            throw new HttpError(502, 'send failed');
        }
    },
}, requireEnvPort(), '127.0.0.1', (m) => log.error(m));

function requireEnvPort(): number {
    const port = envInt('PHONE_BRIDGE_PORT', 0);
    if (!port) throw new Error('PHONE_BRIDGE_PORT is not set in the line file');
    return port;
}

log.info(`line ${line} polling ${env('SMSERVER_URL')}`);
void loop();
