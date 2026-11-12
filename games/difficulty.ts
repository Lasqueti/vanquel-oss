// games/difficulty.ts
// Per-opponent difficulty store. The watcher reads difficulty.json every poll,
// so a level changed here takes effect on the next card with no restart.
//
// Set a level from a terminal (run from the repo root):
//   node games/difficulty.ts +15550100001 "darts harder"
//   node games/difficulty.ts +15550100001 chill
//   node games/difficulty.ts +15550100001 reset
// In production the same function was driven by the AI model when a player
// said "go easy" or "try harder"; here it is an operator command.
//
// KEYING: the watcher keys by the phone digits it derives from the chat guid
// (e.g. "15550100001"). We write the level under every plausible digit form
// (bare 10-digit, 11-digit with the leading country code 1), and the watcher's
// lookup is tolerant of the 10-vs-11 split too.
//
// LADDER (easier <-> harder): chill < match < sweat < max. 'reset' clears the
// entry so the watcher falls back to its adaptive rubber band.
//   File shape: { "<phoneKey>": "chill"|"match"|"sweat",           // global
//                 "<phoneKey>#<gameId>": "chill"|... }             // per game
// A per-game entry wins over the global one, so "darts harder" moves only
// darts while a plain "chill" (no game named) moves every game.
//
// 'max' is accepted but STORED as 'sweat': a literal stored 'max' makes the
// word games submit the whole board and the aim games play flawlessly, which
// reads as an aimbot. 'sweat' maps to fair-play's SKILL_CAP (a strong human).
//
// GLOBAL writes SWEEP per-game keys: the watcher's per-game lookup wins, so a
// surviving "<key>#<game>" entry would silently override a later global level
// forever. A setting with no game named clears every per-game key for that
// player first, so the latest setting always wins.
//
// Fixed modes carry a release lease (recordFixedDifficultyResult): 'max'
// returns to adaptive after two bot wins, 'sweat' after three bot losses.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Row = Record<string, unknown>;
interface Lease { releaseAfterWins?: unknown; releaseAfterLosses?: unknown; wins?: unknown; losses?: unknown }
export interface DifficultyRelease { reset: boolean; reason?: 'max_wins' | 'hard_losses' | null; game?: string | null; wins?: number; losses?: number; releaseAfterWins?: number; releaseAfterLosses?: number }

export const MAX_WINS_BEFORE_RESET = 2;
export const HARD_LOSSES_BEFORE_RESET = 3;
export const LADDER = ['chill', 'match', 'sweat', 'max'];
const LEVELS = new Set<unknown>(LADDER);
const SETTINGS = new Set<unknown>([...LADDER, 'easier', 'harder', 'reset', 'adaptive']);

// Natural-language game names -> the gameId the watcher and rubber band key on.
// Longest aliases are matched first so "mini golf" beats a stray "golf" token.
export const GAME_ALIASES: Record<string, string> = {
    'word hunt': 'hunt', 'wordhunt': 'hunt', 'hunt': 'hunt', 'wh': 'hunt',
    'anagrams': 'anagrams', 'anagram': 'anagrams',
    'word bites': 'wordbites', 'wordbites': 'wordbites', 'bites': 'wordbites',
    'darts': 'darts', 'dart': 'darts',
    'archery': 'archery', 'archer': 'archery',
    'basketball': 'basketball', 'bball': 'basketball', 'hoops': 'basketball', 'knockout': 'basketball',
    'dots and boxes': 'dots', 'dots': 'dots', 'boxes': 'dots',
    'mini golf': 'golf', 'minigolf': 'golf', 'golf': 'golf', 'putt putt': 'golf', 'putt': 'golf',
    'pool': 'pool', '8 ball': 'pool', '8ball': 'pool', 'eight ball': 'pool', 'billiards': 'pool',
    'cup pong': 'beer', 'cuppong': 'beer', 'beer pong': 'beer', 'pong': 'beer', 'beer': 'beer',
    'tanks': 'tanks', 'tank': 'tanks',
    'filler': 'fill', 'fill': 'fill',
};
const ALIAS_KEYS = Object.keys(GAME_ALIASES).sort((a, b) => b.length - a.length);

