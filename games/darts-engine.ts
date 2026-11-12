// games/darts-engine.ts
import type { DartTarget, DartOptions, Random, DartJitter } from './engine-types.ts';
// =============================================================================
// Darts engine - dartboard geometry + checkout calculator (pure, no I/O)
// =============================================================================
//
// GamePigeon Darts is a countdown game (mode = 101/301/501 starting score). Each
// turn Bot throws up to 3 darts; the move encodes each dart's LANDING POINT
// directly: move:<player>,<x>,<y>,<ring>,<mult>,<flag>. Because we specify the
// landing, we don't simulate a throw - we just pick the wedge we want and place
// the dart at that wedge's centre (effectively perfect accuracy).
//
// Countdown rules: reduce remaining score to EXACTLY 0. The finishing dart must
// be a DOUBLE (or the double-bull, 50). Overshooting, or landing on 1, or
// finishing on a non-double = BUST (score reverts, turn ends). This engine's job:
// given the remaining score and darts left, choose the best legal sequence of
// darts (aim) - perfect for ramp-up, deliberately weaker for ease-up.
//
// GEOMETRY IS VERIFIED against GamePigeon's own scoring source (darts.gd:
// _hit_segment_from_world + _hit_multiplier_from_world + calc_shot_coordinates)
// and against the tester's real captured cards (2026-07-07): every one of the 20 singles
// round-trips exactly, and the corrected wedgeCenterXY scores 62/62 targets right
// (20 singles + 20 trebles + 20 doubles + both bulls) when re-scored via scoreFromXY.
//
// -----------------------------------------------------------------------------
// Dartboard model (AUTHORITATIVE - from darts.gd)
// -----------------------------------------------------------------------------
// The board is NOT centred on the origin. In wire space its centre is
// DART_BOARD_CENTER = (0, 0.344) and its radius is DART_BOARD_RADIUS = 0.535.
// GamePigeon scores a landing (x, y) by:
//   p  = (x, y) - (0, 0.344)                    // shift to board-local
//   rn = |p| / 0.535                            // normalized radius (1.0 = rim)
//   angle = rad_to_deg(atan2(p.x, p.y))         // 0 deg = +y/up, clockwise, x-first
//   idx   = floor((angle + 9) / 18) % 20        // +9 = half-sector offset
//   base  = SEGMENTS[idx]
//   treble when 0.582 <= rn <= 0.629 ; double when 0.953 <= rn <= 1.03 ; else single
//   bull is scored by ABSOLUTE |p|: bullseye (50) |p| <= 0.023, outer bull (25) <= 0.056
//   off-board (score 0 / MISS) when rn > 1.03
//
// ring/mult semantics used in the move tuple:
//   number = the wedge value (1..20), or 25 for the bull region.
//   mult   = 1 single, 2 double, 3 treble; for the bull, mult 1 = 25 (outer bull),
//            mult 2 = 50 (inner/double bull).
//   points = number * mult   (bull: 25*1=25, 25*2=50)
//   flag   = 0 normal; we set 1 on the dart that legally finishes the leg (kept
//            simple; the recipient re-reads state:<remaining>,<darts_left>).
// x,y are the board coordinates in the SAME frame the wire uses (centre = board
// centre = (0, 0.344), NOT the origin). Every coordinate we emit is placed inside
// the exact region that yields its (points, mult), so re-scoring the coordinate
// with scoreFromXY() always reproduces the claimed score - the visible landing and
// the awarded score can never disagree.
// =============================================================================

// AUTHORITATIVE board constants (darts.gd).
const DART_BOARD_CENTER = { x: 0.0, y: 0.344 };
const DART_BOARD_RADIUS = 0.535;
// Clockwise segment order (darts.gd DART_SEGMENTS). Retained as WEDGE_ORDER too for
// backward-compat with any external caller.
const DART_SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const WEDGE_ORDER = DART_SEGMENTS;
const WEDGES = 20;
const WEDGE_ANGLE = (2 * Math.PI) / WEDGES; // 18 degrees

