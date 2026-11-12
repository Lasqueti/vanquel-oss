// games/basketball-engine.ts
import type { BasketballOptions, BasketballShot } from './target-engine-types.ts';
// =============================================================================
// Basketball shot-log engine (game=basketball) - pure, no I/O
// =============================================================================
//
// GamePigeon Basketball is a SOLO-SCORE shooting drill: each player shoots an
// independent round into their OWN (deterministically-moving) hoop, then the two
// final made-basket counts are compared. Unlike pool/tanks (which re-simulate a
// projectile on the recipient), Basketball is OUTCOME-ENCODED: every shot in the
// replay carries its own made/miss verdict AND the round ships an authoritative
// `scoreN` integer. This is the SAME "trust the sent outcome" class as darts.
//
// ============================ CAPTURE-DERIVED GRAMMAR ========================
// Verified against the tester's real card (a test line session yCcNUqH9435HGN93, sms.db
// ROWID 102, 2026-07-08). The played card carried:
//   replay2 = "t,x,c,made|t,x,c,made|..."   (46 shots, pipe-separated)
//   score2  = "18"                          (== the count of made=1 shots - EXACT)
// Per-shot fields ("t,x,c,made"):
//   t    = time offset within the round (monotonic when sorted; the ON-WIRE order
//          in the real capture is SCRAMBLED, not t-sorted - the recipient sorts /
//          trusts the score, so order is cosmetic). Observed range 51..2635.
//   x    = signed horizontal release/aim param. Observed range -0.162 .. +0.451.
//          STRONGLY correlated with the verdict: made shots cluster near 0
//          (|x| small, ~[-0.104, +0.130]); misses spread wide (mostly +0.14..+0.45,
//          with the occasional wild-left small negative). We reproduce that so the
//          animated release and the made flag agree (darts "coordinate ⇔ score"
//          principle) as well as the trusted score.
//   c    = a flag, CONSTANT 0 across the whole capture (shot-type/backboard,
//          unconfirmed). We always emit 0.
//   made = 1 basket / 0 miss.
//
// This engine only KNOWS the grammar + the observed distributions. It does NOT
// model the hoop-movement mapping from seed/seed2 (no on-device source is
// available), so it cannot GUARANTEE that a given (t, x) geometrically aligns
// with the moving hoop for a "made" shot. It relies on the recipient trusting the
// `made` flag + `score` (the confirmed encoding) and mirrors the real card's x/
// verdict statistics as a best-effort cosmetic match. See basketball-play.ts
// header + the module report for the caveat.
// =============================================================================

// Observed-from-capture distribution constants.
const T_START = 50;          // first shot time offset (~51 in the real card)
const T_SPACING = 55;        // mean gap between shots (~2635/46 ≈ 57 in the capture)
const T_JITTER = 24;         // +/- wobble on the gap so cadence isn't robotic
const MADE_X_LO = -0.11;     // made shots cluster near 0 (real made x: -0.104..0.130)
const MADE_X_HI = 0.135;
const MISS_X_LO = 0.14;      // most misses land right of the make zone (0.14..0.451)
const MISS_X_HI = 0.451;
const WILD_LEFT_LO = -0.17;  // rare "pulled it left" miss (real card had one at -0.162)
const WILD_LEFT_HI = -0.05;
const WILD_LEFT_PROB = 0.08;
const SHOT_FLAG = '0';       // the `c` field - constant 0 in every captured shot

function clamp(x: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, x));
}

// -----------------------------------------------------------------------------
// parseReplay(replay) -> { shots:[{t,x,c,made}], madeCount, ok, empty }
// Fail-safe parser for a shot log. A malformed shot (wrong arity, non-finite
// number, made not in {0,1}) returns ok:false so callers can SKIP the card.
// -----------------------------------------------------------------------------
function parseReplay(replay: unknown) {
    if (typeof replay !== 'string' || replay.length === 0) {
        return { shots: [], madeCount: 0, ok: true, empty: true };
    }
    const shots: BasketballShot[] = [];
    let madeCount = 0;
    for (const ev of replay.split('|')) {
        if (!ev) continue;
        const p = ev.split(',');
        if (p.length < 4) return { shots, madeCount, ok: false, empty: false };
        const t = Number(p[0]);
        const x = Number(p[1]);
        const c = Number(p[2]);
        const made = Number(p[3]);
        if (![t, x, c, made].every(Number.isFinite)) {
            return { shots, madeCount, ok: false, empty: false };
        }
        if (made !== 0 && made !== 1) return { shots, madeCount, ok: false, empty: false };
        if (made === 1) madeCount++;
        shots.push({ t, x, c, made });
    }
    return { shots, madeCount, ok: true, empty: false };
}

// -----------------------------------------------------------------------------
// scoreFromReplay(replay) -> made count (number) | null if malformed.
// The recipient trusts the explicit `scoreN` field, but we keep score == the
// number of made flags at all times, so this doubles as a self-consistency check.
// -----------------------------------------------------------------------------
function scoreFromReplay(replay: unknown) {
    const parsed = parseReplay(replay);
    if (!parsed.ok) return null;
    return parsed.madeCount;
}

// -----------------------------------------------------------------------------
// buildShotLog({ totalAttempts, madeCount, rng }) -> { replay, madeActual, attempts }
// Generate an HONEST, self-consistent shot log: exactly `madeCount` of the
// `totalAttempts` shots are makes (chosen by a deterministic shuffle so makes are
// scattered through the round), the rest misses. score == madeActual == the count
// of made flags in the returned replay - the number is never faked. `x` is drawn
// from the observed made/miss distributions so the release position and the
// verdict agree; `t` is a strictly-increasing offset sequence.
// -----------------------------------------------------------------------------
function buildShotLog(opts: BasketballOptions) {
    const rng = opts.rng;
    const N = Math.max(1, Math.floor(opts.totalAttempts));
    const made = clamp(Math.floor(opts.madeCount), 0, N);

    // Deterministic Fisher-Yates over [0..N-1]; the first `made` indices are makes.
    const idx: number[] = [];
    for (let i = 0; i < N; i++) idx.push(i);
    for (let i = N - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
    }
    const makeSet = new Set(idx.slice(0, made));

    const shots = [];
    let t = T_START + Math.floor(rng() * 10);
    for (let i = 0; i < N; i++) {
        if (i > 0) {
            t += Math.max(8, Math.round(T_SPACING + (rng() - 0.5) * T_JITTER));
        }
        const isMade = makeSet.has(i);
        let x;
        if (isMade) {
            x = MADE_X_LO + rng() * (MADE_X_HI - MADE_X_LO);
        } else if (rng() < WILD_LEFT_PROB) {
            x = WILD_LEFT_LO + rng() * (WILD_LEFT_HI - WILD_LEFT_LO);
        } else {
            x = MISS_X_LO + rng() * (MISS_X_HI - MISS_X_LO);
        }
        shots.push(t + ',' + x.toFixed(3) + ',' + SHOT_FLAG + ',' + (isMade ? 1 : 0));
    }

    const replay = shots.join('|');
    const madeActual = scoreFromReplay(replay); // == made, by construction
    return { replay, madeActual, attempts: N };
}

export const basketballEngine = {
    parseReplay,
    scoreFromReplay,
    buildShotLog,
    clamp,
    // constants (exported for tests / observability)
    T_START,
    T_SPACING,
    MADE_X_LO,
    MADE_X_HI,
    MISS_X_LO,
    MISS_X_HI,
    WILD_LEFT_PROB,
    SHOT_FLAG,
};

