// games/rubber-band.ts
import type { GameRandom, GameHash, WordScore, AdaptiveRead, ReferenceRead, SubmissionRead, AdaptiveUpdateRead, AdaptiveUpdateResult } from './strength-types.ts';
// =============================================================================
// Shared rubber-band handicap policy for word games (pure, no I/O)
// =============================================================================
//
// This is the generic form of the handicap that ships inline in
// wordhunt-play.ts. Word Hunt keeps its own decideMove (the live, verified path)
// but now imports the HARD logic (word portfolio + reference) from HERE so there
// is ONE source of truth; the NEWER word games (Anagrams, Word Bites) share this
// module wholesale. The self-tuning `updateAdaptiveState` also lives HERE ONLY so
// both the shared games and Word Hunt step one factor per game through the watcher.
//
// Policy: pick a PROPORTIONAL SCORE TARGET, then submit a NATURAL HUMAN PORTFOLIO
// of words that adds up to that target - mostly short/medium words with a few
// long ones, a plausible word COUNT (~10-30 for Word Hunt), NOT three monster
// words. The target is `ref * factor * jitter` (then capped to the board):
//   - ref    = BOARD-RELATIVE when the caller passes this board's findable total
//              (Bot solves the whole board): a fraction of that findable total,
//              tracking the opponent's score when it's visible. When Bot OPENS a
//              game (no opponent score anywhere) the reference is
//              HUMAN_FIND_FRACTION * findable, so a rich seed gives a high target
//              and a barren seed a low one automatically - never a flat default.
//              Games that don't pass a board (darts/archery, and today's
//              anagrams/wordbites) fall back to: opponent score if visible, else
//              their DEMONSTRATED per-game skill, else the legacy cross-game
//              average, else DEFAULT_USER_SCORE.
//   - factor = the handicap. Fixed difficulties map to a fixed multiplier;
//              ADAPTIVE self-tunes toward a ~50% win rate (see below).
//   - jitter = deterministic -10%..+10% wobble so games don't feel robotic.
// This makes chill (0.45x) land clearly under the user, match (1.00x) a coin
// flip, sweat (1.30x) a close loss for the user, and max the full solve.
//
// ADAPTIVE (default) is a self-tuning "match": it starts near 1.00 and, after
// each finished game, nudges the factor DOWN when Bot won (ease off) and UP
// when Bot lost (push), clamped to [ADAPTIVE_MIN, ADAPTIVE_MAX]. Over a handful
// of games it converges on whatever multiplier yields ~50% for that opponent.
// The reference tracks the opponent's DEMONSTRATED skill PER GAME (Word Hunt
// scores in the thousands must never be mixed with Darts scores in the hundreds),
// so a strong player gets a genuinely competitive Bot and a weak one a gentle
// Bot, with the factor doing the fine ~50% tuning on top.
//
// rbState = { gamesPlayed, userLastWords, lastBotResult ('W'|'L'|null),
//             adaptiveFactor?, adaptiveFactors?, seedFactor?, userAvgScore?,
//             recentResults?, scoreStats?,
//             difficulty? ('chill'|'match'|'sweat'|'max'|'adaptive') }
//   scoreStats      = { <gameId>: { avg, best, n } }  (per-game demonstrated skill)
//   adaptiveFactors = { <gameId>: <factor> }  (PER-GAME self-tuned factor)
//   seedFactor      = frozen migration snapshot of the pre-split shared factor
//
// PER-GAME FACTORS (the cross-game-bleed fix): each game keeps its OWN adaptive
// factor in `adaptiveFactors`, keyed by gameId, so being strong at Word Hunt (which
// pushes the hunt factor UP) never makes Darts harder. `adaptiveFactor` (top level)
// is kept as a legacy mirror of the LAST-played game's factor + the one-time
// migration source: a pre-split record with a single `adaptiveFactor` seeds each
// game's factor from it on that game's first post-split play (frozen into
// `seedFactor` so second-and-later new game types don't inherit another game's
// since-evolved value). resolveGameFactor() encodes this; handicapFactor() stays
// byte-compatible (the watcher overlays the resolved per-game value onto
// rbState.adaptiveFactor before each move, so every game module reads its own).
//
// DIFFICULTY (per-opponent, default 'adaptive'):
//   'adaptive' (or unset) -> the self-tuning score target above.
//   'chill'  -> intentionally weak, aim well under the user (0.45x score).
//   'match'  -> aim roughly even with the user (1.00x score).
//   'sweat'  -> aim to win but not crush (1.30x score, still a human portfolio).
//   'max'    -> full strength: submit the ENTIRE solve (chooseSubmission bypasses the trim).
// A fixed difficulty overrides the adaptive tuning entirely (deterministic feel):
// the user gets exactly the level they asked for, game after game, until reset.
// =============================================================================