// Ring band edges as normalized radius rn = |p| / DART_BOARD_RADIUS (darts.gd
// _hit_multiplier_from_world). Bull uses ABSOLUTE |p|.
const RN_TREBLE_LO = 0.582, RN_TREBLE_HI = 0.629;
const RN_DOUBLE_LO = 0.953, RN_DOUBLE_HI = 1.03;
const ABS_BULL_INNER = 0.023; // <= this (absolute) => bullseye 50
const ABS_BULL_OUTER = 0.056; // <= this (absolute) => outer bull 25
// Single sits in the wide outer gap between treble and double (0.629 .. 0.953);
// we aim its centre so a single is unambiguous and far from every boundary.
const RN_SINGLE_LO = 0.629, RN_SINGLE_HI = 0.953;

// Band CENTRES (rn) we place darts at - each safely mid-band so re-scoring is exact.
const RN_TREBLE = (RN_TREBLE_LO + RN_TREBLE_HI) / 2;   // 0.6055
const RN_DOUBLE = (RN_DOUBLE_LO + RN_DOUBLE_HI) / 2;   // 0.9915 (well below the 1.03 rim)
const RN_SINGLE = (RN_SINGLE_LO + RN_SINGLE_HI) / 2;   // 0.791
const ABS_OUTER_BULL = (ABS_BULL_INNER + ABS_BULL_OUTER) / 2; // 0.0395 (mid outer-bull ring)

// In-region jitter caps. A dart is placed at its region centre plus at most this
// much cosmetic scatter, applied in POLAR terms so it can NEVER cross a ring
// boundary or a wedge edge:
//   radial: +/- 0.008 board units (inside even the narrow treble half-band ~0.0126)
//   angular: +/- 5 degrees (inside the +/- 9 degree wedge sector, 4 deg of margin)
const JITTER_RADIAL_MAX = 0.008;
const JITTER_ANGLE_MAX_DEG = 5;

// A genuine board MISS (0 points): the dart lands just OUTSIDE the double rim so
// scoreFromXY() returns points 0 (rn > RN_DOUBLE_HI). rn = 1.09 sits clearly off
// the scoring area but still close to the rim (a realistic "rattled out / missed
// the board" throw, exactly what a weak player does when they choke a double).
const RN_MISS = 1.09;

const _deg2rad = (d: typeof WEDGE_ANGLE) => (d * Math.PI) / 180;
const _rad2deg = (r: number) => (r * 180) / Math.PI;

// -----------------------------------------------------------------------------
// wedgeAngleDeg(number) -> the app-space angle (deg, 0 = +y/up, clockwise) at the
// CENTRE of the wedge for `number`. Inverse of darts.gd's segment lookup: the wedge
// at index i occupies angles [18*i - 9, 18*i + 9), so its centre angle is 18*i.
// -----------------------------------------------------------------------------
function wedgeAngleDeg(number: number) {
    const idx = DART_SEGMENTS.indexOf(number);
    return idx < 0 ? 0 : 18 * idx;
}

// -----------------------------------------------------------------------------
// scoreFromXY(x, y) -> { points, base, wireMult }
// Re-scores a landing coordinate using GamePigeon's EXACT model (darts.gd). This is
// the ground truth the play module asserts against: the coordinate it emits must
// re-score to the same (points, base, wireMult) it claims, or it is a bug. Returns
// points 0 / base 0 for an off-board (MISS) landing.
//   wireMult: 0 single, 2 double, 3 treble (the on-wire multiplier convention).
// -----------------------------------------------------------------------------
function scoreFromXY(x: number, y: number) {
    const px = x - DART_BOARD_CENTER.x;
    const py = y - DART_BOARD_CENTER.y;
    const absr = Math.hypot(px, py);
    const rn = absr / DART_BOARD_RADIUS;
    // Bull is scored by ABSOLUTE radius, before segment/ring logic.
    if (absr <= ABS_BULL_INNER) return { points: 50, base: 25, wireMult: 2 };
    if (absr <= ABS_BULL_OUTER) return { points: 25, base: 25, wireMult: 0 };
    // Off the board => MISS (score 0).
    if (rn > RN_DOUBLE_HI) return { points: 0, base: 0, wireMult: 0 };
    // Segment (wedge value).
    let angle = _rad2deg(Math.atan2(px, py));
    if (angle < 0) angle += 360;
    const idx = Math.floor((angle + 9.0) / 18.0) % DART_SEGMENTS.length;
    const base = DART_SEGMENTS[idx];
    // Ring band.
    let mult = 1;
    if (rn >= RN_TREBLE_LO && rn <= RN_TREBLE_HI) mult = 3;
    else if (rn >= RN_DOUBLE_LO && rn <= RN_DOUBLE_HI) mult = 2;
    return { points: base * mult, base, wireMult: mult === 1 ? 0 : mult };
}

