// games/watcher.ts
// GamePigeon auto-play on the iPhone lines. Its own process:
//   node games/watcher.ts            (GAMES_DRY_RUN=1 to log instead of send)
//
// Each line in GAME_LINES is polled through its on-phone tweak (/poc/read-games
// reads the phone's own sms.db). A new inbound GamePigeon card is decoded
// (games/cipher.ts), dispatched on its `game=` field to a play module, solved,
// HANDICAPPED by the per-opponent rubber band so the game stays fun, then
// re-archived (gp-archive) and sent back as a balloon on the same line,
// threaded onto the game's first card. A finished game gets ONE closing text
// ("gg" by default) through the line's phone bridge.
//
// Safety, kept from production:
//   - one poll per line at a time, cards handled strictly in row order
//   - a per-line cursor in GAMES_STATE_DIR; the first start seeds it past every
//     existing card, so history never replays
//   - a move is sent at most once: the send is fenced (markDeliveryAccepted)
//     before any state is committed, so a retry after a crash resumes at the
//     commit instead of sending again; a card the bot already played is ignored
//   - a failed card holds the cursor and is retried; after GAMES_MAX_ATTEMPTS
//     it is dead-lettered (cursor moves on) and an alert goes to Slack
//   - poison-pill fence: a card that kills the process mid-handling is
//     skipped after GAMES_MAX_ATTEMPTS starts
//   - untrusted cards: size ceilings before and after decode, and a kernel
//     write limit on plutil (a binary plist can expand exponentially)
//   - a game we cannot play (or one not armed) gets ONE friendly decline per
//     opponent per 30 minutes; the game name in it comes from an allowlist,
//     never from the card
//   - nothing is sent to a contact who opted out (STOP) of the agent
//
// Needs, on the Mac running it: /usr/bin/plutil, a compiled gp-archive
// (games/gp-archive.swift) and a word list. See games/README.md.

import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { env, envBool, envInt, envMap, loadEnvFile } from '../src/config.ts';
import { createLogger, tail } from '../src/log.ts';
import { createAlerter } from '../src/ops/alert.ts';
import { createTweakClient } from '../bridges/phone/tweak.ts';
import type { GameRow, TweakClient } from '../bridges/phone/tweak.ts';
import { catalog } from './catalog.ts';
import { cipher } from './cipher.ts';
import { createDifficultyStore, gamesDataDir } from './difficulty.ts';
import type { DifficultyRelease } from './difficulty.ts';
import { rubberBand } from './rubber-band.ts';
import { parseDictionary, solve as solveWordHunt } from './wordhunt-engine.ts';
import { wordhuntPlay } from './wordhunt-play.ts';
import { anagramsPlay } from './anagrams-play.ts';
import { wordbitesPlay } from './wordbites-play.ts';
import { dartsPlay } from './darts-play.ts';
import { archeryPlay } from './archery-play.ts';
import { poolPlay } from './pool-play.ts';
import { minigolfPlay } from './minigolf-play.ts';
import { dotsPlay } from './dots-play.ts';
import { tanksPlay } from './tanks-play.ts';
import { beerPlay } from './beer-play.ts';
import { basketballPlay } from './basketball-play.ts';
import { fillPlay } from './fill-play.ts';
import { wasmAvailable } from './wasm-glue.ts';

// ---- types ------------------------------------------------------------------
// Erased views of untrusted card state and persisted JSON: no validation.

export interface WireState { [key: string]: unknown; game: string; id?: string; caption?: string }
export interface Decoded { state: WireState; templateBin: string }
export interface Identity { uuid: string; avatar: string }
interface PlayContext { botUuid?: string; botAvatar?: string; rbState?: RbEntry }
export interface Decision {
    action: 'ignore' | 'skip' | 'result' | 'invite' | 'play';
    newState?: WireState; botWon?: boolean | null; oppScore?: unknown; botScore?: unknown;
    reason?: unknown; botWords?: unknown; mode?: unknown; fullScore?: unknown; fullWords?: unknown;
    targetN?: unknown; boardId?: unknown; player?: number; opponent?: number; eventScore?: unknown;
}
export interface PlayModule {
    game: string; displayName: string; enableSend?: boolean; ENABLE_SEND?: boolean;
    solve(state: WireState, deps: { dict: unknown }): unknown;
    decideMove(state: WireState, ctx: PlayContext, solve: unknown): Decision;
}
interface RbEntry {
    [key: string]: unknown;
    difficulty?: unknown; gamesPlayed?: number; userLastWords?: unknown; lastBotResult?: unknown;
    lastRecordedGame?: unknown; lastPlayedBoard?: unknown; adaptiveFactor?: unknown; recentResults?: unknown[];
}
type RbStore = Record<string, RbEntry>;
type DifficultyFile = Record<string, unknown>;
type UnsupportedStore = Record<string, number>;
interface Anchor { guid: string; ts: number }
type AnchorStore = Record<string, Anchor>;
interface Failure {
    starts?: unknown; attempts?: unknown; deadLetter?: boolean; acceptedAt?: unknown;
    firstFailedAt?: unknown; lastFailedAt?: unknown; lastStartedAt?: unknown; lastError?: unknown; game?: unknown;
}
type FailureStore = Record<string, Failure>;
interface FinishEvent { lineId: string; chatGuid: string; game: string; gameId: string; eventId?: string }
interface OutboxEntry { event: FinishEvent; createdAt?: number; nextAttemptAt?: number; attempts?: number; lastError?: string }
type Outbox = Record<string, OutboxEntry>;
interface Caught { message?: unknown; code?: unknown }
export interface PlayResult { action: string; game: string }

export interface GameLine {
    id: string;
    tweak: TweakClient;
}

export interface WatcherOptions {
    lines: GameLine[];
    dataDir: string;
    dict: unknown;
    identity: Identity;
    log: (message: string) => void;
    alert: (text: string) => Promise<void>;
    // Card bytes -> decoded state + a template .bin path for the reply archive.
    decodeCard: (payload: Buffer, tag: string) => Decoded;
    // Re-archive a reply from the inbound template. mode 'new' mints a fresh session.
    archiveReply: (templateBin: string, url: string, mode: 'new' | 'reuse', caption: string, ldtext: string) => Buffer;
    // A plain text on the line (decline, closing "gg"). Rejects on failure.
    sendText: (lineId: string, to: string, text: string) => Promise<void>;
    isOptedOut?: (handle: string) => boolean;
    dryRun?: boolean;
    finishText?: string;
    maxAttempts?: number;
    pollLimit?: number;
    deliveryChecks?: number;
    deliveryCheckMs?: number;
    poolArmed?: () => boolean;
    games?: Record<string, PlayModule>;
    now?: () => number;
}