const MIN_WORDS = 3;           // never submit fewer than this
const HUMAN_MAX_WORDS = 42;    // even a monster human game rarely tops this

// Adaptive self-tuning knobs (score-multiplier space).
const ADAPTIVE_STEP = 0.07;    // symmetric multiplicative step (win: /1.07, loss: *1.07); was 0.11, smaller since 2026-10-03 so one result never swings it far
const ADAPTIVE_MIN = 0.80;     // floor: even eased all the way down Bot stays a real opponent, never dog-ass (was 0.60 -> 0.08 darts aim)
const ADAPTIVE_MAX = 1.30;     // ceiling: Bot never pushes above this multiplier
const ADAPTIVE_START = 1.00;   // seed factor for a fresh/unknown adaptive record: a fair start (the tester 2026-10-03, the 50% rule; was 1.15 strong since 07-13)
const DEFAULT_USER_SCORE = 4000; // assumed opponent score (legacy, non-board path only)

// BOARD-RELATIVE targeting (word games that pass this board's findable total).
// The score target is a FRACTION of THIS board's findable total, not a flat
// number, so Bot scales to the seed: rich board -> high target, barren board ->
// low target, automatically. HUMAN_FIND_FRACTION is a typical human's share of a
// full computer solve (the BOT-FIRST reference used when no opponent has scored
// yet); BOARD_TARGET_CAP_FRAC caps any target so Bot never aims to look like it
// solved the whole board (an obvious bot / a blowout).
const HUMAN_FIND_FRACTION = 0.30;      // BOT-FIRST reference = this * boardFindable (was 0.22; lifted so Bot's opening/hand-back is a real game, not a gimpy 3-word play)
const BOARD_TARGET_CAP_FRAC = 0.85;    // never intentionally aim above this * boardFindable

// Fixed-difficulty factor overrides, now interpreted as SCORE multipliers.
// 'adaptive' is intentionally absent so it falls through to the self-tuning
// path below. 'max' returns a large factor so turn games (archery/darts) that
// only read handicapFactor aim near-perfect; word games short-circuit to
// "submit everything" in chooseSubmission.
const DIFFICULTY_FACTOR: Record<PropertyKey, unknown> = {
    chill: 0.45, // clearly under the user
    match: 1.00, // roughly even
    sweat: 1.30, // wins but doesn't obliterate
    max: 3.00,   // effectively "as good as possible"
};

// Word games compare directly against the opponent's visible score. Feeding the
// aim-game factors above straight into that path made fixed modes deterministic:
// chill's 0.45 could never upset the user and sweat's 1.30 almost never lost. Use
// narrower human score targets plus deterministic wobble that crosses 1.0 rarely
// on easy and occasionally on hard. The aim/physics games keep DIFFICULTY_FACTOR.
const WORD_DIFFICULTY_FACTOR: Record<PropertyKey, unknown> = { chill: 0.82, match: 1.00, sweat: 1.10 };
const FIXED_JITTER: Record<PropertyKey, number[]> = {
    chill: [0.92, 1.00, 0.96, 1.02, 0.90, 1.30, 0.98, 0.94], // rare upset
    match: [0.90, 1.08, 0.96, 1.12, 0.92, 1.04],             // genuine coin-flip band
    sweat: [1.03, 0.98, 1.05, 0.82, 1.00, 1.07],             // strong human, not guaranteed
};

function wordTargetFactor(state: AdaptiveRead | null | undefined): unknown {
    const diff = state && state.difficulty;
    return WORD_DIFFICULTY_FACTOR[diff as PropertyKey] != null ? WORD_DIFFICULTY_FACTOR[diff as PropertyKey] : handicapFactor(state);
}