// -----------------------------------------------------------------------------
// wedgeCenterXY(number, mult, jitter) -> { x, y }
// Returns a landing point INSIDE the exact target region - the correct wedge sector
// AND the correct ring band - in the wire coordinate frame (centred on the board
// centre (0, 0.344)). scoreFromXY() on the result always reproduces the intended
// (points, mult).
//   number = 1..20 (a wedge) or 25 (bull)
//   mult   = 1/2/3 for a wedge; for bull, 1 = outer(25), 2 = inner(50)
//   jitter = optional { jr, ja } in [-1, 1] each; scaled to the fixed in-region caps
//            (radial +/- 0.008, angular +/- 5 deg) so it never leaves the region.
//            Omit for the exact region centre.
// -----------------------------------------------------------------------------
function wedgeCenterXY(number: number, mult: number, jitter?: DartJitter) {
    if (number === 0) {
        // Board MISS: place the dart just off the rim (rn > 1.03 => scores 0). Only
        // a cosmetic angular spin is applied so repeated misses don't overlap; the
        // radius stays fixed off-board so scoreFromXY() always reproduces 0 points.
        const ja = jitter && typeof jitter.ja === 'number'
            ? Math.max(-1, Math.min(1, jitter.ja)) * _deg2rad(JITTER_ANGLE_MAX_DEG)
            : 0;
        const absr = RN_MISS * DART_BOARD_RADIUS;
        // spin around a wide arc so misses scatter around the rim, not one spot
        const spin = ja + (jitter && typeof jitter.jr === 'number' ? jitter.jr * Math.PI : 0);
        return {
            x: DART_BOARD_CENTER.x + absr * Math.sin(spin),
            y: DART_BOARD_CENTER.y + absr * Math.cos(spin),
        };
    }
    if (number === 25) {
        // Bullseye (50): dead centre. Outer bull (25): small absolute-radius ring;
        // only a cosmetic angular spin is applied (radius stays safely mid-ring).
        if (mult === 2) return { x: DART_BOARD_CENTER.x, y: DART_BOARD_CENTER.y };
        const ja = jitter && typeof jitter.ja === 'number'
            ? Math.max(-1, Math.min(1, jitter.ja)) * _deg2rad(JITTER_ANGLE_MAX_DEG)
            : 0;
        return {
            x: DART_BOARD_CENTER.x + ABS_OUTER_BULL * Math.sin(ja),
            y: DART_BOARD_CENTER.y + ABS_OUTER_BULL * Math.cos(ja),
        };
    }
    let rn;
    if (mult === 3) rn = RN_TREBLE;
    else if (mult === 2) rn = RN_DOUBLE;
    else rn = RN_SINGLE;
    let jr = 0;
    let jaDeg = 0;
    if (jitter) {
        if (typeof jitter.jr === 'number') jr = Math.max(-1, Math.min(1, jitter.jr)) * JITTER_RADIAL_MAX;
        if (typeof jitter.ja === 'number') jaDeg = Math.max(-1, Math.min(1, jitter.ja)) * JITTER_ANGLE_MAX_DEG;
    }
    const absr = rn * DART_BOARD_RADIUS + jr;
    const angle = _deg2rad(wedgeAngleDeg(number) + jaDeg);
    return {
        x: DART_BOARD_CENTER.x + absr * Math.sin(angle),
        y: DART_BOARD_CENTER.y + absr * Math.cos(angle),
    };
}