export const GP_BID = 'com.apple.messages.MSMessageExtensionBalloonPlugin:EWFNLB79LQ:com.gamerdelights.gamepigeon.ext';
const UNSUPPORTED_COOLDOWN_MS = 30 * 60 * 1000; // per opponent
const UNSUPPORTED_MAX_ENTRIES = 2000;
// Cap the anchor store: only CURRENTLY live games need one.
const ANCHOR_MAX_ENTRIES = 400;
const FINISH_RETRY_MS = 5000;

// Untrusted-card ceilings. Anyone who knows a line's number can send a card,
// and the GamePigeon envelope is a public, length-keyed shuffle rather than
// real crypto, so a card is trivially forged. A real card's payload is ~8KB.
const CARD_BIN_MAX_BYTES = 512 * 1024;
const CARD_XML_MAX_BYTES = 1024 * 1024;
const CARD_XML_MAX_BLOCKS = Math.ceil(CARD_XML_MAX_BYTES / 512); // ulimit -f uses 512B blocks
const PLUTIL_TIMEOUT_MS = 10000;

const asGame = (m: unknown) => m as PlayModule;

// ---- game registry ------------------------------------------------------------
// Keyed on the decoded `game=` field. Each module exposes
// { game, displayName, solve(state, deps) -> solve|null, decideMove }.
// Null-prototype on purpose: `state.game` is attacker-controlled, and on a
// normal object GAMES['constructor'] resolves to an inherited function, which
// sailed past the unsupported branch and then threw, stalling the cursor.
export function defaultGames(): Record<string, PlayModule> {
    const wordhunt: PlayModule = {
        game: 'hunt',
        displayName: 'Word Hunt',
        // null signals "skip" when the board isn't a supported 4x4.
        solve(state, deps) {
            try {
                return solveBoard(state.letters, deps.dict);
            } catch {
                return null;
            }
        },
        decideMove: asGame(wordhuntPlay).decideMove,
        // Word Hunt has no send gate: it is always armed. Declared explicitly so
        // the not-armed decline (enableSend === false) never misreads it.
        enableSend: true,
    };
    return Object.assign(Object.create(null) as Record<string, PlayModule>, {
        hunt: wordhunt,
        anagrams: asGame(anagramsPlay),
        wordbites: asGame(wordbitesPlay),
        darts: asGame(dartsPlay),
        archery: asGame(archeryPlay),
        pool: asGame(poolPlay),
        // Mini Golf needs its physics engine (not shipped, see README); without
        // it the game is declined like any other unarmed game.
        golf: wasmAvailable('golf') ? asGame(minigolfPlay) : { ...asGame(minigolfPlay), enableSend: false },
        dots: asGame(dotsPlay),
        tanks: asGame(tanksPlay),
        fill: asGame(fillPlay),
        beer: asGame(beerPlay),
        basketball: asGame(basketballPlay),
    });
}

// Word-findability is orientation-invariant, so solving letters.split('')
// directly yields the correct total score regardless of GamePigeon's fill order.
export function solveBoard(letters: unknown, dict: unknown) {
    const board = String(letters).toLowerCase().split('');
    if (board.length !== 16) {
        throw new Error('unsupported board size ' + board.length + ' (only 4x4/mode 1 supported)');
    }
    const solution = solveWordHunt(board, dict);
    const score = solution.reduce((s, e) => s + e.score, 0);
    const sortedWords = solution.map((e) => e.word.toUpperCase());
    return { score, wordCount: solution.length, sortedWords };
}

// Display names for the decline text, keyed by wire `game` id. An ALLOWLIST:
// `state.game_name` comes from the sender, so it is never echoed back.
const GAME_DISPLAY_NAMES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
    hunt: 'Word Hunt', anagrams: 'Anagrams', wordbites: 'Word Bites',
    darts: 'Darts', archery: 'Archery', basketball: 'Basketball',
    dots: 'Dots & Boxes', golf: 'Mini Golf', pool: '8 Ball', beer: 'Cup Pong',
    connect: 'Connect 4', tanks: 'Tanks', paint: 'Paintball', chess: 'Chess',
    checkers: 'Checkers', mancala: 'Mancala', reversi: 'Reversi', fill: 'Filler',
    renju: 'Gomoku', sea: 'Sea Battle', knock: 'Knockout', shuffleboard: 'Shuffleboard',
});
export function displayNameFor(gameId: unknown): string {
    return GAME_DISPLAY_NAMES[String(gameId == null ? '' : gameId).trim().toLowerCase()] || 'that one';
}

// Deterministic small hash (djb2) so the decline wording is stable per opponent.
export function djb2(str: string): number {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
}

export function unsupportedLine(gameName: string, suggestions: string[], seedKey: string): string {
    const g = gameName || 'that one';
    const suggestPair = suggestions.slice(0, 2).join(' or ');
    const suggestBoth = suggestions.slice(0, 2).join(' and ');
    const lines = [
        `ngl I haven't figured out ${g} yet \u{1F605} hit me with ${suggestions[0]} tho`,
        `can't play ${g} yet lol, send ${suggestPair}?`,
        `${g} isn't my thing yet \u{1F62D} I'm good at ${suggestBoth} tho, run one of those`,
        `oof I don't do ${g} yet. down for ${suggestions[0]} instead?`,
    ];
    return lines[djb2(seedKey) % lines.length];
}

// Stable fingerprint of a FINISHED game, so a W/L is never counted twice (the
// bot's own finishing move and the opponent's echoed finished card derive the
// same one). The session `id` is folded in because replay games carry no
// letters/level/scores and would otherwise all hash alike.
export function gameFingerprint(state: Partial<WireState> | null | undefined): string {
    const s: Partial<WireState> = state || {};
    const board = s.letters || s.level || '';
    return [board, s.score1, s.score2, s.words1, s.words2, s.id].join(':');
}

// The opponent's handle from a chat guid ("iMessage;-;+15550100001").
export function handleFromChatGuid(chatGuid: unknown): string {
    return String(chatGuid || '').replace(/^(iMessage|SMS|any);[-+];/, '') || String(chatGuid || '');
}

// Phone-digits key for the difficulty store; email handles fall back to the
// raw handle.
export function phoneKeyFromChatGuid(chatGuid: unknown): string {
    const handle = handleFromChatGuid(chatGuid);
    const digits = handle.replace(/\D/g, '');
    return digits || handle;
}