function targetJitter(state: AdaptiveRead | null | undefined, gamesPlayed: number, gameId: PropertyKey | undefined): unknown {
    const seq = state && FIXED_JITTER[state.difficulty as PropertyKey];
    const perGameN = state && gameId && state.scoreStats && state.scoreStats[gameId]
        ? Number(state.scoreStats[gameId].n) : null;
    const phase = Number.isFinite(perGameN) ? perGameN as number : gamesPlayed;
    if (seq) return seq[phase % seq.length];
    return 1 + (((gamesPlayed * 5) % 21) - 10) / 100;
}

function clamp(x: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, x));
}

// -----------------------------------------------------------------------------
// mulberry32(seed) -> rng() in [0,1). Tiny deterministic PRNG so word-portfolio
// selection is reproducible (testable, no Math.random in the decision path).
// -----------------------------------------------------------------------------
function mulberry32(seed: number) {
    let a = (seed >>> 0) || 1;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// hashSeed(...args) -> uint32. Fold arbitrary numbers/strings into one 32-bit
// seed so the portfolio varies game to game yet is fully deterministic per state.
function hashSeed(...values: Parameters<GameHash>): number;
function hashSeed() {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arguments.length; i++) {
        const s = String(arguments[i]);
        for (let j = 0; j < s.length; j++) {
            h ^= s.charCodeAt(j);
            h = Math.imul(h, 16777619) >>> 0;
        }
        h ^= 0x9e3779b9;
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

// Seed an adaptive factor from a legacy on-disk record (pre-adaptive fields) so
// nothing needs migrating: a record where Bot won last eases off, lost last
// pushes, otherwise the neutral start.
function seedFromLegacy(s: unknown) {
    const state = (s as AdaptiveRead | null | undefined) || {};
    if (state.lastBotResult === 'W') return 0.80;
    if (state.lastBotResult === 'L') return 1.10;
    return ADAPTIVE_START;
}

// -----------------------------------------------------------------------------
// resolveGameFactor(rbState, gameId) -> the raw per-game factor (pre-clamp) for
// THIS game, handling migration. The watcher overlays the result onto
// rbState.adaptiveFactor before each move so handicapFactor (which reads
// adaptiveFactor) stays byte-compatible while every game gets its own factor.
//
//   1. Established per-game factor  -> adaptiveFactors[gameId].
//   2. Post-split record, new game type -> the frozen migration seed if present,
//      else NEUTRAL (ADAPTIVE_START). Never another game's evolved factor: THIS
//      is what stops Word-Hunt strength from raising Darts difficulty.
//   3. Legacy record (no per-game map yet) -> MIGRATE from the shared adaptiveFactor
//      (or seedFromLegacy) so an existing player's tuned level carries into the
//      first game of each type.
// -----------------------------------------------------------------------------
function resolveGameFactor(rbState: unknown, gameId: PropertyKey | null | undefined): unknown {
    const state = (rbState as AdaptiveRead | null | undefined) || {};
    const factors = (state.adaptiveFactors && typeof state.adaptiveFactors === 'object')
        ? state.adaptiveFactors : null;
    if (factors && gameId != null && Number.isFinite(factors[gameId])) return factors[gameId];
    if (factors) {
        // post-split record, brand-new game type: frozen migration seed or neutral.
        return Number.isFinite(state.seedFactor) ? state.seedFactor as number : ADAPTIVE_START;
    }
    // legacy record: migrate from the single shared factor.
    if (Number.isFinite(state.adaptiveFactor)) return state.adaptiveFactor as number;
    return seedFromLegacy(state);
}

// Per-game experience count. Once the split map exists, a brand-new game starts
// at zero even if the opponent has played many rounds of another game. Legacy
// records fall back to scoreStats (best signal) then the old global counter.
function resolveGameCount(rbState: unknown, gameId: PropertyKey | null | undefined) {
    const state = (rbState as AdaptiveRead | null | undefined) || {};
    const byGame = state.gamesPlayedByGame && typeof state.gamesPlayedByGame === 'object'
        ? state.gamesPlayedByGame : null;
    if (byGame && gameId != null) {
        const count = Number(byGame[gameId]);
        return Number.isFinite(count) && count >= 0 ? count : 0;
    }
    const statCount = gameId && state.scoreStats && state.scoreStats[gameId]
        ? Number(state.scoreStats[gameId].n) : NaN;
    if (Number.isFinite(statCount) && statCount >= 0) return statCount;
    const legacy = Number(state.gamesPlayed);
    return Number.isFinite(legacy) && legacy >= 0 ? legacy : 0;
}

// -----------------------------------------------------------------------------
// handicapFactor(rbState) -> score multiplier.
// A fixed difficulty (chill/match/sweat/max) overrides the adaptive tuning; an
// unset or 'adaptive' difficulty uses the self-tuned factor (seeded from a
// legacy record on first read), clamped to the adaptive band.
// -----------------------------------------------------------------------------
function handicapFactor(rbState: unknown): unknown {
    const state = (rbState as AdaptiveRead | null | undefined) || {};
    const diff = state.difficulty;
    if (diff && diff !== 'adaptive' && DIFFICULTY_FACTOR[diff] != null) {
        return DIFFICULTY_FACTOR[diff];
    }
    const gamesPlayed = state.gamesPlayed || 0;
    if (gamesPlayed === 0) return ADAPTIVE_START;        // first game of a type: a fair start, then the self-tuner follows the results (the tester 2026-10-03; was 1.30, Bot came out strong and won it)
    return clamp(
        state.adaptiveFactor != null ? state.adaptiveFactor : seedFromLegacy(state),
        ADAPTIVE_MIN,
        ADAPTIVE_MAX
    );
}

// -----------------------------------------------------------------------------
// referenceScore(rbState, { gameId, oppScoreVisible, defaultUserScore,
//                           boardFindable, humanFraction })
//   -> the score the target is built from.
//
// Opponent skill estimate (strongest signal first):
//   1. oppScoreVisible  - this game's real opponent score (Bot is answering it).
//   2. per-game DEMONSTRATED estimate - a blend of the opponent's recent average
//      and their best score for THIS game (scoreStats[gameId]), leaning toward
//      their best so Bot can contest a STRONG player it plays blind.
//   3. legacy cross-game userAvgScore (older records with no per-game stats).
//
// BOARD-RELATIVE (when boardFindable is a positive finite number - Bot solved
// the whole board, so it knows the max achievable on this seed):
//   - No opponent estimate (BOT-FIRST: Bot opens, nobody has scored yet):
//     reference = humanFraction * boardFindable. NEVER a flat default. This is
//     what makes a rich seed yield a high reference and a barren seed a low one
//     automatically.
//   - Opponent estimate present: match it, but capped at BOARD_TARGET_CAP_FRAC of
//     findable so a strong player on a rich board is MATCHED, not blown out, and a
//     demonstrated score from OTHER boards can't exceed what THIS board holds.
//     Tracks BOTH the opponent's score and this board's findable total.
//   The result is hard-capped at boardFindable (can't reference more than exists).
//
// LEGACY (no boardFindable - anagrams/wordbites/darts/archery): unchanged -
//   opponent estimate, else a per-game default, else DEFAULT_USER_SCORE. Per-game
//   stats stop a Darts score (hundreds) from dragging a Word Hunt target
//   (thousands) to the floor and vice-versa.
// -----------------------------------------------------------------------------
function referenceScore(rbState: unknown, opts?: ReferenceRead | null): unknown {
    const state = (rbState as AdaptiveRead | null | undefined) || {};
    const o = opts || {};

    // Opponent's absolute skill estimate, strongest signal first.
    let oppEstimate = null;
    if (o.oppScoreVisible != null && Number.isFinite(o.oppScoreVisible)) {
        oppEstimate = o.oppScoreVisible;
    } else {
        const stats = state.scoreStats && o.gameId ? state.scoreStats[o.gameId] : null;
        if (stats && stats.n! > 0 && Number.isFinite(stats.avg)) {
            const best = Number.isFinite(stats.best) ? stats.best : stats.avg;
            // Lean toward their demonstrated ceiling so Bot can actually contest
            // a strong opponent; the factor absorbs any systematic bias to ~50%.
            oppEstimate = Math.round(0.6 * stats.avg! + 0.4 * best!);
        } else if (state.userAvgScore != null && Number.isFinite(state.userAvgScore)) {
            oppEstimate = state.userAvgScore;
        }
    }

    // BOARD-RELATIVE path: reference is a fraction of THIS board's findable total.
    const bf = Number.isFinite(o.boardFindable) && o.boardFindable! > 0 ? o.boardFindable : null;
    if (bf != null) {
        const humanFrac = Number.isFinite(o.humanFraction) ? o.humanFraction : HUMAN_FIND_FRACTION;
        const ref = oppEstimate == null
            ? humanFrac! * bf                                     // BOT-FIRST: no flat default
            : Math.min(oppEstimate, BOARD_TARGET_CAP_FRAC * bf); // matched, never blown out
        return Math.min(ref, bf);                               // can't reference more than the board holds
    }

    // LEGACY path (no boardFindable): byte-identical to the pre-board behaviour.
    if (oppEstimate != null) return oppEstimate;
    return o.defaultUserScore != null ? o.defaultUserScore : DEFAULT_USER_SCORE;
}

// -----------------------------------------------------------------------------
// boardCappedTarget(target, boardFindable) -> target clamped to this board.
// Never above BOARD_TARGET_CAP_FRAC of findable (so Bot doesn't look like it
// solved the whole board) and never above the findable total itself. A no-op when
// boardFindable isn't a positive finite number, so the non-board games stay
// byte-compatible.
// -----------------------------------------------------------------------------
function boardCappedTarget(target: unknown, boardFindable: number | null | undefined): unknown {
    if (!(Number.isFinite(boardFindable) && boardFindable! > 0)) return target;
    const cap = BOARD_TARGET_CAP_FRAC * boardFindable!;
    const t = (target as number) > cap ? cap : target;
    return (t as number) > boardFindable! ? boardFindable : t;
}

// -----------------------------------------------------------------------------
// humanAvgWordValue(target, sMin, sMax) -> the average points-per-word a human
// aiming at `target` would post. Low targets => mostly tiny words (avg near the
// smallest word), high targets => a bigger average (more medium/long words), but
// bounded so the resulting word COUNT stays in a human range. Scaled off the
// game's own scoring table (sMin/sMax) so it works for every word game.
// -----------------------------------------------------------------------------
function humanAvgWordValue(target: number, sMin: number, sMax: number) {
    const lo = sMin * 1.6;
    const hi = Math.min(sMin * 4.4, Math.max(sMin * 2.2, sMax * 0.55));
    // ambition: how big is the target, in units of the smallest word.
    const amb = clamp((target - sMin * 15) / (sMin * 100), 0, 1);
    return clamp(lo + (hi - lo) * amb, lo, hi);
}

function shuffleInPlace<T>(arr: T[], rng: GameRandom) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
}

function weightedPick<T>(items: T[], weights: number[], rng: GameRandom) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    if (!(total > 0)) return items[Math.floor(rng() * items.length)];
    let r = rng() * total;
    for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
    }
    return items[items.length - 1];
}