// A "target" = { number, mult, points }. Build the standard target list.
function target(number: number, mult: number) {
    const points = number === 25 ? (mult === 2 ? 50 : 25) : number * mult;
    return { number, mult, points };
}

// -----------------------------------------------------------------------------
// isDouble(t) - a legal finishing dart is a double (mult 2 on a wedge) or the
// double bull (25 with mult 2 => 50).
// -----------------------------------------------------------------------------
function isDouble(t: DartTarget) {
    return (t.number === 25 && t.mult === 2) || (t.number !== 25 && t.mult === 2);
}

// -----------------------------------------------------------------------------
// bestCheckout(remaining, dartsLeft) -> [target, ...] | null
// Find a sequence of <= dartsLeft darts that reduces `remaining` to exactly 0
// finishing on a double. Prefers fewer darts. Returns null if no checkout this turn.
// Search space is small (a handful of standard targets), so a bounded DFS is instant.
// -----------------------------------------------------------------------------
function allTargets() {
    const list = [];
    for (let n = 1; n <= 20; n++) {
        list.push(target(n, 1));
        list.push(target(n, 2));
        list.push(target(n, 3));
    }
    list.push(target(25, 1)); // outer bull 25
    list.push(target(25, 2)); // inner bull 50
    return list;
}
const ALL_TARGETS = allTargets();
// Doubles only (legal finishers), highest first.
const DOUBLES = ALL_TARGETS.filter(isDouble).sort((a, b) => b.points - a.points);
// Scoring darts (non-finishers), highest first - used to whittle down.
const SCORERS = ALL_TARGETS.slice().sort((a, b) => b.points - a.points);