// Difficulty for a chat guid, tolerant of 10- vs 11-digit phone forms. A
// per-game override ("<phoneKey>#<game>") wins over the global level.
function difficultyForChatGuid(difficultyAll: DifficultyFile | undefined, chatGuid: string, gameId?: string) {
    if (!difficultyAll) return null;
    const k = phoneKeyFromChatGuid(chatGuid);
    const alt = /^\d+$/.test(k)
        ? (k.length === 11 && k[0] === '1' ? k.slice(1) : k.length === 10 ? '1' + k : null)
        : null;
    if (gameId) {
        if (difficultyAll[k + '#' + gameId]) return difficultyAll[k + '#' + gameId];
        if (alt && difficultyAll[alt + '#' + gameId]) return difficultyAll[alt + '#' + gameId];
    }
    if (difficultyAll[k]) return difficultyAll[k];
    if (alt && difficultyAll[alt]) return difficultyAll[alt];
    return null;
}

export function createWatcher(options: WatcherOptions) {
    const { dataDir, dict, log } = options;
    const now = options.now ?? Date.now;
    const dryRun = options.dryRun === true;
    const finishText = options.finishText ?? 'gg';
    const MAX_ATTEMPTS = Math.max(1, options.maxAttempts ?? 3);
    const POLL_LIMIT = options.pollLimit ?? 25;
    const GAMES = options.games ?? defaultGames();
    const ctx: PlayContext = { botUuid: options.identity.uuid, botAvatar: options.identity.avatar };
    const PLAYABLE_SUGGESTIONS = catalog.SUGGESTED_GAME_NAMES.map((name) => name.toLowerCase());
    const difficulty = createDifficultyStore(dataDir);

    const file = (name: string) => join(dataDir, name);
    const RB_FILE = file('rubber-band.json');
    const UNSUPPORTED_FILE = file('unsupported.json');
    const ANCHOR_FILE = file('anchors.json');
    const FAILURE_FILE = file('failures.json');
    const OUTBOX_FILE = file('finish-outbox.json');

    function readJson<T>(path: string): T | null {
        try {
            const value = JSON.parse(readFileSync(path, 'utf8')) as T;
            return value && typeof value === 'object' ? value : null;
        } catch {
            return null;
        }
    }
    function writeJson(path: string, value: unknown) {
        mkdirSync(dataDir, { recursive: true });
        const tmp = path + '.tmp';
        writeFileSync(tmp, JSON.stringify(value, null, 2));
        renameSync(tmp, path);
    }

    // ---- delivery fences (per line + row) ------------------------------------
    const readFailureAll = (): FailureStore => readJson<FailureStore>(FAILURE_FILE) ?? {};
    function writeFailureAll(value: FailureStore) {
        const entries = Object.entries(value);
        if (entries.length > 500) {
            // A tripped poison fence is the ONLY thing stopping a card that kills
            // the process from replaying forever, so it is never evicted by age:
            // keep every live fence, then fill with the most recent of the rest.
            const touchedAt = (e: Failure) => Math.max(Number(e?.lastFailedAt || 0), Number(e?.lastStartedAt || 0));
            const byRecency = (a: [string, Failure], b: [string, Failure]) => touchedAt(b[1]) - touchedAt(a[1]);
            const isFence = ([, e]: [string, Failure]) => (Number(e?.starts) || 0) >= MAX_ATTEMPTS;
            const fences = entries.filter(isFence).sort(byRecency).slice(0, 250);
            const rest = entries.filter((e) => !isFence(e)).sort(byRecency).slice(0, Math.max(0, 250 - fences.length));
            value = Object.fromEntries([...fences, ...rest]);
        }
        writeJson(FAILURE_FILE, value);
    }
    const failureKey = (scope: string, rowId: number) => `${scope}:${rowId}`;

    function clearDeliveryFailure(scope: string, rowId: number) {
        const all = readFailureAll();
        const key = failureKey(scope, rowId);
        if (!all[key]) return;
        delete all[key];
        writeFailureAll(all);
    }
    function markDeliveryAccepted(scope: string, rowId: number) {
        const all = readFailureAll();
        const key = failureKey(scope, rowId);
        all[key] = { ...(all[key] || {}), acceptedAt: now() };
        writeFailureAll(all);
    }
    function wasDeliveryAccepted(scope: string, rowId: number) {
        return Number(readFailureAll()[failureKey(scope, rowId)]?.acceptedAt) > 0;
    }
    function recordDeliveryFailure(scope: string, rowId: number, error: unknown) {
        const all = readFailureAll();
        const key = failureKey(scope, rowId);
        const previous = all[key] || {};
        const attempts = (Number(previous.attempts) || 0) + 1;
        const entry: Failure = {
            ...previous,
            attempts,
            deadLetter: attempts >= MAX_ATTEMPTS,
            firstFailedAt: previous.firstFailedAt || now(),
            lastFailedAt: now(),
            lastError: String((error as Caught)?.message || error || 'unknown failure').slice(0, 500),
        };
        all[key] = entry;
        writeFailureAll(all);
        return entry;
    }
    // Stamp the attempt BEFORE the work: a card that kills the process outright
    // never reaches a catch, so without this it would crash-loop forever.
    function recordDeliveryAttempt(scope: string, rowId: number) {
        const all = readFailureAll();
        const key = failureKey(scope, rowId);
        const previous = all[key] || {};
        all[key] = { ...previous, starts: (Number(previous.starts) || 0) + 1, lastStartedAt: now() };
        writeFailureAll(all);
    }
    function isPoisonPill(scope: string, rowId: number) {
        return (Number(readFailureAll()[failureKey(scope, rowId)]?.starts) || 0) >= MAX_ATTEMPTS;
    }
    function alertDeadLetter(scope: string, rowId: number, failure: Failure) {
        const message = [
            'GamePigeon move dead-lettered',
            `line: ${scope}`,
            `row: ${rowId}`,
            failure.game ? `game: ${failure.game}` : null,
            `attempts: ${failure.attempts}`,
            `error: ${failure.lastError}`,
        ].filter(Boolean).join('\n');
        options.alert(message).catch(() => { /* the alerter logs its own failures */ });
    }

    // ---- rubber-band state (per opponent, keyed by chat guid) -----------------
    const loadRbAll = (): RbStore => readJson<RbStore>(RB_FILE) ?? {};
    const loadDifficultyAll = (): DifficultyFile => readJson<DifficultyFile>(difficulty.DIFFICULTY_FILE) ?? {};
    function getRb(all: RbStore, key: string, difficultyAll?: DifficultyFile, gameId?: string): RbEntry {
        const base = all[key] || { gamesPlayed: 0, userLastWords: null, lastBotResult: null };
        const diff = difficultyForChatGuid(difficultyAll, key, gameId);
        return diff ? { ...base, difficulty: diff } : base;
    }
    // INVARIANT: difficulty lives ONLY in difficulty.json and is overlaid at
    // read time; it is stripped here so a reset can never be undone by a stale
    // copy baked into the rubber-band file.
    function saveRbAll(all: RbStore) {
        const clean: RbStore = {};
        for (const [k, v] of Object.entries(all)) {
            if (v && typeof v === 'object' && 'difficulty' in v) {
                const { difficulty: _dropped, ...rest } = v;
                clean[k] = rest;
            } else {
                clean[k] = v;
            }
        }
        writeJson(RB_FILE, clean);
    }

    // ---- per-game reply anchor ---------------------------------------------------
    // Every reply in a game must thread onto the guid of the game's FIRST card,
    // or Messages renders a second balloon on turn 2+. Keyed by the decoded
    // session `id`, which is stable for a whole game and unique per game.
    const loadAnchorAll = (): AnchorStore => readJson<AnchorStore>(ANCHOR_FILE) ?? {};
    function saveAnchorAll(all: AnchorStore) {
        let out = all;
        const keys = Object.keys(all);
        if (keys.length > ANCHOR_MAX_ENTRIES) {
            out = {};
            const kept = keys.map((k): [string, number] => [k, (all[k] && all[k].ts) || 0])
                .sort((a, b) => b[1] - a[1]).slice(0, ANCHOR_MAX_ENTRIES);
            for (const [k] of kept) out[k] = all[k];
        }
        writeJson(ANCHOR_FILE, out);
    }
    function resolveGameAnchor(anchorAll: AnchorStore, sessionId: string | undefined, inboundGuid: string) {
        if (!sessionId) return inboundGuid || '';
        const existing = anchorAll[sessionId];
        if (existing && existing.guid) return existing.guid;
        if (inboundGuid) {
            anchorAll[sessionId] = { guid: inboundGuid, ts: now() };
            saveAnchorAll(anchorAll);
            return inboundGuid;
        }
        return '';
    }

    // ---- unsupported-game decline ---------------------------------------------
    const loadUnsupportedAll = (): UnsupportedStore => readJson<UnsupportedStore>(UNSUPPORTED_FILE) ?? {};
    function saveUnsupportedAll(all: UnsupportedStore) {
        // An entry only matters inside its cooldown: drop lapsed ones, then cap.
        const cutoff = now() - UNSUPPORTED_COOLDOWN_MS;
        let entries = Object.entries(all).filter(([, ts]) => Number(ts) >= cutoff);
        if (entries.length > UNSUPPORTED_MAX_ENTRIES) {
            entries.sort((a, b) => Number(b[1]) - Number(a[1]));
            entries = entries.slice(0, UNSUPPORTED_MAX_ENTRIES);
        }
        const pruned = Object.fromEntries(entries);
        for (const k of Object.keys(all)) if (!(k in pruned)) delete all[k];
        writeJson(UNSUPPORTED_FILE, pruned);
    }

    function sendTextBestEffort(line: GameLine, to: string, text: string) {
        options.sendText(line.id, to, text)
            .then(() => log(`${line.id} text sent to ${tail(to)}`))
            .catch((e) => log(`${line.id} text to ${tail(to)} FAILED: ${(e as Caught).message}`));
    }

    // ONE casual decline per OPPONENT per cooldown. Keyed on the opponent only,
    // never on `state.game`: that field is attacker-controlled, and keying on it
    // let a sender make every card look like a new game and get one text per
    // card forever, which is how a line gets flagged by Apple.
    function handleUnsupportedGame(state: WireState, chatGuid: string, rowId: number, unsupportedAll: UnsupportedStore, line: GameLine) {
        const gameName = displayNameFor(state.game);
        const key = line.id + '|' + chatGuid;
        const lastSaid = unsupportedAll[key] || 0;
        if (now() - lastSaid < UNSUPPORTED_COOLDOWN_MS) {
            log(`${line.id} ${rowId} game=${String(state.game)} (${gameName}) unsupported, already said recently, staying quiet`);
            return;
        }
        const text = unsupportedLine(gameName, PLAYABLE_SUGGESTIONS, key);
        unsupportedAll[key] = now();
        saveUnsupportedAll(unsupportedAll);
        if (dryRun) {
            log(`${line.id} ${rowId} game=${String(state.game)} (${gameName}) unsupported; WOULD SAY: ${text}`);
            return;
        }
        sendTextBestEffort(line, handleFromChatGuid(chatGuid), text);
        log(`${line.id} ${rowId} game=${String(state.game)} (${gameName}) unsupported, declined`);
    }

    // ---- closing text outbox -------------------------------------------------------
    // A finished game gets ONE closing text. Enqueued durably, deduped by event
    // id (line + chat + game + fingerprint), and drained with backoff so a down
    // bridge delays the text instead of losing it.
    const readOutbox = (): Outbox => readJson<Outbox>(OUTBOX_FILE) ?? {};
    function writeOutbox(value: Outbox) {
        const entries = Object.entries(value);
        if (entries.length > 5000) {
            entries.sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0));
            value = Object.fromEntries(entries.slice(0, 2500));
        }
        writeJson(OUTBOX_FILE, value);
    }
    const eventId = (e: FinishEvent) => createHash('sha256').update([e.lineId, e.chatGuid, e.game, 'finished', e.gameId].join('|')).digest('hex');

    let drainRunning = false;
    async function drainFinishOutbox() {
        if (drainRunning) return;
        drainRunning = true;
        try {
            for (const [id, entry] of Object.entries(readOutbox())) {
                if (Number(entry.nextAttemptAt || 0) > now()) continue;
                const to = handleFromChatGuid(entry.event.chatGuid);
                try {
                    if (options.isOptedOut?.(to)) log(`${entry.event.lineId} closing text skipped: ${tail(to)} opted out`);
                    else await options.sendText(entry.event.lineId, to, finishText);
                    // Reload before every mutation: a new item may have been added
                    // while this send was in flight.
                    const current = readOutbox();
                    delete current[id];
                    writeOutbox(current);
                } catch (e) {
                    const attempts = (Number(entry.attempts) || 0) + 1;
                    const current = readOutbox();
                    if (!current[id]) continue;
                    current[id] = {
                        ...current[id],
                        attempts,
                        lastError: String((e as Caught)?.message || e).slice(0, 300),
                        nextAttemptAt: now() + Math.min(5 * 60 * 1000, FINISH_RETRY_MS * (2 ** Math.min(attempts - 1, 6))),
                    };
                    writeOutbox(current);
                    log(`closing text deferred: ${id.slice(0, 10)} ${current[id].lastError}`);
                }
            }
        } finally {
            drainRunning = false;
        }
    }

    function postFinished(event: FinishEvent) {
        if (!finishText) return;
        if (dryRun) {
            log(`${event.lineId} game over (${event.game}); WOULD SAY: ${finishText}`);
            return;
        }
        try {
            const id = eventId(event);
            const outbox = readOutbox();
            if (!outbox[id]) {
                outbox[id] = { event: { ...event, eventId: id }, attempts: 0, createdAt: now(), nextAttemptAt: 0 };
                writeOutbox(outbox);
            }
            drainFinishOutbox().catch((e) => log(`closing text drain failed: ${(e as Caught).message}`));
        } catch (e) {
            log(`closing text enqueue failed: ${(e as Caught).message}`);
        }
    }

    // ---- delivery: send the balloon, then wait for the phone to deliver it ---------
    async function sendBalloonConfirmed(line: GameLine, fields: Record<string, string>) {
        const { guid, raw } = await line.tweak.sendBalloon(fields);
        if (!guid) throw new Error(`tweak accepted game balloon without a message guid: ${raw.slice(0, 200)}`);
        let statusText = '';
        for (let i = 0; i < (options.deliveryChecks ?? 30); i++) {
            await sleepMs(options.deliveryCheckMs ?? 500);
            try {
                statusText = (await line.tweak.messageStatus(guid)).trim();
            } catch {
                continue;
            }
            if (statusText.startsWith('ERR')) continue;
            const error = statusText.match(/\berror=(-?\d+)/);
            if (error && Number(error[1]) !== 0) throw new Error(`game balloon failed on phone: ${statusText}`);
            const delivered = statusText.match(/\bdelivered=(\d+)/);
            if (delivered && Number(delivered[1]) === 1) return guid;
        }
        throw new Error(`game balloon was inserted but not delivered in time: guid=${guid} ${statusText}`);
    }

    const poolConfigured = () => !!(poolPlay as { ENABLE_SEND?: boolean }).ENABLE_SEND && process.env.GP_POOL_FORCE_ENABLE === '1';
    const poolArmed = options.poolArmed ?? (() => {
        if (!poolConfigured()) return false;
        try { return poolPlay.engineReady(); } catch { return false; }
    });

    // ---- one card: dispatch, solve, decide, send, record ------------------------------
    async function runPlay(decoded: Decoded, rowId: number, chatGuid: string, guid: string, rbAll: RbStore, unsupportedAll: UnsupportedStore, line: GameLine, difficultyAll: DifficultyFile): Promise<PlayResult | undefined> {
        const rbKey = chatGuid;
        const { state, templateBin } = decoded;
        const tag = line.id;

        const mod = GAMES[state.game];
        if (!mod) {
            handleUnsupportedGame(state, chatGuid, rowId, unsupportedAll, line);
            return { action: 'unsupported', game: state.game };
        }

        // POOL is armed per deployment. While its engine is still loading the
        // cursor is held (retry); while unarmed it stays SILENT.
        if (state.game === 'pool' && poolConfigured() && !poolArmed()) {
            const warming = new Error('Pool engine is still warming; hold cursor and retry') as Error & { code: string };
            warming.code = 'EGAME_NOT_READY';
            throw warming;
        }
        if (state.game === 'pool' && !poolArmed()) return { action: 'disabled', game: state.game };

        // A recognized game that is NOT armed (its GP_<GAME>_SEND gate is off)
        // gets the same polite decline as an unknown game, never a silent ghost.
        if (mod.enableSend === false || mod.ENABLE_SEND === false) {
            handleUnsupportedGame(state, chatGuid, rowId, unsupportedAll, line);
            return { action: 'disabled', game: state.game };
        }

        // Record the FIRST card's guid for this game as soon as it is recognized,
        // even if this turn ends up skipped, so the anchor is the original card.
        if (state.id) {
            const anchorAllEarly = loadAnchorAll();
            if (!anchorAllEarly[state.id]) resolveGameAnchor(anchorAllEarly, state.id, guid);
        }

        let solve;
        try {
            solve = mod.solve(state, { dict });
        } catch (e) {
            log(`${tag} ${rowId} ${mod.displayName} solve error: ${(e as Caught).message} (skipping)`);
            return;
        }
        // null is fine for a finished card; on the bot's turn it means skip.
        if (solve == null && !state.winner) {
            log(`${tag} ${rowId} ${mod.displayName} solve returned null (fail-safe skip)`);
            return;
        }

        const rb = getRb(rbAll, rbKey, difficultyAll, state.game);
        // Each game tunes independently: hand the module a copy with THIS game's
        // own adaptive factor and count. The original rb is kept for saving.
        const rbForMove = {
            ...rb,
            adaptiveFactor: rubberBand.resolveGameFactor(rb, state.game),
            gamesPlayed: rubberBand.resolveGameCount(rb, state.game),
        };
        const decision = mod.decideMove(state, { ...ctx, rbState: rbForMove }, solve);

        if (decision.action === 'ignore') return { action: 'ignored', game: state.game };
        if (decision.action === 'skip') {
            log(`${tag} ${rowId} | ${mod.displayName} | SKIP (not sending): ${String(decision.reason || 'game module declined')} | wouldSubmit=${String(decision.botScore)}/${String(decision.botWords)}w | mode=${String(decision.mode)}`);
            return { action: 'skipped', game: state.game };
        }

        // ---- finished game: record W/L for the rubber band, send no move ----------
        if (decision.action === 'result') {
            const result = decision.botWon === true ? 'W' : decision.botWon === false ? 'L' : null;
            let userWords = rb.userLastWords;
            const uw = (state.player1 === ctx.botUuid) ? state.words2 : (state.player2 === ctx.botUuid) ? state.words1 : null;
            if (uw != null && uw !== '') userWords = Number(uw);
            const fp = gameFingerprint(state);
            if (rb.lastRecordedGame && rb.lastRecordedGame === fp) {
                log(`${tag} ${rowId} | FINISHED game already recorded (fingerprint match), skipping double count`);
                return;
            }
            // A pinned fixed difficulty must not drift the adaptive dial.
            const pinned = !!(rb.difficulty && rb.difficulty !== 'adaptive');
            const adaptive = rubberBand.updateAdaptiveState(rb, {
                botWon: decision.botWon, oppScore: decision.oppScore as number | undefined, gameId: state.game, adjustFactor: !pinned,
            });
            rbAll[rbKey] = { ...rb, gamesPlayed: (rb.gamesPlayed || 0) + 1, userLastWords: userWords, lastBotResult: result, lastRecordedGame: fp, ...adaptive };
            saveRbAll(rbAll);
            recordDifficultyResult(chatGuid, state.game, decision.botWon, tag, rowId);
            log(`${tag} ${rowId} | FINISHED game | botWon=${String(decision.botWon)} | botScore=${String(decision.botScore)} | oppScore=${String(decision.oppScore)}`);
            postFinished({ lineId: line.id, chatGuid, game: mod.displayName, gameId: fp });
            return { action: 'result', game: state.game };
        }

        // ---- play: build a HANDICAPPED reply card ----------------------------------
        // action 'invite' (pool: the opponent breaks) is a fresh bot-sent invite:
        // a NEW archive session, sent un-threaded, and it records no W/L.
        const isInvite = decision.action === 'invite';
        const newState = decision.newState as WireState;
        const player = decision.player != null ? decision.player : ((!state.score2) ? 2 : 1);
        const opponent = decision.opponent != null ? decision.opponent : (player === 1 ? 2 : 1);
        const boardStr = state.letters || state.level || '(none)';
        log(`${tag} ${rowId} | ${mod.displayName} | board=${String(boardStr)} | fullSolve=${String(decision.fullScore)}/${String(decision.fullWords)}w | mode=${String(decision.mode)}${decision.targetN != null ? ` (N=${String(decision.targetN)})` : ''} | botSubmit=${String(decision.botScore)}/${String(decision.botWords)}w`);

        const url = cipher.buildEnvelope(newState) as string;
        // The INBOUND card is the template: gp-archive swaps URL + caption +
        // ldtext and ("reuse") keeps the inbound session.
        const caption = newState.caption || 'Your Move.';
        const payload = options.archiveReply(templateBin, url, isInvite ? 'new' : 'reuse', caption, mod.displayName);

        // State changes are committed only AFTER confirmed delivery, so a failed
        // send leaves the card eligible for a clean retry.
        const playedBoard = decision.boardId || state.letters || state.level || null;
        let commitMoveState = () => {};
        if (!isInvite && newState.winner) {
            // The bot's move finished the game: record the result here,
            // fingerprinted so an echoed finished card cannot double count it.
            commitMoveState = () => {
                const flag = String(newState.winner).split('|')[1];
                const result = flag === '1' ? 'W' : flag === '-1' ? 'L' : null;
                let userWords = rb.userLastWords;
                const uw = state['words' + opponent];
                if (uw != null && uw !== '') userWords = Number(uw);
                const fp = gameFingerprint(newState);
                if (rb.lastRecordedGame === fp) return;
                const botWon = flag === '1' ? true : flag === '-1' ? false : null;
                const oppScoreNum = Number(state['score' + opponent]);
                const oppScore = Number.isFinite(oppScoreNum) ? oppScoreNum : undefined;
                const pinned = !!(rb.difficulty && rb.difficulty !== 'adaptive');
                const adaptive = rubberBand.updateAdaptiveState(rb, { botWon, oppScore, gameId: state.game, adjustFactor: !pinned });
                rbAll[rbKey] = {
                    ...rb, gamesPlayed: (rb.gamesPlayed || 0) + 1, userLastWords: userWords,
                    lastBotResult: result, lastRecordedGame: fp, lastPlayedBoard: playedBoard, ...adaptive,
                };
                saveRbAll(rbAll);
                recordDifficultyResult(chatGuid, state.game, botWon, tag, rowId);
                log(`${tag} ${rowId} | confirmed + recorded result=${String(result)} games=${String(rbAll[rbKey].gamesPlayed)}`);
            };
        } else if (!isInvite) {
            // The bot moved first: stamp the board (dedupes an echoed card).
            commitMoveState = () => {
                const next: RbEntry = { ...rb, lastPlayedBoard: playedBoard };
                const oppWords = state['words' + opponent];
                if (oppWords != null && oppWords !== '') next.userLastWords = Number(oppWords);
                rbAll[rbKey] = next;
                saveRbAll(rbAll);
            };
        }

        // Thread onto the game's ORIGINAL card; an invite is a fresh balloon.
        const anchorGuid = isInvite ? '' : resolveGameAnchor(loadAnchorAll(), state.id, guid);

        if (dryRun) {
            log(`WOULD SEND (${tag} ${mod.displayName}) to ${tail(handleFromChatGuid(chatGuid))} anchor=${anchorGuid} caption="${caption}" submitScore=${String(decision.botScore)}`);
            return { action: 'dry-run', game: state.game };
        }

        if (!wasDeliveryAccepted(line.id, rowId)) {
            const fields: Record<string, string> = {
                to: handleFromChatGuid(chatGuid),
                bundleId: GP_BID,
                payloadBase64: payload.toString('base64'),
                breadcrumb: caption,
            };
            if (anchorGuid) fields.replyToGuid = anchorGuid;
            await sendBalloonConfirmed(line, fields);
            // Durable hand-off fence: if the commit below fails, the retry resumes
            // at the commit instead of transmitting a duplicate.
            markDeliveryAccepted(line.id, rowId);
        } else {
            log(`${tag} ${rowId} transport already confirmed on an earlier attempt, resuming state commit only`);
        }
        commitMoveState();
        log(`CONFIRMED SENT ${tag} ${mod.displayName} reply for ${rowId} submitScore=${String(decision.botScore)}`);
        if (!isInvite && newState.winner) {
            postFinished({ lineId: line.id, chatGuid, game: mod.displayName, gameId: gameFingerprint(newState) });
        }
        return { action: 'sent', game: state.game };
    }

    function recordDifficultyResult(chatGuid: string, gameId: string, botWon: boolean | null | undefined, tag: string, rowId: number) {
        try {
            const release: DifficultyRelease = difficulty.recordFixedDifficultyResult(phoneKeyFromChatGuid(chatGuid), gameId, botWon);
            if (release.reset) {
                const summary = release.reason === 'hard_losses' ? `${release.losses} bot losses` : `${release.wins} bot wins`;
                log(`${tag} ${rowId} | fixed difficulty auto-reset to adaptive after ${summary}${release.game ? ` [${release.game}]` : ' [all games]'}`);
            }
        } catch (e) {
            log(`${tag} ${rowId} | difficulty auto-reset accounting failed: ${(e as Caught).message}`);
        }
    }

    async function handleCard(card: GameRow, rbAll: RbStore, unsupportedAll: UnsupportedStore, line: GameLine, difficultyAll: DifficultyFile) {
        const handle = handleFromChatGuid(card.chat);
        if (options.isOptedOut?.(handle)) {
            log(`${line.id} ${card.rowId} ${tail(handle)} opted out; not playing`);
            return;
        }
        let decoded: Decoded;
        try {
            decoded = options.decodeCard(Buffer.from(card.payloadBase64, 'base64'), `${line.id}_${card.rowId}`);
        } catch (e) {
            log(`${line.id} ${card.rowId} decode failed: ${(e as Caught).message} (skipping)`);
            return;
        }
        try {
            return await runPlay(decoded, card.rowId, card.chat, card.guid, rbAll, unsupportedAll, line, difficultyAll);
        } finally {
            try { unlinkSync(decoded.templateBin); } catch { /* fake or already gone */ }
        }
    }

    // ---- per-line cursor ---------------------------------------------------------------
    const cursorFile = (lineId: string) => file(`line-${lineId}.json`);
    function loadCursor(lineId: string): number | null {
        const j = readJson<{ lastSeenRowId?: unknown }>(cursorFile(lineId));
        return j && typeof j.lastSeenRowId === 'number' ? j.lastSeenRowId : null;
    }
    const saveCursor = (lineId: string, rowId: number) => writeJson(cursorFile(lineId), { lastSeenRowId: rowId });

    // ---- per-line poller (serialized) ------------------------------------------------------
    function makeLinePoller(line: GameLine) {
        let cursor = loadCursor(line.id);
        let running = false;
        // The tweak rides MobileSMS, which iOS suspends in bursts. Collapse
        // repeated identical errors: log on change and at most once a minute.
        let lastErr: unknown = null;
        let lastErrLoggedAt = 0;
        let hadErr = false;

        async function poll() {
            if (running) return;
            running = true;
            try {
                const after = cursor === null ? 0 : cursor;
                const cards = await line.tweak.readGames(after, POLL_LIMIT);
                if (hadErr) { log(`${line.id} line poll recovered`); hadErr = false; lastErr = null; }
                if (cursor === null) {
                    // First start: walk every historical page before declaring the
                    // line seeded, otherwise page 2 would replay as new.
                    let maxRow = after;
                    let page = cards;
                    while (page.length) {
                        let pageMax = maxRow;
                        for (const c of page) if (c.rowId > pageMax) pageMax = c.rowId;
                        if (pageMax <= maxRow || page.length < POLL_LIMIT) { maxRow = pageMax; break; }
                        maxRow = pageMax;
                        page = await line.tweak.readGames(maxRow, POLL_LIMIT);
                    }
                    cursor = maxRow;
                    saveCursor(line.id, cursor);
                    log(`${line.id} first start: seeded cursor = ${cursor} (old games skipped)`);
                    return;
                }
                if (!cards.length) return;
                const rbAll = loadRbAll();
                const unsupportedAll = loadUnsupportedAll();
                const difficultyAll = loadDifficultyAll();
                const advance = (rowId: number) => { cursor = rowId; saveCursor(line.id, rowId); };
                for (const card of [...cards].sort((a, b) => a.rowId - b.rowId)) {
                    if (card.rowId <= (cursor ?? 0)) continue;
                    if (card.isFromMe || !/gamepigeon/i.test(String(card.balloonBundleId || ''))) { advance(card.rowId); continue; }
                    if (isPoisonPill(line.id, card.rowId)) {
                        const failure = readFailureAll()[failureKey(line.id, card.rowId)] || {};
                        log(`${line.id} ${card.rowId} started ${String(failure.starts)} times without finishing: POISON PILL, skipping`);
                        alertDeadLetter(line.id, card.rowId, { ...failure, attempts: failure.starts, lastError: 'killed the watcher mid-card (poison pill)' });
                        advance(card.rowId);
                        continue;
                    }
                    try {
                        recordDeliveryAttempt(line.id, card.rowId);
                        await handleCard(card, rbAll, unsupportedAll, line, difficultyAll);
                        advance(card.rowId);
                        try { clearDeliveryFailure(line.id, card.rowId); }
                        catch (clearErr) { log(`${line.id} ${card.rowId} could not clear delivery fence: ${(clearErr as Caught).message}`); }
                    } catch (e) {
                        if ((e as Caught)?.code === 'EGAME_NOT_READY') {
                            log(`${line.id} ${card.rowId} ${(e as Caught).message}`);
                            break;
                        }
                        const failure = recordDeliveryFailure(line.id, card.rowId, e);
                        if (failure.deadLetter) {
                            log(`${line.id} ${card.rowId} failed ${String(failure.attempts)} times: DEAD LETTER, advancing: ${(e as Caught).message}`);
                            alertDeadLetter(line.id, card.rowId, failure);
                            advance(card.rowId);
                            continue;
                        }
                        log(`${line.id} ${card.rowId} failed attempt ${String(failure.attempts)}/${MAX_ATTEMPTS}, cursor held for retry: ${(e as Caught).message}`);
                        break; // keep row order; retry this card on the next poll
                    }
                }
            } catch (e) {
                const t = now();
                const same = lastErr === (e as Caught).message;
                if (!same || (t - lastErrLoggedAt) > 60000) {
                    log(`${line.id} line poll error: ${(e as Caught).message}${same ? ' (still, quiet 60s)' : ''}`);
                    lastErrLoggedAt = t;
                }
                lastErr = (e as Caught).message;
                hadErr = true;
            } finally {
                running = false;
            }
        }
        return { poll, getCursor: () => cursor };
    }

    return {
        makeLinePoller,
        drainFinishOutbox,
        handleUnsupportedGame,
        resolveGameAnchor,
        loadAnchorAll,
        readFailureAll,
        isPoisonPill,
        loadRbAll,
        readOutbox,
    };
}

