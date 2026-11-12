// games/archery-engine.ts
import type { TargetRandom } from './target-engine-types.ts';
// =============================================================================
// Archery engine - target geometry + aim helper (pure, no I/O)
// =============================================================================
//
// GEOMETRY IS VERIFIED against GamePigeon's own scoring source (OpenPigeon
// `wordhunt` branch: archery/target.gd calc_score + archery/archery.gd
// play_replay + archery.tscn target node transform) AND against the tester's real
// captured cards (2026-07-08): his three bullseye arrows re-score to 10/10/10
// under scoreFromXY, and every Bot arrow the OLD (pre-2026-07-09) engine emitted
// re-scores to 0 (off the board) - which was the "every shot misses" bug.
//
// -----------------------------------------------------------------------------
// Target model (AUTHORITATIVE - from target.gd + archery.gd + archery.tscn)
// -----------------------------------------------------------------------------
// The move tuple is `move:1,<x>,<y>,<z>`. x,y are WORLD coordinates in the plane
// of the target; z is the target depth (cosmetic - scoring ignores z). The board
// is NOT centred on the origin.
//
//   - The target node lives at world (0, 1.362, -14.433) (archery.tscn), identity
//     rotation, scale 1.
//   - On replay the receiver spawns each arrow at (move.x, move.y - REMOTE_Y_FUDGE,
//     move.z) with REMOTE_Y_FUDGE = 0.02 (archery.gd play_replay), then scores it
//     with target.calc_score(arrow).
//   - calc_score (target.gd) takes the arrow's position in the target's LOCAL
//     frame, zeroes z, and measures the planar distance d:
//         seg   = ceil(d / BASE_RADIUS)      (BASE_RADIUS = 0.0808, 10 rings)
//         score = 11 - seg   when seg in 1..10 ; else 0 (MISS, off the board)
//     So bullseye (10) is d <= 0.0808, and the outer scoring edge is 10 * 0.0808
//     = 0.808. (BOARD_RADIUS = 0.75 in archery.gd is only the miss-popup snap
//     radius, NOT the scoring edge.)
//
// Folding the receiver's -0.02 fudge into the centre, the distance a landing
// (move.x, move.y) scores at is:
//         d = hypot(move.x - 0, move.y - (1.362 + 0.02))
//           = hypot(move.x, move.y - 1.382)
// so in the WIRE (move) frame the target centre is (0, 1.382) and a ring is a
// concentric band 0.0808 wide. scoreFromXY() reproduces this exactly - it is the
// ground truth the play module re-scores every emitted coordinate against, so the
// visible arrow and the awarded ring can never disagree.
//
// TRUST MODEL (WHY WIND IS NOT MODELLED HERE - verified 2026-07-09):
// The receiver TRUSTS the sent (x,y): play_replay spawns the arrow AT the replay
// coordinate and scores it with target.calc_score - it does NOT re-simulate flight
// and does NOT apply wind on replay (wind is derived on-device from `seed`, used
// only for the shooter's own live animation + HUD gauge; no `wind` field is on the
// wire). Proven three ways: OpenPigeon source, and BOTH players' real captured
// cards (the tester's bullseyes re-score to 10/10/10; the old off-board Bot arrows
// re-score to 0 and the tester's device ignored Bot's claimed score). So whatever
// coordinate we emit is EXACTLY what gets scored - there is no drift to compensate,
// and adding wind compensation would be WRONG. The engine's only job is to place
// the arrow where we WANT it to score. See archery-play.ts header for the capture.
// =============================================================================