// parseArg("darts harder" | "easier" | "mini golf chill" | "max") ->
//   { game: <gameId>|null, setting: <level word> }, in any order.
export function parseArg(arg: unknown): { game: string | null; setting: string } {
    const raw = String(arg == null ? '' : arg).trim().toLowerCase().replace(/[:_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) return { game: null, setting: '' };
    let game: string | null = null;
    let rest = raw;
    for (const a of ALIAS_KEYS) {
        const re = new RegExp('(^|\\s)' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
        if (re.test(raw)) { game = GAME_ALIASES[a]; rest = raw.replace(re, ' ').trim(); break; }
    }
    let setting = '';
    for (const t of rest.split(' ')) { if (SETTINGS.has(t)) { setting = t; break; } }
    if (!setting) for (const t of raw.split(' ')) { if (SETTINGS.has(t)) { setting = t; break; } }
    return { game, setting: setting || rest || raw };
}

// Candidate keys the watcher might derive from a 1:1 chat guid. For an email
// handle we key by the lowercased address itself.
export function phoneKeys(handle: unknown): string[] {
    const raw = String(handle || '').trim();
    if (raw.includes('@')) return [raw.toLowerCase()];
    const digits = raw.replace(/\D/g, '');
    if (!digits) return [];
    const keys = new Set([digits]);
    if (digits.length === 10) keys.add('1' + digits);
    if (digits.length === 11 && digits[0] === '1') keys.add(digits.slice(1));
    return [...keys];
}

// The strongest level ever STORED (see the header).
const STORE_CAP = 'sweat';
function capLevel(level: unknown) {
    return level === 'max' ? STORE_CAP : level;
}

// Resolve a setting to the next level.
//   chill|match|sweat|max -> that level ('max' stores as 'sweat')
//   reset|adaptive        -> null (clears the entry)
//   easier|harder         -> one step down/up from the current level
// Returns { level } or null when the setting is unrecognized.
export function resolveLevel(arg: unknown, currentLevel: unknown): { level: unknown } | null {
    const a = String(arg || '').trim().toLowerCase();
    if (a === 'reset' || a === 'adaptive') return { level: null };
    if (LEVELS.has(a)) return { level: capLevel(a) };
    if (a === 'easier' || a === 'harder') {
        const base = LEVELS.has(currentLevel) ? currentLevel : 'match';
        let i = LADDER.indexOf(base as string);
        i += a === 'harder' ? 1 : -1;
        i = Math.max(0, Math.min(LADDER.length - 1, i));
        return { level: capLevel(LADDER[i]) };
    }
    return null;
}

export function createDifficultyStore(dataDir: string) {
    const DIFFICULTY_FILE = join(dataDir, 'difficulty.json');
    const DIFFICULTY_META_FILE = join(dataDir, 'difficulty-meta.json');

    function readJson(file: string): Row {
        try {
            const j: unknown = JSON.parse(readFileSync(file, 'utf8'));
            if (j && typeof j === 'object') return j as Row;
        } catch { /* none yet */ }
        return {};
    }
    const readAll = () => readJson(DIFFICULTY_FILE);
    const readMeta = () => readJson(DIFFICULTY_META_FILE);

    // Atomic write so the watcher never reads a half-written file mid-poll.
    function writeJsonAtomic(file: string, value: unknown) {
        mkdirSync(dataDir, { recursive: true });
        const tmp = file + '.tmp';
        writeFileSync(tmp, JSON.stringify(value, null, 2));
        renameSync(tmp, file);
    }
    const writeAll = (all: Row) => writeJsonAtomic(DIFFICULTY_FILE, all);
    const writeMeta = (meta: Row) => writeJsonAtomic(DIFFICULTY_META_FILE, meta);

    function clearPlayer(keys: string[], all: Row, meta: Row) {
        for (const k of keys) {
            for (const existing of Object.keys(all)) if (existing === k || existing.startsWith(k + '#')) delete all[existing];
            for (const existing of Object.keys(meta)) if (existing === k || existing.startsWith(k + '#')) delete meta[existing];
        }
    }

    // Current level for a player, or 'adaptive'. A per-game override wins.
    function getDifficulty(handle: unknown, gameId?: unknown): unknown {
        const all = readAll();
        const keys = phoneKeys(handle);
        if (gameId) for (const k of keys) if (all[k + '#' + gameId]) return all[k + '#' + gameId];
        for (const k of keys) if (all[k]) return all[k];
        return 'adaptive';
    }

    // Apply a setting such as "darts harder" or "chill" for one player. With a
    // game named only that game's key moves; with none the write is global and
    // sweeps every per-game key. Returns { changed, level, game }.
    function applyDifficulty(handle: unknown, arg: unknown) {
        const { game, setting } = parseArg(arg);
        const current = getDifficulty(handle, game);
        const resolved = resolveLevel(setting, current === 'adaptive' ? null : current);
        if (!resolved) return { changed: false, level: null, game: game || null };

        const all = readAll();
        const meta = readMeta();
        const keys = phoneKeys(handle);
        const lease = () => setting === 'max'
            ? { kind: 'max', wins: 0, releaseAfterWins: MAX_WINS_BEFORE_RESET, startedAt: Date.now() }
            : resolved.level === 'sweat'
                ? { kind: 'hard', losses: 0, releaseAfterLosses: HARD_LOSSES_BEFORE_RESET, startedAt: Date.now() }
                : null;
        if (!game) {
            clearPlayer(keys, all, meta);
            if (resolved.level != null) {
                for (const k of keys) {
                    all[k] = resolved.level;
                    const l = lease();
                    if (l) meta[k] = l;
                }
            }
        } else {
            const suffix = '#' + game;
            if (resolved.level == null) {
                // A targeted reset must mean adaptive even while a global fixed
                // mode is active: store an explicit adaptive override then.
                const hasGlobalFixed = keys.some((k) => all[k] && all[k] !== 'adaptive');
                for (const k of keys) {
                    if (hasGlobalFixed) all[k + suffix] = 'adaptive';
                    else delete all[k + suffix];
                    delete meta[k + suffix];
                }
            } else {
                for (const k of keys) {
                    all[k + suffix] = resolved.level;
                    const l = lease();
                    if (l) meta[k + suffix] = l;
                    else delete meta[k + suffix];
                }
            }
        }
        writeAll(all);
        writeMeta(meta);
        return { changed: true, level: resolved.level == null ? 'adaptive' : resolved.level, game: game || null };
    }

    // Fixed modes carry an automatic release lease. MAX returns to adaptive
    // after two bot wins so it cannot stay oppressive; sweat returns after three
    // bot losses, once the player has shown they can handle it. Counts are
    // cumulative while the lease is active.
    function recordFixedDifficultyResult(handle: unknown, gameId: unknown, botWon: unknown): DifficultyRelease {
        const keys = phoneKeys(handle);
        if (!keys.length) return { reset: false };

        const all = readAll();
        const meta = readMeta();
        const suffix = gameId ? '#' + gameId : '';

        // Same precedence as the watcher: per-game override first, then global.
        let scopedGame: string | null = null;
        let scopeKeys: string[] = [];
        if (gameId) {
            scopeKeys = keys.map((k) => k + suffix).filter((k) => all[k] != null);
            if (scopeKeys.length) scopedGame = String(gameId);
        }
        if (!scopeKeys.length) scopeKeys = keys.filter((k) => all[k] != null);

        const leaseOf = (k: string) => meta[k] as Lease;
        const maxTracked = scopeKeys.filter((k) => meta[k] && Number(leaseOf(k).releaseAfterWins) > 0);
        const hardTracked = scopeKeys.filter((k) => meta[k] && Number(leaseOf(k).releaseAfterLosses) > 0);
        let tracked: string[];
        let reason: 'max_wins' | 'hard_losses';
        let count: number;
        let releaseAfter: number;

        if (maxTracked.length && botWon === true) {
            tracked = maxTracked;
            reason = 'max_wins';
            count = tracked.reduce((n, k) => Math.max(n, Number(leaseOf(k).wins) || 0), 0) + 1;
            releaseAfter = tracked.reduce((n, k) => Math.min(n, Number(leaseOf(k).releaseAfterWins) || MAX_WINS_BEFORE_RESET), MAX_WINS_BEFORE_RESET);
        } else if (hardTracked.length && botWon === false) {
            tracked = hardTracked;
            reason = 'hard_losses';
            count = tracked.reduce((n, k) => Math.max(n, Number(leaseOf(k).losses) || 0), 0) + 1;
            releaseAfter = tracked.reduce((n, k) => Math.min(n, Number(leaseOf(k).releaseAfterLosses) || HARD_LOSSES_BEFORE_RESET), HARD_LOSSES_BEFORE_RESET);
        } else {
            return { reset: false };
        }

        const result = reason === 'max_wins' ? { wins: count, releaseAfterWins: releaseAfter } : { losses: count, releaseAfterLosses: releaseAfter };
        if (count < releaseAfter) {
            const stamp = reason === 'max_wins' ? { wins: count, lastWinAt: Date.now() } : { losses: count, lastLossAt: Date.now() };
            for (const k of tracked) meta[k] = { ...(meta[k] as object), ...stamp };
            writeMeta(meta);
            return { reset: false, reason, ...result, game: scopedGame };
        }

        if (scopedGame) {
            const hasGlobalFixed = keys.some((k) => all[k] && all[k] !== 'adaptive');
            for (const k of keys) {
                if (hasGlobalFixed) all[k + suffix] = 'adaptive';
                else delete all[k + suffix];
                delete meta[k + suffix];
            }
        } else {
            // A global MAX applied to every game, so its release does too.
            clearPlayer(keys, all, meta);
        }
        writeAll(all);
        writeMeta(meta);
        return { reset: true, reason, ...result, game: scopedGame };
    }

    return { getDifficulty, applyDifficulty, recordFixedDifficultyResult, DIFFICULTY_FILE, DIFFICULTY_META_FILE };
}

export type DifficultyStore = ReturnType<typeof createDifficultyStore>;

export function gamesDataDir(): string {
    return resolve(process.env.GAMES_STATE_DIR || 'data/games');
}

// Runs only when started directly: node games/difficulty.ts <handle> "<setting>"
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
    const [handle, ...rest] = process.argv.slice(2);
    if (!handle || !rest.length) {
        console.log('usage: node games/difficulty.ts <phone or email> "<chill|match|sweat|max|easier|harder|reset> [game]"');
        process.exitCode = 2;
    } else {
        const out = createDifficultyStore(gamesDataDir()).applyDifficulty(handle, rest.join(' '));
        console.log(out.changed ? `difficulty now ${out.level}${out.game ? ` for ${out.game}` : ' for every game'}` : 'setting not recognized; nothing changed');
    }
}