// ---- real decode / archive (macOS) ------------------------------------------------
// Converts the binary-plist payload to xml1 with plutil, pulls the data: URL
// and runs it through the cipher. The .bin stays on disk as the reply template.
export function decodeCardWithPlutil(payload: Buffer, tag: string, plutil = '/usr/bin/plutil'): Decoded {
    if (payload.length > CARD_BIN_MAX_BYTES) {
        throw new Error('card payload too large (' + payload.length + ' > ' + CARD_BIN_MAX_BYTES + ' bytes)');
    }
    const binPath = join(tmpdir(), `gp_line_${tag.replace(/[^\w.-]/g, '_')}.bin`);
    const xml = binPath.replace(/\.bin$/, '') + '.xml';
    writeFileSync(binPath, payload);
    try { unlinkSync(xml); } catch { /* nothing stale */ }
    let content: string;
    try {
        // `plutil -convert xml1` materializes every plist reference, so expansion
        // is exponential in nesting depth: a 154-byte bomb produced 100MB in 1.9s.
        // `ulimit -f` is a KERNEL write ceiling (plutil dies on SIGXFSZ), and the
        // timeout covers a convert that spins without writing.
        execFileSync('/bin/sh', [
            '-c',
            'ulimit -f ' + CARD_XML_MAX_BLOCKS + '; exec "$0" -convert xml1 "$1" -o "$2"',
            plutil, binPath, xml,
        ], { timeout: PLUTIL_TIMEOUT_MS });
        const xmlBytes = statSync(xml).size;
        if (xmlBytes > CARD_XML_MAX_BYTES) throw new Error('card payload expanded too far (' + xmlBytes + ' bytes)');
        content = readFileSync(xml, 'utf8');
    } catch (e) {
        try { unlinkSync(binPath); } catch { /* best effort */ }
        throw e;
    } finally {
        try { unlinkSync(xml); } catch { /* best effort */ }
    }
    const m = content.match(/<string>(data:\?ver=[\s\S]*?)<\/string>/);
    if (!m) {
        try { unlinkSync(binPath); } catch { /* best effort */ }
        throw new Error('no data: URL string in archive');
    }
    const url = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    return { state: cipher.parseEnvelope(url) as unknown as WireState, templateBin: binPath };
}