// -----------------------------------------------------------------------------
// AUTHORITATIVE target constants (wire/move frame).
// -----------------------------------------------------------------------------
const TARGET_WORLD = { x: 0.0, y: 1.362, z: -14.433 }; // archery.tscn target node
const REMOTE_Y_FUDGE = 0.02;                            // archery.gd play_replay
// Wire-frame centre a landing is scored against (world centre + the receiver's
// y-fudge, so scoreFromXY reads the raw move.x/move.y).
const TARGET_CENTER = { x: TARGET_WORLD.x, y: TARGET_WORLD.y + REMOTE_Y_FUDGE }; // (0, 1.382)
const RING_WIDTH = 0.0808;                 // BASE_RADIUS (target.gd)
const NUM_RINGS = 10;                       // NUM_SEGMENTS (target.gd)
const OUTER_RADIUS = RING_WIDTH * NUM_RINGS; // 0.808 - outer scoring edge (ring 1)
const BOARD_RADIUS = 0.75;                  // archery.gd miss-popup snap radius (NOT scoring)
// Per-set target depth (archery.gd set_number: set1 default, set2/3 shifts). z is
// cosmetic (scoring zeroes it) but we emit the set's depth so the arrow renders in
// the target's plane. Matches the observed wire (-14.397592) and archery.gd.
const SET_DEPTH: Record<PropertyKey, unknown> = { 1: -14.397592, 2: -20.397592, 3: -26.397592 };

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }

// -----------------------------------------------------------------------------
// scoreFromXY(x, y) -> 0..10.
// Re-scores a WIRE landing coordinate EXACTLY the way the GamePigeon receiver does
// (target.gd calc_score, with the play_replay -0.02 y-fudge folded into the
// centre). 10 = bullseye; 0 = MISS (off the board). This is the ground truth the
// play module asserts every emitted coordinate against.
// -----------------------------------------------------------------------------
function scoreFromXY(x: number, y: number) {
    const dx = x - TARGET_CENTER.x;
    const dy = y - TARGET_CENTER.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return 10; // calc_score: distance 0 => segment 1 => score 10
    const seg = Math.ceil(d / RING_WIDTH);
    if (seg >= 1 && seg <= NUM_RINGS) return 11 - seg;
    return 0; // seg > 10 => off the board (MISS)
}

// scoreForRadius(frac) -> 0..10 for a NORMALIZED radius `frac` in [0,1] expressed
// as a fraction of the outer scoring edge (OUTER_RADIUS). Kept for callers that
// reason in normalized board fractions; equivalent to scoreFromXY at that radius.
function scoreForRadius(frac: unknown) {
    const f = Math.abs(Number(frac) || 0);
    if (f === 0) return 10;
    const seg = Math.ceil(f * NUM_RINGS);
    if (seg >= 1 && seg <= NUM_RINGS) return 11 - seg;
    return 0;
}

// -----------------------------------------------------------------------------
// Aim model - CENTRED SCATTER (single source of truth).
// -----------------------------------------------------------------------------
// THE FIX (2026-07-09) for "only ever hits the red 7/8, never the centre".
//
// The OLD model aimed at an OUTWARD MEAN radius ((1-acc)*MEAN_RADIUS_MAX) and
// jittered around it 1-D. That centred the whole shot group on a ring-7/8 ANNULUS,
// so the bullseye was mathematically unreachable until accuracy was near-perfect -
// every eased shot piled onto the red rings, exactly the tester's complaint.
//
// The NEW model aims AT THE BULLSEYE and lands each arrow at the centre PLUS an
// independent 2-D Gaussian error whose std-dev grows as accuracy drops:
//         sigma = wildness(acc) * SIGMA_MAX          (fraction of OUTER_RADIUS)
//         (dx, dy) = sigma * (gx, gy)                 gx,gy ~ N(0,1)
//         landing  = centre + (dx, dy)  ->  scoreFromXY(landing)
// so the group is a DISC centred on the gold: a strong Bot groups tight on 9-10
// (centre reachable, frequent bullseyes), and a weak Bot SPRAYS the competitive
// band (mean ~ring 5, arrows spanning ~3-8) - never a single stamped outer ring.
// At accuracy 1, sigma = 0, so every arrow is a dead-centre bullseye (the flawless
// ramp-up / "max" behaviour, unchanged). The ring is always RE-SCORED from the
// exact emitted coordinate (scoreFromXY), never faked.
//
//   SIGMA_MAX - the 2-D scatter std-dev (fraction of OUTER_RADIUS) at wildness 1
//     (accuracy 0, the weakest floor). 0.48 puts the WEAKEST expected arrow near
//     ring 4.6 (set ~14) with arrows spraying ~1-9, so Bot can shoot a genuinely
//     bad set like a weak human does - the missing low tail is exactly why a
//     narrower sigma left an eased Bot winning a weak opponent's off sets (its
//     worst set still floored ~16 while the human sprayed to 10). Every accuracy
//     above the floor tightens smoothly toward the gold; the mirror re-inverts for
//     this sigma so matching a strong opponent is unaffected.
//   ON_TARGET_MAX - hard clamp (fraction) so every landing stays on the board
//     (ring >= 1). 0.985 * OUTER_RADIUS = 0.7957 < 0.808, so it always scores >= 1;
//     Gaussian mass past the edge is folded onto ring 1, matching the receiver
//     (which snaps a near-miss onto the board rather than awarding a 0 here).
// -----------------------------------------------------------------------------
const SIGMA_MAX = 0.48;       // 2-D scatter std-dev (fraction) at accuracy 0
const ON_TARGET_MAX = 0.985;  // fraction clamp so a landing is always on the board