function bestCheckout(remaining: number, dartsLeft: number) {
    // Try to finish in 1, then 2, then 3 darts (up to dartsLeft).
    const maxDarts = Math.min(3, dartsLeft);
    // 1-dart finish
    for (const d of DOUBLES) {
        if (d.points === remaining) return [d];
    }
    if (maxDarts < 2) return null;
    // 2-dart finish: one scorer + a double
    for (const s of SCORERS) {
        if (s.points >= remaining) continue;
        const need = remaining - s.points;
        const fin = DOUBLES.find((d) => d.points === need);
        if (fin) return [s, fin];
    }
    if (maxDarts < 3) return null;
    // 3-dart finish: two scorers + a double
    for (const s1 of SCORERS) {
        if (s1.points >= remaining) continue;
        for (const s2 of SCORERS) {
            const sub = remaining - s1.points - s2.points;
            if (sub <= 1) continue;
            const fin = DOUBLES.find((d) => d.points === sub);
            if (fin) return [s1, s2, fin];
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// Deterministic tiny PRNG (mulberry32). Used only to VARY which legal target Bot
// aims for turn-to-turn / dart-to-dart so a whittle turn isn't the robotic same
// three darts every round. The seed is derived from the game state (remaining +
// dart index), so the choice is deterministic (testable, reproducible) yet differs
// each turn as the score counts down. It NEVER affects legality: every candidate in
// the band is a real dartboard target and the running total is honest.
// -----------------------------------------------------------------------------
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// -----------------------------------------------------------------------------
// scorerBand(aggression) -> [target, ...]  (legal scoring darts, best-first)
// A skill-graded pool of real dartboard targets Bot picks from when whittling.
// Higher aggression => the band centres on the big trebles (T20/T19/T18); lower
// aggression => realistic mid/low singles a casual player actually hits. Bot picks
// WITHIN the band (varying turn-to-turn) instead of hammering one fixed wedge - so
// rubber-band difficulty comes from WHICH legal targets it aims at, never from a
// faked number. Every entry is a genuine target with honest points.
//
// Thresholds are spread across the FULL continuous aggression range (darts-play's
// factorToAggression now maps the rubber-band factor onto ~0.05..1.0, not the old
// saturating 4-step ladder) so the bottom of the band is genuinely reachable and
// genuinely weak. Combined with the applyScatter() miss model below, a low-
// aggression Bot both AIMS lower AND misses more - a real, beatable player.
// -----------------------------------------------------------------------------
function scorerBand(aggression: number) {
    if (aggression >= 0.82) {
        // Sharp: the classic high-treble cluster + the bull.
        return [target(20, 3), target(19, 3), target(18, 3), target(17, 3), target(25, 2)];
    }
    if (aggression >= 0.62) {
        // Solid: mix trebles with the big singles so totals vary game to game.
        return [target(19, 3), target(18, 3), target(20, 1), target(19, 1), target(17, 1), target(16, 1)];
    }
    if (aggression >= 0.42) {
        // Even: mostly singles across the top of the board, the odd treble.
        return [target(20, 1), target(18, 1), target(17, 3), target(16, 1), target(15, 1), target(19, 1)];
    }
    if (aggression >= 0.22) {
        // Easing up: realistic mid singles a casual player scatters across.
        return [target(15, 1), target(17, 1), target(12, 1), target(14, 1), target(18, 1), target(11, 1)];
    }
    // Brand-new / max-easy opponent: go easy - low/mid singles, spread out.
    return [target(7, 1), target(9, 1), target(11, 1), target(5, 1), target(13, 1), target(3, 1)];
}

// =============================================================================
// HUMAN MISS / SCATTER MODEL (the competitive fix, 2026-07-07)
// =============================================================================
// The old darts engine was UNBEATABLE not because it scored high but because it
// NEVER MISSED: every dart landed dead-centre in its intended region and every
// leg checked out perfectly on the first double it reached. Easing the scorer band
// only lowered Bot's SCORING RATE; it never introduced ERRORS, so a human - who
// misses trebles, sprays into neighbouring wedges, and rattles doubles for turns
// on end - could never actually win.
//
// applyScatter() gives a low-aggression Bot a REAL, HUMAN error profile:
//   - trebles slip off the narrow treble band down to a single (very common),
//   - doubles (the finisher) miss down to their single - the classic "can't close
//     it out" that hands the opponent extra turns,
//   - darts drift into an adjacent wedge (20 -> 1 or 5, the real board neighbours),
//   - bull attempts fall to a low single.
// Every scattered landing is STILL A REAL DARTBOARD TARGET with honest points, and
// planTurn re-validates the countdown after the scatter (legalNext) so the leg is
// always legal: on-board, correct countdown, double-out only, never leaves 1, never
// busts. Bot just plays like a person now - sharper when it's losing, genuinely
// weaker (misses + lower aim) when it's winning, converging toward a coin-flip.
//
// At aggression 1.0 the wildness is 0 and NOTHING scatters, so ramp-up / max play
// is byte-identical to the old flawless engine. The model only ever ADDS misses as
// aggression drops.
// -----------------------------------------------------------------------------

// Peak scatter probabilities at maximum wildness (aggression 0). Scaled linearly by
// wildness w = 1 - aggression, so each fades to 0 as Bot sharpens. Tuned so the
// weakest legal Bot loses to a casual human without ever stalling a leg.
const SCATTER = {
    trebleSlip: 0.88,   // P(a treble rattles out to its single)
    doubleMiss: 0.90,   // P(a double misses down to its single) - the checkout choke
    bullMiss: 0.80,     // P(a bull attempt falls to a low single)
    angularBig: 0.60,   // P(a treble/double drifts to an adjacent wedge)
    angularSingle: 0.45,// P(a single drifts to an adjacent wedge)
    farDrift: 0.30,     // P(a drift is two wedges over instead of one) scaled by w
    // NEW (2026-07-08 short-game fix): the two mechanisms that make easing BITE on a
    // 101, so an eased Bot genuinely takes MORE turns instead of always making
    // ~26-40 pts of progress. Both scale with wildness w and vanish at aggression 1.
    boardMiss: 0.30,    // P(a dart misses the BOARD entirely -> 0 pts) - the air-ball
                        //   that wastes a dart and, on a finish, keeps Bot stuck on
                        //   its double for extra turns (a real weak-player miss).
    doubleAirMiss: 0.55,// EXTRA P(the FINISHING double specifically flies off-board)
                        //   on top of boardMiss - this is the classic "can't close it
                        //   out"; it never illegally finishes, it just fails to.
};

// neighborWedge(number, step) -> the wedge `step` positions around the physical
// board (clockwise +, counter-clockwise -). Uses the real DART_SEGMENTS order, so a
// 20 drifts to 1 or 5 exactly like a real dartboard.
function neighborWedge(number: number, step: number) {
    const idx = DART_SEGMENTS.indexOf(number);
    if (idx < 0) return number;
    const n = DART_SEGMENTS.length;
    return DART_SEGMENTS[((idx + step) % n + n) % n];
}

// mkTarget(number, mult) -> { number, mult, points } for a scattered landing.
function mkTarget(number: number, mult: number) {
    const points = number === 25 ? (mult === 2 ? 50 : 25) : number * mult;
    return { number, mult, points };
}

// applyScatter(intended, aggression, rng) -> actual { number, mult, points }.
// Deterministic given rng; returns the intended target unchanged at aggression 1.
// A returned number of 0 (points 0) is a genuine BOARD MISS - the dart flew off the
// scoring area. That is the mechanism that lets easing actually BITE on a short 101:
// a missed dart wastes progress, and a missed FINISHING double keeps Bot stuck on
// its checkout for extra turns (the classic weak-player "can't close it out").
function applyScatter(intended: DartTarget, aggression: number, rng: Random) {
    const w = Math.max(0, Math.min(1, 1 - aggression));
    if (w <= 0) return { number: intended.number, mult: intended.mult, points: intended.points };

    // (1) The FINISHING double is the hardest dart in the game: on top of the base
    // board-miss chance it has an EXTRA chance to sail off the board. This is what
    // stretches a 101 out - Bot reaches the double but rattles it for turns.
    if (intended.mult === 2 && rng() < SCATTER.doubleAirMiss * w) return mkTarget(0, 0);
    // (2) Any dart can miss the board entirely when wild (the air-ball -> 0 pts).
    if (rng() < SCATTER.boardMiss * w) return mkTarget(0, 0);

    let number = intended.number;
    let mult = intended.mult;

    // Bull attempt: weak players rarely land it - fall to a low single.
    if (number === 25) {
        if (rng() < SCATTER.bullMiss * w) {
            const lowSingles = [1, 5, 20, 12, 9, 14];
            number = lowSingles[Math.floor(rng() * lowSingles.length)];
            mult = 1;
        }
        return mkTarget(number, mult);
    }

    // Ring slip (the dominant weakener): trebles rattle to singles, doubles choke.
    if (mult === 3) {
        if (rng() < SCATTER.trebleSlip * w) mult = 1;
    } else if (mult === 2) {
        if (rng() < SCATTER.doubleMiss * w) mult = 1;
    }

    // Angular drift into an adjacent wedge (symmetric, like a real spray). When very
    // wild the drift reaches 2-3 wedges over, so a low-aggression Bot genuinely
    // sprays low instead of landing its intended big number.
    const pAng = (intended.mult === 1 ? SCATTER.angularSingle : SCATTER.angularBig) * w;
    if (rng() < pAng) {
        const dir = rng() < 0.5 ? -1 : 1;
        let far = 1;
        if (rng() < SCATTER.farDrift * w) far = 2;
        if (rng() < SCATTER.farDrift * w * 0.5) far = 3;
        number = neighborWedge(number, dir * far);
    }
    return mkTarget(number, mult);
}

// safeLowDart(rem) -> a legal, NON-finishing low single that just whittles (leaves
// rem >= 2), or null if none exists (rem too small). Used as the graceful fallback
// when a scattered dart would be illegal: a weak Bot does NOT snap to the perfect
// dart, it dribbles a low single (or, if even that can't leave a legal remainder,
// planTurn throws a board MISS). Prefers the smallest single so the whittle is slow
// and human, never a hidden "perfect recovery".
function safeLowDart(rem: number) {
    for (let n = 1; n <= 20; n++) {
        if (rem - n >= 2) return mkTarget(n, 1);
    }
    return null;
}

// seedFrom(remaining, opts) -> uint32 RNG seed for a turn plan.
// Byte-compatible base: when opts.gameId is absent (unit tests, any caller that pins
// a seed) this returns EXACTLY the original ((remaining*C + seed) >>> 0), so those
// paths are unchanged. When opts.gameId IS present (live play), a stable per-GAME
// nonce is folded in so two games with the same score trajectory (e.g. every fresh
// 101, which always starts (101,101)) play DIFFERENTLY - while staying deterministic
// per (game, remaining, seed) so re-processing the same inbound card reproduces the
// identical move (round-trip stability the wire protocol needs).
function seedFrom(remaining: number, opts: DartOptions) {
    let h = (remaining * 2654435761 + (opts.seed || 0)) >>> 0;
    if (opts.gameId != null) {
        let g = opts.gameId >>> 0;
        g = Math.imul(g ^ (g >>> 16), 2246822507) >>> 0;
        g = Math.imul(g ^ (g >>> 13), 3266489909) >>> 0;
        h = (h ^ g) >>> 0;
        h = Math.imul(h ^ (h >>> 15), 2654435761) >>> 0;
    }
    return h >>> 0;
}

// legalNext(rem, dart) -> is throwing `dart` at remaining `rem` a LEGAL countdown
// step? A dart may reduce to exactly 0 only if it is a double (double-out); any
// other landing must leave >= 2 (never leave 1, never bust below 0). This is the
// single invariant that keeps every emitted leg legal even after scatter.
function legalNext(rem: number, dart: DartTarget) {
    const next = rem - dart.points;
    if (next === 0) return isDouble(dart);
    return next >= 2;
}

// A "safe leave" is a remainder Bot can legally finish from later. 0 is fine
// (already out - but reaching 0 is only ever done via a legal double, enforced by
// bestCheckout). The ONE hard trap is a remainder of 1: no double sums to 1, so you
// can never check out from 1 (and getting there wastes the turn). We forbid leaving
// 1; every other remainder >= 2 is finishable over subsequent turns.
function isSafeLeave(rem: number) {
    return rem === 0 || rem >= 2;
}

// checkoutAggressionCeiling(aggression) -> only ATTEMPT a checkout when the
// remaining is at/below this. A sharp player goes for any legal out; a casual
// player only takes the finish when it's a lower, easier double. This is how ease-up
// stays HONEST: a weaker Bot finishes LATER (keeps whittling), it never finishes
// ILLEGALLY. When it does check out, bestCheckout guarantees a real double-out.
function checkoutAggressionCeiling(aggression: number) {
    if (aggression >= 0.82) return 170; // max checkout in the game (T20 T20 Bull)
    if (aggression >= 0.62) return 120;
    if (aggression >= 0.42) return 98;
    if (aggression >= 0.22) return 50;  // casual: only the obvious finishes
    return 32;                          // max-easy: only the easy low doubles
}

// -----------------------------------------------------------------------------
// chooseIntended(rem, dartsAfter, aggression, ceiling, band, rng) -> target | null
// The target Bot AIMS AT for the current dart (before scatter):
//   1. If a LEGAL checkout exists AND rem is within this skill level's checkout
//      ceiling, aim at the FIRST dart of that double-out sequence.
//   2. Otherwise "whittle": aim at a band target that leaves a SAFE remainder
//      (never 1, never overshoot), shuffled per-dart so turns vary.
//   3. Fallbacks keep a legal aim available at every remaining >= 2.
// Aiming is honest; applyScatter() then decides where the dart ACTUALLY lands.
// -----------------------------------------------------------------------------
function chooseIntended(rem: number, dartsAfter: number, _aggression: number, ceiling: number, band: DartTarget[], rng: Random) {
    if (rem <= ceiling) {
        const co = bestCheckout(rem, dartsAfter + 1);
        if (co) return co[0]; // first dart of the double-out; loop re-plans the rest
    }
    const order = shuffleByRng(band, rng) as DartTarget[];
    let d = order.find((s) => s.points < rem && isSafeLeave(rem - s.points));
    if (!d) d = SCORERS.find((s) => s.points < rem && isSafeLeave(rem - s.points));
    if (d) return d;
    // Nothing whittles safely (small remainder); take any legal checkout regardless
    // of the ceiling so the turn still produces a legal dart.
    const co = bestCheckout(rem, dartsAfter + 1);
    if (co) return co[0];
    return null;
}

// -----------------------------------------------------------------------------
// planTurn(remaining, dartsLeft, opts) -> { darts:[target,...], finishes:bool, endRemaining }
// Full turn plan, re-planned per dart so a scattered (missed) dart is answered by
// the NEXT dart from the ACTUAL new remaining - exactly how a person adjusts mid-
// turn. Each dart:
//   a. chooseIntended() picks the honest aim (checkout dart or whittle target).
//   b. applyScatter() decides where it ACTUALLY lands (misses grow as aggression
//      drops; at aggression 1 nothing scatters and play is the old flawless engine).
//   c. legalNext() guards the countdown: if the scattered landing would bust / leave
//      1 / finish on a non-double, throw the CLEAN intended dart instead (always
//      legal by construction). So every emitted leg stays legal - on-board, correct
//      countdown, double-out only - while a weak Bot genuinely misses, scores less,
//      and rattles its doubles for extra turns, letting the opponent win ~half.
//   opts.aggression in [0,1]: 1 = perfect; lower = weaker aim + more misses.
//   opts.seed (optional): extra entropy folded into the per-turn RNG seed (in live
//     play darts-play passes the opponent's remaining here).
//   opts.gameId (optional): a stable per-GAME uint32 nonce (darts-play hashes the
//     GamePigeon session id). Folded into the seed so every fresh 101 plays
//     DIFFERENTLY instead of byte-identically, while a re-processed card still
//     reproduces the same move. Omit it and the seed is byte-compatible with tests.
// -----------------------------------------------------------------------------
function planTurn(remaining: number, dartsLeft: number, opts?: DartOptions) {
    opts = opts || {};
    const aggression = opts.aggression != null ? opts.aggression : 1;
    const ceiling = checkoutAggressionCeiling(aggression);
    const band = scorerBand(aggression);
    const rng = mulberry32(seedFrom(remaining, opts));
    const darts = [];
    let rem = remaining;
    const maxDarts = Math.min(3, dartsLeft);

    for (let i = 0; i < maxDarts; i++) {
        const dartsAfter = maxDarts - 1 - i;
        const intended = chooseIntended(rem, dartsAfter, aggression, ceiling, band, rng);
        if (!intended) break; // no legal aim from here - end the turn (leave for later)

        let actual = applyScatter(intended, aggression, rng);
        if (!legalNext(rem, actual)) {
            // The scattered landing would be illegal (bust / leave 1 / non-double
            // finish). A weak player does NOT magically snap back to the perfect dart
            // here - that snap-to-perfect was the old bug that made every checkout
            // succeed and every 101 a 2-turn win. Instead fall back to the least-
            // committal LEGAL outcome: a low single that just whittles, else a board
            // MISS (0 pts, always legal at rem >= 2) which keeps Bot stuck on its
            // double. At aggression 1 the scatter is a no-op, so this branch never
            // runs and play stays byte-identical to the old flawless engine.
            const safe = safeLowDart(rem);
            actual = safe ? safe : mkTarget(0, 0);
        }
        rem -= actual.points;
        darts.push(actual);
        if (rem === 0) return { darts, finishes: true, endRemaining: 0 };
    }
    return { darts, finishes: rem === 0, endRemaining: rem };
}

// Fisher-Yates shuffle driven by a supplied rng() -> [0,1). Returns a NEW array;
// does not mutate the input band.
function shuffleByRng(arr: DartTarget[], rng: Random): unknown {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}

export const dartsEngine = {
    WEDGE_ORDER,
    DART_SEGMENTS,
    DART_BOARD_CENTER,
    DART_BOARD_RADIUS,
    wedgeCenterXY,
    wedgeAngleDeg,
    scoreFromXY,
    target,
    isDouble,
    bestCheckout,
    planTurn,
    chooseIntended,
    allTargets,
    ALL_TARGETS,
    DOUBLES,
    SCORERS,
    scorerBand,
    checkoutAggressionCeiling,
    shuffleByRng,
    mulberry32,
    // human miss / scatter model
    SCATTER,
    neighborWedge,
    applyScatter,
    legalNext,
};