// gp-archive <template.bin> <url-file> <new|reuse> <caption> <ldtext> <out.bin>
export function archiveWithGpArchive(gpArchive: string, log: (message: string) => void) {
    return (templateBin: string, url: string, mode: 'new' | 'reuse', caption: string, ldtext: string): Buffer => {
        const stamp = `${Date.now()}_${randomInt(1e9)}`;
        const urlFile = join(tmpdir(), `gp_reply_url_${stamp}.txt`);
        const outBin = join(tmpdir(), `gp_reply_${stamp}.bin`);
        writeFileSync(urlFile, url);
        try {
            const out = execFileSync(gpArchive, [templateBin, urlFile, mode, caption, ldtext, outBin], { encoding: 'utf8' }).trim();
            log(`gp-archive: ${out.slice(0, 200)}`);
            return readFileSync(outBin);
        } finally {
            for (const f of [urlFile, outBin]) { try { unlinkSync(f); } catch { /* best effort */ } }
        }
    };
}

// A GamePigeon player id looks like a UUID with 6 extra base62 characters.
function base62(n: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[randomInt(alphabet.length)];
    return out;
}
export const DEFAULT_AVATAR =
    'body,1|eyes,1|mouth,1|acc,0|wins,0|bg_color,0.1,0.5,0.9|body_color,0.99,0.69,0.43|' +
    'glasses,0|stache,0|backdrop,0|hair,3|clothes,1|hair_color,0.25,0.05,0.01|clothes_color,0.1,0.3,0.8';