// accuracyToSigma(acc) -> the 2-D scatter std-dev (fraction of OUTER_RADIUS).
// Linear in wildness so sigma = 0 at accuracy 1 (flawless) and SIGMA_MAX at the
// floor. Monotonic: higher accuracy => tighter group => higher expected ring.
function accuracyToSigma(acc: unknown) {
    const w = clamp(1 - clamp(Number(acc) || 0, 0, 1), 0, 1);
    return w * SIGMA_MAX;
}

// -----------------------------------------------------------------------------
// placeAt(frac, seedAngle, setNum) -> { x, y, z, radius, frac, ringScore, angle }
// Places a landing at a normalized radius `frac` (fraction of the board) and angle
// `seedAngle`, in the true wire frame (centre (0, 1.382)). Rings are concentric,
// so the angle is cosmetic - only the radius drives the score. ringScore is the
// HONEST receiver-exact score of the emitted point. frac is clamped onto the board.
// -----------------------------------------------------------------------------
function placeAt(frac: unknown, seedAngle: unknown, setNum: PropertyKey) {
    const f = clamp(Number(frac) || 0, 0, ON_TARGET_MAX);
    const r = f * OUTER_RADIUS;
    const angle = typeof seedAngle === 'number' ? seedAngle : 0;
    const x = TARGET_CENTER.x + r * Math.cos(angle);
    const y = TARGET_CENTER.y + r * Math.sin(angle);
    const z = SET_DEPTH[setNum] != null ? SET_DEPTH[setNum] : SET_DEPTH[1];
    return { x, y, z, radius: r, frac: f, ringScore: scoreFromXY(x, y), angle };
}

// -----------------------------------------------------------------------------
// gaussianPair(rng) -> { gx, gy } two independent standard normals (Box-Muller).
// Deterministic given rng (the shared fair-play mulberry32), so the per-arrow
// scatter is reproducible for a given card yet varies card-to-card.
// -----------------------------------------------------------------------------
function gaussianPair(rng: TargetRandom) {
    let u1 = rng();
    if (u1 < 1e-12) u1 = 1e-12; // guard log(0)
    const u2 = rng();
    const mag = Math.sqrt(-2 * Math.log(u1));
    return { gx: mag * Math.cos(2 * Math.PI * u2), gy: mag * Math.sin(2 * Math.PI * u2) };
}