// -----------------------------------------------------------------------------
// pickHumanPortfolio(sortedWords, targetScore, scoreForWord, seed)
//   -> { words, score }
// Build a NATURAL word set that sums to just under targetScore and LOOKS like a
// human's game: many short/medium words with a few long ones, a plausible count.
//
// How: aim for a human word COUNT (target / humanAvgWordValue), then fill that
// many words one at a time. Each pick is a weighted-random word length whose
// weight favors SHORT words (there are always more of them) and whose proximity
// is centered on the running per-word budget (remaining points / remaining
// picks). A `maxAllowed` guard forbids taking a word so big the rest can't be
// filled, so the total lands just under target using whatever small words finish
// it off. This replaces the old "take the biggest words until you hit target",
// which produced 3 monster words (WISTARIA/AHEM/WIT) and looked robotic.
// Deterministic given `seed`.
// -----------------------------------------------------------------------------
function pickHumanPortfolio(sortedWords: unknown[] | null | undefined, targetScore: number, scoreForWord: WordScore, seed: number): { words: unknown; score: unknown } {
    const all = sortedWords || [];
    if (all.length === 0) return { words: [], score: 0 };

    const rng = mulberry32((seed >>> 0) || 1);

    // Group scorable words by their point value; shuffle each bucket so we don't
    // always submit the same specific words for a given board.
    const byScore = new Map<number, unknown[]>();
    for (const w of all) {
        const s = scoreForWord(w);
        if (!(s > 0)) continue;
        if (!byScore.has(s)) byScore.set(s, []);
        byScore.get(s)!.push(w);
    }
    if (byScore.size === 0) {
        const words = all.slice(0, MIN_WORDS);
        return { words, score: words.reduce<number>((a, w) => a + scoreForWord(w), 0) };
    }
    for (const arr of byScore.values()) shuffleInPlace(arr, rng);
    const distinctScores = [...byScore.keys()].sort((a, b) => a - b); // ascending
    const sMin = distinctScores[0];
    const sMax = distinctScores[distinctScores.length - 1];
    const available = all.filter((w) => scoreForWord(w) > 0).length;

    const target = Math.max(targetScore, sMin); // never a sub-one-word target
    const avpw = humanAvgWordValue(target, sMin, sMax);
    let N = Math.round(target / avpw);
    N = clamp(N, MIN_WORDS, Math.min(available, HUMAN_MAX_WORDS));

    const chosen = [];
    let score = 0;
    for (let i = 0; i < N; i++) {
        const remainingCount = N - i;
        const remainingBudget = target - score;
        const ideal = remainingBudget / remainingCount;
        const avail = distinctScores.filter((s) => byScore.get(s)!.length > 0);
        if (avail.length === 0) break;
        // Don't take a word so big the remaining picks (at sMin each) would blow
        // the budget; leave half a small word of slack so we can land near target.
        const maxAllowed = remainingBudget - (remainingCount - 1) * sMin + sMin * 0.5;
        let pool = avail.filter((s) => s <= maxAllowed);
        if (pool.length === 0) pool = [avail[0]]; // must take the smallest available
        const weights = pool.map((s) => {
            const prox = Math.exp(-Math.pow((s - ideal) / (ideal * 0.75 + sMin), 2));
            const shortBias = Math.pow(sMin / s, 0.6); // more short words, like a human
            return prox * shortBias;
        });
        const pickS = weightedPick(pool, weights, rng);
        chosen.push(byScore.get(pickS)!.pop());
        score += pickS;
    }

    // Floor: never submit fewer than MIN_WORDS (pad with the smallest remaining).
    if (chosen.length < MIN_WORDS) {
        for (const s of distinctScores) {
            const b = byScore.get(s)!;
            while (b.length && chosen.length < MIN_WORDS) { chosen.push(b.pop()); score += s; }
            if (chosen.length >= MIN_WORDS) break;
        }
    }
    return { words: chosen, score };
}