// The bot's GamePigeon identity, created once and kept in the state dir.
export function loadIdentity(dataDir: string, avatar: string): Identity {
    const path = join(dataDir, 'player.json');
    try {
        const j = JSON.parse(readFileSync(path, 'utf8')) as Identity | null;
        if (j && j.uuid && j.avatar) return { uuid: j.uuid, avatar: avatar || j.avatar };
    } catch { /* create below */ }
    const identity = { uuid: randomUUID().toUpperCase() + base62(6), avatar: avatar || DEFAULT_AVATAR };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify(identity, null, 2));
    return identity;
}

// Read-only STOP check against the agent's database. A missing database means
// no one has opted out yet.
export function createOptOutCheck(databasePath: string): (handle: string) => boolean {
    return (handle) => {
        if (!databasePath || !existsSync(databasePath)) return false;
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const row = db.prepare("SELECT opted_out FROM contacts WHERE channel = 'imessage' AND handle = ?").get(handle) as { opted_out?: number } | undefined;
            return Number(row?.opted_out) === 1;
        } catch {
            return false;
        } finally {
            db.close();
        }
    };
}

// Per-line tweak secret: TWEAK_SECRET_<LINE> (line id upper-cased, other
// characters as _), else the shared TWEAK_SECRET.
export function tweakSecretFor(lineId: string): string {
    return env(`TWEAK_SECRET_${lineId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`) || env('TWEAK_SECRET');
}