// -----------------------------------------------------------------------------
// aimCentered(accuracy, gx, gy, setNum) -> placeAt(...)
// Aim AT the bullseye; land at centre + sigma*(gx,gy) where sigma grows as accuracy
// drops. gx,gy are standard-normal samples (from gaussianPair). The radius drives
// the score; the angle is whatever direction the 2-D error points (cosmetic). At
// accuracy 1, sigma = 0 so the landing is the exact centre (bullseye), matching the
// flawless ramp-up. Every landing is clamped onto the board inside placeAt.
//   accuracy : mean aim quality in [0,1] (1 = dead centre, flawless).
//   gx, gy   : standard-normal error samples (gaussianPair); 0,0 => bullseye.
//   setNum   : current set (selects the emitted z depth).
// -----------------------------------------------------------------------------
function aimCentered(accuracy: unknown, gx: unknown, gy: unknown, setNum: PropertyKey) {
    const sigma = accuracyToSigma(accuracy);
    const dx = sigma * (typeof gx === 'number' ? gx : 0);
    const dy = sigma * (typeof gy === 'number' ? gy : 0);
    const frac = Math.hypot(dx, dy);
    const angle = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
    return placeAt(frac, angle, setNum);
}

// -----------------------------------------------------------------------------
// expectedRingScore(accuracy) -> analytic E[ring score] under the centred model.
// Closed form: with a 2-D Gaussian of std sigma (fraction), the landing radius R is
// Rayleigh, so P(R in ring k) = exp(-((k-1)/N)^2/(2s^2)) - exp(-(k/N)^2/(2s^2)) for
// k=1..N (score N+1-k), and the tail mass past the outer edge is folded onto ring 1
// (score 1) because placeAt clamps every landing onto the board. Monotonic in
// accuracy from ~ring 5 at the floor to exactly 10 at accuracy 1. Used to MIRROR an
// opponent's demonstrated per-arrow strength (see archery-play.ts) and to report
// the ring distribution in the self-check.
// -----------------------------------------------------------------------------
function expectedRingScore(accuracy: unknown) {
    const sigma = accuracyToSigma(accuracy);
    if (sigma <= 0) return NUM_RINGS; // flawless: always bullseye
    const two = 2 * sigma * sigma;
    let e = 0;
    for (let k = 1; k <= NUM_RINGS; k++) {
        const inner = (k - 1) / NUM_RINGS;
        const outer = k / NUM_RINGS;
        const p = Math.exp(-(inner * inner) / two) - Math.exp(-(outer * outer) / two);
        e += (NUM_RINGS + 1 - k) * p;
    }
    e += 1 * Math.exp(-(1) / two); // tail past the edge -> clamped to ring 1 (score 1)
    return e;
}

// -----------------------------------------------------------------------------
// accuracyForExpectedScore(targetPerArrow) -> accuracy in [0,1] whose expected ring
// score is targetPerArrow. Monotonic bisection on expectedRingScore. The target is
// clamped to the achievable range [expectedRingScore(0), 10] so a weaker-than-floor
// or above-10 request maps to the floor / flawless rather than NaN. Lets the play
// module aim its group at whatever ring an OBSERVED opponent is shooting (honest
// "beatable ~half" mirroring), independent of the frozen factor.
// -----------------------------------------------------------------------------
function accuracyForExpectedScore(targetPerArrow: unknown) {
    const floorE = expectedRingScore(0);
    const t = clamp(Number(targetPerArrow) || 0, floorE, NUM_RINGS);
    if (t >= NUM_RINGS) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        if (expectedRingScore(mid) < t) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

export const archeryEngine = {
    // authoritative geometry
    TARGET_WORLD,
    TARGET_CENTER,
    REMOTE_Y_FUDGE,
    RING_WIDTH,
    NUM_RINGS,
    OUTER_RADIUS,
    BOARD_RADIUS,
    SET_DEPTH,
    // scoring
    scoreFromXY,
    scoreForRadius,
    // aim (centred-scatter model)
    SIGMA_MAX,
    ON_TARGET_MAX,
    accuracyToSigma,
    placeAt,
    gaussianPair,
    aimCentered,
    expectedRingScore,
    accuracyForExpectedScore,
};