// -----------------------------------------------------------------------------
// pickTopByScore(sortedWords, targetScore, scoreForWord) -> { words, score }
// LEGACY greedy selector (biggest-first-under-target). Kept exported for
// backward compatibility with any external caller/test; the live decision path
// now uses pickHumanPortfolio. Walk the score-sorted words high -> low and take
// each one that still fits under targetScore; pad to MIN_WORDS if needed.
// -----------------------------------------------------------------------------
function pickTopByScore(sortedWords: unknown[], targetScore: number, scoreForWord: WordScore) {
    const words = [];
    let score = 0;
    for (let i = 0; i < sortedWords.length; i++) {
        const w = sortedWords[i];
        const ws = scoreForWord(w);
        if (score + ws <= targetScore) {
            words.push(w);
            score += ws;
        }
    }
    if (words.length < MIN_WORDS) {
        const chosen = new Set(words);
        for (let i = sortedWords.length - 1; i >= 0 && words.length < MIN_WORDS; i--) {
            const w = sortedWords[i];
            if (!chosen.has(w)) {
                chosen.add(w);
                words.push(w);
                score += scoreForWord(w);
            }
        }
    }
    return { words, score };
}

// -----------------------------------------------------------------------------
// chooseSubmission({ rbState, sortedWords, wordCount, oppScoreVisible,
//                    userWordsThisGame, scoreForWord, gameId, defaultUserScore })
//   -> { words, score, mode, targetN }
// The full proportional-score decision, shared across word games. Returns the
// chosen word list, its total score, a mode label, and targetN (null: the
// target is a SCORE, not a word count).
// -----------------------------------------------------------------------------
function chooseSubmission(opts: SubmissionRead): { words: unknown; score: unknown; mode: string; targetN: unknown } {
    const {
        rbState,
        sortedWords,
        oppScoreVisible,
        scoreForWord,
        gameId,
        defaultUserScore, // per-game fallback when nothing about the opponent is known yet
        boardFindable,    // optional: THIS board's findable total -> board-relative target
        humanFraction,    // optional: override the human share-of-board fraction
    } = opts;

    const full = sortedWords || [];

    // MAX difficulty: submit the ENTIRE solve, no trim (the flawless behavior).
    if (rbState && rbState.difficulty === 'max') {
        const words = full.slice();
        const score = words.reduce<number>((s, w) => s + scoreForWord(w), 0);
        return { words, score, mode: 'max:full-solve', targetN: words.length };
    }

    const state = (rbState as AdaptiveRead | null | undefined) || {};
    const factor = wordTargetFactor(state) as number;
    const gamesPlayed = state.gamesPlayed || 0;
    const ref = referenceScore(state, { gameId, oppScoreVisible, defaultUserScore, boardFindable, humanFraction }) as number;
    // Deterministic -10%..+10% jitter. 5 is coprime with 21 so (gamesPlayed*5)%21
    // spans the full residue set (the old *7 only yielded {0,7,14}).
    const jitter = targetJitter(state, gamesPlayed, gameId) as number;
    // boardCappedTarget is a no-op when boardFindable is absent, so the non-board
    // games (anagrams/wordbites) keep byte-identical targets.
    const target = boardCappedTarget(ref * factor * jitter, boardFindable) as number;

    const seed = (hashSeed as GameHash)(gamesPlayed, Math.round(target), full.length, full[0] || '');
    const picked = pickHumanPortfolio(full, target, scoreForWord, seed);
    return { words: picked.words, score: picked.score, mode: 'score-target', targetN: null };
}