// Runs only when started directly, so tests can import the pieces above.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
    loadEnvFile();
    const logger = createLogger('games');
    const log = (message: string) => logger.info(message);
    const alert = createAlerter(env('ALERT_SLACK_WEBHOOK_URL'), (m) => logger.warn(m));
    const dataDir = gamesDataDir();
    const dryRun = envBool('GAMES_DRY_RUN');
    const bridges = envMap('IMESSAGE_LINES');
    const bridgeKey = env('BRIDGE_KEY');
    const lines: GameLine[] = [];
    for (const [id, url] of Object.entries(envMap('GAME_LINES'))) {
        const secret = tweakSecretFor(id);
        if (!secret) { logger.warn(`line ${id}: no TWEAK_SECRET_${id.toUpperCase()} or TWEAK_SECRET; not playing on it`); continue; }
        lines.push({ id, tweak: createTweakClient({ url: url.replace(/\/+$/, ''), secret }) });
    }

    const sendText = async (lineId: string, to: string, text: string) => {
        const bridge = bridges[lineId];
        if (!bridge) throw new Error(`no IMESSAGE_LINES entry for ${lineId}; cannot text`);
        const response = await fetch(`${bridge.replace(/\/+$/, '')}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': bridgeKey },
            body: JSON.stringify({ to, text }),
            signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`bridge /send answered ${response.status}`);
    };

    const dictPath = env('GAMES_DICT_PATH', '/usr/share/dict/words');
    const t0 = Date.now();
    const dict = parseDictionary(readFileSync(dictPath, 'utf8'));
    log(`dictionary loaded: ${dict.words.size} words in ${Date.now() - t0} ms from ${dictPath}`);
    const identity = loadIdentity(dataDir, env('GAMES_PLAYER_AVATAR'));

    const watcher = createWatcher({
        lines,
        dataDir,
        dict,
        identity,
        log,
        alert,
        decodeCard: (payload, tag) => decodeCardWithPlutil(payload, tag, env('PLUTIL_PATH', '/usr/bin/plutil')),
        archiveReply: archiveWithGpArchive(env('GP_ARCHIVE_PATH', join(dataDir, 'gp-archive')), log),
        sendText,
        isOptedOut: createOptOutCheck(env('DATABASE_PATH', 'data/agent.sqlite')),
        dryRun,
        finishText: process.env.GAMES_FINISH_TEXT ?? 'gg',
        maxAttempts: envInt('GAMES_MAX_ATTEMPTS', 3),
    });

    log(`booting ${dryRun ? '(DRY RUN)' : '(LIVE)'}; player ${identity.uuid.slice(0, 8)}...; state in ${dataDir}`);
    if (!lines.length) log('no game lines configured (set GAME_LINES=phone1=http://PHONE_IP:8799)');
    const pollMs = envInt('GAMES_POLL_MS', 2500);
    for (const line of lines) {
        const poller = watcher.makeLinePoller(line);
        log(`polling line ${line.id} every ${pollMs} ms; cursor=${String(poller.getCursor())}`);
        void poller.poll();
        setInterval(() => void poller.poll(), pollMs);
    }
    void watcher.drainFinishOutbox();
    setInterval(() => void watcher.drainFinishOutbox(), 5000).unref();
}