// -----------------------------------------------------------------------------
// updateAdaptiveState(rbState, { botWon, oppScore, gameId })
//   -> { adaptiveFactor, userAvgScore, recentResults, scoreStats }
// Pure self-tuner run once per FINISHED game by the watcher. Nudges the factor
// toward a ~50% win rate, tracks the opponent's demonstrated skill PER GAME, and
// keeps the last 10 W/L/D results for observability.
//
// CONTAMINATION GUARD (word games only): an abandoned Word Hunt / Anagrams /
// Word Bites game shows up as a Bot "win" with the opponent's score 0/blank.
// Counting those as real wins is what drove Bot to the easy floor during the tester's
// streak, so it was at its weakest when he finally played for real. A word-game
// win with no positive opponent score does NOT ease the factor and does NOT
// update the score stats (recorded as a neutral 'D'); a loss always counts.
// Turn games (darts/archery/golf/pool) always report a real score, so the guard
// is scoped to the word games to leave their validated convergence untouched.
// -----------------------------------------------------------------------------
const WORD_GAME_IDS: Record<PropertyKey, unknown> = { hunt: true, anagrams: true, wordbites: true };
function updateAdaptiveState(rbState: unknown, opts?: AdaptiveUpdateRead | null) {
    const state = (rbState as AdaptiveRead | null | undefined) || {};
    const { botWon, oppScore, gameId } = opts || {};
    const adjustFactor = !(opts && opts.adjustFactor === false);
    const legitOpp = Number.isFinite(oppScore) && oppScore! > 0;
    const phantomWin = botWon === true && !legitOpp && WORD_GAME_IDS[gameId as PropertyKey] === true;

    // PER-GAME factor: nudge only THIS game's factor, leaving the other games'
    // factors untouched (no cross-game bleed).
    let factor = resolveGameFactor(state, gameId) as number;
    // Divide/multiply by the SAME ratio so a W then L returns to the same factor.
    // The old *0.89 / *1.11 pair drifted downward even at a perfect 50/50 split.
    if (adjustFactor && botWon === true && !phantomWin) factor /= (1 + ADAPTIVE_STEP);
    else if (adjustFactor && botWon === false) factor *= (1 + ADAPTIVE_STEP);
    factor = clamp(factor, ADAPTIVE_MIN, ADAPTIVE_MAX);

    // Persist the per-game factor map. Freeze the pre-split shared factor as the
    // migration seed ONCE (only when this record has no per-game map yet AND carries
    // a legacy shared factor), so later new game types seed from the player's
    // level-at-migration, never from a since-evolved sibling game's factor.
    const prevFactors = (state.adaptiveFactors && typeof state.adaptiveFactors === 'object')
        ? state.adaptiveFactors : null;
    const adaptiveFactors = Object.assign({}, prevFactors);
    if (gameId != null) adaptiveFactors[gameId] = factor;
    let seedFactor = Number.isFinite(state.seedFactor) ? state.seedFactor as number : null;
    if (seedFactor == null && !prevFactors && Number.isFinite(state.adaptiveFactor)) {
        seedFactor = state.adaptiveFactor as number;
    }

    // Legacy cross-game average (kept for observability / old readers). Only real
    // opponent scores feed it; a faster 0.5/0.5 EWMA tracks a changing player.
    let userAvgScore = state.userAvgScore != null ? state.userAvgScore : null;
    if (legitOpp) {
        userAvgScore = state.userAvgScore == null
            ? oppScore!
            : Math.round(0.5 * state.userAvgScore + 0.5 * oppScore!);
    }

    // Per-game demonstrated skill: a fast EWMA of their score + their best, kept
    // separate per game so scores of different scales never mix.
    const scoreStats = Object.assign({}, state.scoreStats);
    if (legitOpp && gameId) {
        const prev = scoreStats[gameId] || { avg: null, best: null, n: 0 };
        const avg = prev.avg == null ? oppScore : Math.round(0.5 * prev.avg + 0.5 * oppScore!);
        const best = prev.best == null ? oppScore : Math.max(prev.best, oppScore!);
        scoreStats[gameId] = { avg, best, n: (prev.n || 0) + 1 };
    }

    const gamesPlayedByGame = Object.assign({}, state.gamesPlayedByGame);
    if (gameId) {
        const previousCount = resolveGameCount(state, gameId);
        // An abandoned zero-score word game is not demonstrated play and should
        // not consume that game's friendly-first-game slot or advance jitter.
        gamesPlayedByGame[gameId] = previousCount + (phantomWin ? 0 : 1);
    }

    const tag = phantomWin ? 'D' : botWon === true ? 'W' : botWon === false ? 'L' : 'D';
    const recentResults = [...(state.recentResults || []), tag].slice(-10);
    const recentResultsByGame = Object.assign({}, state.recentResultsByGame);
    if (gameId) recentResultsByGame[gameId] = [...(recentResultsByGame[gameId] || []), tag].slice(-10);

    // adaptiveFactor mirrors THIS game's new factor (legacy readers + the watcher's
    // log line); adaptiveFactors is the authoritative per-game map.
    const out: AdaptiveUpdateResult = { adaptiveFactor: factor, adaptiveFactors, gamesPlayedByGame, userAvgScore, recentResults, recentResultsByGame, scoreStats };
    if (seedFactor != null) out.seedFactor = seedFactor;
    return out;
}

export const rubberBand = {
    handicapFactor,
    referenceScore,
    boardCappedTarget,
    pickTopByScore,
    pickHumanPortfolio,
    humanAvgWordValue,
    chooseSubmission,
    updateAdaptiveState,
    resolveGameFactor,
    resolveGameCount,
    seedFromLegacy,
    mulberry32,
    hashSeed,
    MIN_WORDS,
    HUMAN_MAX_WORDS,
    ADAPTIVE_STEP,
    ADAPTIVE_MIN,
    ADAPTIVE_MAX,
    ADAPTIVE_START,
    DEFAULT_USER_SCORE,
    HUMAN_FIND_FRACTION,
    BOARD_TARGET_CAP_FRAC,
    WORD_DIFFICULTY_FACTOR,
    targetJitter,
};

