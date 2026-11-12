// games/pool-engine.ts
// =============================================================================
// GamePigeon 8-Ball physics engine + shot planner (game=pool) - pure, no I/O
// =============================================================================
//
// NOTE (2026-07-09 real-physics rebuild): the AUTHORITATIVE shot simulator is now
// games/pool-real-engine.ts - GamePigeon's own Box2D pool transcribed to WASM.
// pool-play.ts SIMULATES and ENCODES every shot through that faithful engine. THIS
// file is retained as the pure-JS GEOMETRY provider that pool-play still relies on
// (aimGhostBall, pathClear, POCKETS, felt/ball constants, isOffTable, settleToFelt,
// simInsideFelt, tableSeed). Its own simulate()/planShot() 2D approximation is no
// longer on the emit path (kept for reference/tests); do not route new pool card
// emission through it - use pool-real-engine so the POST matches the device.
//
// Deterministic 2D pool physics used to (a) CALIBRATE against a real captured
// shot and (b) SIMULATE Bot's own shot so we can emit the post-shot ball block
// GamePigeon's replay format carries.
//
// -------------------------------- WIRE FORMAT --------------------------------
// A pool gameplay card's `replay` field is:
//   [&o:1]&d:<f>&x:<f>&y:<f>&p:<f>&s:<int>&balls:#<e0>#<e1>...#|balls:<e0>#..#&stripes:<int>[&move:<int>|&win:1]
// A multi-shot run packs several shot headers between the PRE and POST blocks:
//   <shot0 hdr>&balls:<PRE>|<shot1 hdr>|<shot2 hdr>|...|balls:<POST>&stripes:..
// but Bot only ever emits a SINGLE shot per card (one header, one PRE, one POST).
// Each ball entry <eN> is:
//   x, y, f3, f4, ballNum, r1, r2, r3       (8 comma-separated floats/ints)
// where (x,y) is table position (playfield 784x440, ball radius ~10.5), f3 is a
// display/rotation angle (cosmetic), and r1..r3 are 3D texture-rotation values
// (cosmetic, carried through for unmoved balls). ballNum 0..15 (0 = cue).
//
// VERIFIED ENCODINGS (a test line winner chain, game bJqdVpABIvmmmREg):
//   * POTTED BALL: its 8-field entry is DROPPED from the block. A mid-game table
//     has FEWER than 16 entries; there is no placeholder / flag for a potted ball.
//   * f4: COSMETIC per-ball render scale on the rack/break PRE block (0.05..1.38);
//     every SETTLED post-shot block is f4=1.000000. NOT an on-/off-table flag.
//   * &stripes: 0 on the open table; flips to 1 once suits are assigned (first
//     legal pot after the break) and stays 1. Suit OWNERSHIP is derived from group
//     membership (solids 1-7 / stripes 9-15), not a separate field.
//   * &o:1 prefixes a shot taken with ball-in-hand (opponent scratched).
//   * &win:1 in the tail + top-level winner:"<senderId>|<playerNum>" = finish.
// pool-play.ts drops potted entries, derives suit, and emits the winner shape.
//
// Shot params (REVERSE-ENGINEERED from ROWID 32766 break + 32770 normal shot):
//   d = aim angle, radians, SCREEN coords y-DOWN. dir = (cos d, sin d).
//       VERIFIED: 32770 d=0.247849 -> ray from cue (635.4,338.4) passes 9.8px from
//       ball 10 (radius ~10.5 => dead-on); ball 10 was the primary mover. 32766
//       break d=-0.337726 -> ray from cue (198,380) hits the rack apex column.
//   p = power. 2000.0 in BOTH captures - treated as full power / the max value.
//   x,y,s = cue-tip english/spin. Break used x=0.0, s=0 (center-ball). We only
//       ever emit CENTER-BALL shots (x=0,y=0,s=0) so behaviour matches the one
//       capture whose spin we can trust. d is necessary AND sufficient for aim.
//
// Physics constants are TUNED so replaying 32770's (pre + d) reproduces the
// captured post block as closely as a from-scratch sim can (see the production dry-run harness, not included,
// for the honest per-ball residuals). Perfection is impossible; the goal is
// "same balls move the same general directions and stop in plausible spots".
// =============================================================================

import type { Ball, Point, ApproximateShot, ApproximateSimulation, FairPlay } from './pool-types.ts';
import { fairPlay } from './fair-play.ts';

const fair: FairPlay = fairPlay;

// -----------------------------------------------------------------------------
// Table + ball geometry (inferred from captures)
// -----------------------------------------------------------------------------
const FIELD_W = 784;              // cue respot (392,220) = exact table center => 784x440
const FIELD_H = 440;
const BALL_R = 10.5;              // rack row spacing 21.0 => radius 10.5
const R2 = BALL_R * 2;
const CUSHION_X0 = BALL_R;
const CUSHION_X1 = FIELD_W - BALL_R;
const CUSHION_Y0 = BALL_R;
const CUSHION_Y1 = FIELD_H - BALL_R;

// Six pockets: 4 corners + 2 side midpoints (standard table).
const POCKETS = [
    { x: 0, y: 0 }, { x: FIELD_W / 2, y: 0 }, { x: FIELD_W, y: 0 },
    { x: 0, y: FIELD_H }, { x: FIELD_W / 2, y: FIELD_H }, { x: FIELD_W, y: FIELD_H },
];
// POCKET_R is the sim's OWN capture radius. Real GamePigeon (Box2D) pockets balls
// Bot leaves 130-235px out - its corner mouths + jaw funnel are far larger/deeper
// than a small disc. We DO NOT chase that by inflating POCKET_R: a bigger disc just
// makes the chaotic multi-ball sim over-CLAIM pots that Box2D would miss (the
// "magic pockets" bug). The sim stays conservative; HONEST pot selection lives in
// confidentPot() below, which only greenlights a pot the geometry guarantees under
// any reasonable physics.
const POCKET_R = 20;              // modest bump from 19; still deliberately tight

// -----------------------------------------------------------------------------
// Physics constants (calibrated against ROWID 32770).
// -----------------------------------------------------------------------------
// FULL_POWER_SPEED: pixel/step cue speed at p=2000 (full). Tuned so the cue
// travel-to-first-contact + the transferred energy roughly matches the capture.
// Nudged toward Box2D reach so a confidently-aimed straight pot actually rolls
// into the pocket in the sim too (was 62.0 / .985 - under-powered, stopped short).
const FULL_POWER_SPEED = 66.0;
const FRICTION = 0.988;          // per-step velocity retention (rolling friction)
const STOP_SPEED = 0.35;          // below this a ball is at rest
const RESTITUTION = 0.93;        // ball-ball collision energy retention
const CUSHION_REST = 0.86;        // rail bounce energy retention
const MAX_STEPS = 4000;

// -----------------------------------------------------------------------------
// Felt-bounds validation (BUG #2 defense). A legal resting ball CENTER lies inside
// [BALL_R, FIELD_W-BALL_R] x [BALL_R, FIELD_H-BALL_R]. GamePigeon encodes SOME
// potted balls by parking their entry at a junk off-table coordinate (large y,
// ~2500-3000) rather than dropping it. isOffTable() flags those junk coordinates so
// the caller treats them as already-potted (never loads them onto the felt, never
// lets the cushion clamp drag one back into a rail). inBounds()/clampToFelt()
// guarantee no ball is ever EMITTED resting inside or behind a cushion.
// -----------------------------------------------------------------------------
const OFF_TABLE_MARGIN = 40;      // slack beyond the felt before it reads as junk/potted
function inBounds(x: number, y: number) {
    return x >= CUSHION_X0 - 0.5 && x <= CUSHION_X1 + 0.5 &&
           y >= CUSHION_Y0 - 0.5 && y <= CUSHION_Y1 + 0.5;
}
function isOffTable(x: number, y: number) {
    // Well outside the playfield in ANY direction => GamePigeon's "flung into a
    // pocket" junk coordinate for an already-potted ball (or otherwise not on felt).
    return x < CUSHION_X0 - OFF_TABLE_MARGIN || x > CUSHION_X1 + OFF_TABLE_MARGIN ||
           y < CUSHION_Y0 - OFF_TABLE_MARGIN || y > CUSHION_Y1 + OFF_TABLE_MARGIN;
}
function clampToFelt<T extends Point>(b: T): T {
    if (b.x < CUSHION_X0) b.x = CUSHION_X0;
    else if (b.x > CUSHION_X1) b.x = CUSHION_X1;
    if (b.y < CUSHION_Y0) b.y = CUSHION_Y0;
    else if (b.y > CUSHION_Y1) b.y = CUSHION_Y1;
    return b;
}
// settleToFelt: like clampToFelt but pushes a hair INSIDE the rail line, not onto it.
// A ball resting exactly on CUSHION_Y1 (=429.5) was what read as "half under the
// cushion" on the tester's device. FELT_INSET keeps every emitted rest position strictly
// on the visible felt so GamePigeon never renders a rail-embedded / under-table ball.
const FELT_INSET = 0.75;          // px inside the cushion line a settled ball may rest
function settleToFelt<T extends Point>(b: T): T {
    if (b.x < CUSHION_X0 + FELT_INSET) b.x = CUSHION_X0 + FELT_INSET;
    else if (b.x > CUSHION_X1 - FELT_INSET) b.x = CUSHION_X1 - FELT_INSET;
    if (b.y < CUSHION_Y0 + FELT_INSET) b.y = CUSHION_Y0 + FELT_INSET;
    else if (b.y > CUSHION_Y1 - FELT_INSET) b.y = CUSHION_Y1 - FELT_INSET;
    return b;
}

// -----------------------------------------------------------------------------
// Ball model: { n, x, y, vx, vy, f3, r1, r2, r3, onTable, pocketed }
// -----------------------------------------------------------------------------
function cloneBalls<T extends Ball>(balls: T[]): T[] {
    return balls.map((b) => ({ ...b }));
}

// -----------------------------------------------------------------------------
// simulate(balls, shot) - advance until all balls rest or MAX_STEPS.
//   shot = { cueN, d, power (0..1) }. Applies velocity to the cue ball along d.
// Returns { balls, pocketedThisShot:[n...], cueScratched, firstContact }.
// Mutates a CLONE; input untouched.
// -----------------------------------------------------------------------------
function simulate(inBalls: Ball[], shot: ApproximateShot): ApproximateSimulation {
    const balls = inBalls.map((b) => ({ ...b, vx: 0, vy: 0 }));
    const byN: Record<number, (typeof balls)[number]> = {};
    balls.forEach((b) => { byN[b.n] = b; if (b.onTable == null) b.onTable = true; });
    const cue = byN[shot.cueN != null ? shot.cueN : 0];
    if (!cue) return { balls, pocketedThisShot: [], cueScratched: false, firstContact: null };

    const speed = FULL_POWER_SPEED * (shot.power != null ? shot.power : 1);
    cue.vx = Math.cos(shot.d) * speed;
    cue.vy = Math.sin(shot.d) * speed;

    const pocketedThisShot = [];
    let cueScratched = false;
    let firstContact: number | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
        let moving = false;
        for (const b of balls) {
            if (!b.onTable) continue;
            if (Math.abs(b.vx) < STOP_SPEED && Math.abs(b.vy) < STOP_SPEED) { b.vx = 0; b.vy = 0; continue; }
            moving = true;
            b.x += b.vx; b.y += b.vy;
            b.vx *= FRICTION; b.vy *= FRICTION;
        }
        if (!moving) break;

        // cushion bounces
        for (const b of balls) {
            if (!b.onTable) continue;
            if (b.x < CUSHION_X0) { b.x = CUSHION_X0; b.vx = -b.vx * CUSHION_REST; }
            else if (b.x > CUSHION_X1) { b.x = CUSHION_X1; b.vx = -b.vx * CUSHION_REST; }
            if (b.y < CUSHION_Y0) { b.y = CUSHION_Y0; b.vy = -b.vy * CUSHION_REST; }
            else if (b.y > CUSHION_Y1) { b.y = CUSHION_Y1; b.vy = -b.vy * CUSHION_REST; }
        }

        // ball-ball collisions (elastic, equal mass)
        for (let i = 0; i < balls.length; i++) {
            const a = balls[i];
            if (!a.onTable) continue;
            for (let j = i + 1; j < balls.length; j++) {
                const c = balls[j];
                if (!c.onTable) continue;
                const dx = c.x - a.x, dy = c.y - a.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 0 && dist < R2) {
                    if (firstContact == null && (a.n === cue.n || c.n === cue.n)) {
                        firstContact = (a.n === cue.n) ? c.n : a.n;
                    }
                    const nx = dx / dist, ny = dy / dist;
                    const overlap = R2 - dist;
                    a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
                    c.x += nx * overlap / 2; c.y += ny * overlap / 2;
                    const rvx = c.vx - a.vx, rvy = c.vy - a.vy;
                    const vn = rvx * nx + rvy * ny;
                    if (vn < 0) {
                        const imp = -vn * RESTITUTION;
                        a.vx -= imp * nx; a.vy -= imp * ny;
                        c.vx += imp * nx; c.vy += imp * ny;
                    }
                }
            }
        }

        // pocket capture
        for (const b of balls) {
            if (!b.onTable) continue;
            for (const pk of POCKETS) {
                if (Math.hypot(b.x - pk.x, b.y - pk.y) < POCKET_R) {
                    b.onTable = false; b.pocketed = true; b.vx = 0; b.vy = 0;
                    pocketedThisShot.push(b.n);
                    if (b.n === cue.n) cueScratched = true;
                    break;
                }
            }
        }
    }

    for (const b of balls) { b.vx = 0; b.vy = 0; }

    // Final settle (BUG #2): guarantee every ON-TABLE ball rests at a LEGAL felt
    // position - strictly INSIDE the cushion line (settleToFelt, not clampToFelt),
    // never overlapping. A ball resting exactly on the rail line read as "under the
    // cushion" on-device, so we push a hair inside. This is the sim's authoritative
    // rest state and - crucially - the POST is built directly from it, so whatever
    // settleToFelt does here is exactly what gets encoded (no separate clamp later
    // can decouple the POST from this simulation's result).
    for (const b of balls) {
        if (!b.onTable) continue;
        settleToFelt(b);
    }
    // Resolve any residual ball-ball overlap left by the last integration step so
    // two settled balls never occupy the same spot (which GamePigeon would render
    // as one ball inside another). A few relaxation passes is plenty at rest.
    for (let pass = 0; pass < 8; pass++) {
        let moved = false;
        for (let i = 0; i < balls.length; i++) {
            const a = balls[i];
            if (!a.onTable) continue;
            for (let j = i + 1; j < balls.length; j++) {
                const c = balls[j];
                if (!c.onTable) continue;
                const dx = c.x - a.x, dy = c.y - a.y;
                let dist = Math.hypot(dx, dy);
                if (dist > 0 && dist < R2) {
                    const nx = dx / dist, ny = dy / dist;
                    const push = (R2 - dist) / 2 + 0.01;
                    a.x -= nx * push; a.y -= ny * push;
                    c.x += nx * push; c.y += ny * push;
                    settleToFelt(a); settleToFelt(c);
                    moved = true;
                } else if (dist === 0) {
                    // exact coincidence - nudge apart deterministically
                    a.x -= BALL_R; c.x += BALL_R;
                    settleToFelt(a); settleToFelt(c);
                    moved = true;
                }
            }
        }
        if (!moved) break;
    }

    return { balls, pocketedThisShot, cueScratched, firstContact };
}

// -----------------------------------------------------------------------------
// simInsideFelt(x, y) - a resting position is legal for EMISSION only if it lies
// strictly on the visible felt (inside the cushion line by at least half the inset).
// Distinct from inBounds(), which tolerates a half-pixel ON the cushion line for
// parsing incoming cards. Used by the emit-side validation gate.
// -----------------------------------------------------------------------------
function simInsideFelt(x: number, y: number) {
    return x >= CUSHION_X0 + FELT_INSET - 0.01 && x <= CUSHION_X1 - FELT_INSET + 0.01 &&
           y >= CUSHION_Y0 + FELT_INSET - 0.01 && y <= CUSHION_Y1 - FELT_INSET + 0.01;
}

// -----------------------------------------------------------------------------
// simMatchesPost(preBalls, shot, postByN, tol) - REPLAY-CONSISTENCY assertion.
// Re-simulate `shot` from `preBalls` and confirm the resulting on-table rest state
// reproduces `postByN` (a { n: {x,y} } map) within `tol` px, AND that the set of
// potted balls matches (same balls dropped). Returns { ok, maxErr, worstN, reason }.
// This is the guard the previous verification MISSED: it proves the encoded POST is
// the TRUE end-state of the encoded d/p shot, so GamePigeon's replay and the board
// snap agree instead of showing two different things.
// -----------------------------------------------------------------------------
function simMatchesPost(preBalls: Ball[], shot: ApproximateShot, postByN: Record<string, Point>, tol?: number) {
    const T = tol == null ? 1.0 : tol;
    const res = simulate(preBalls, shot);
    const simByN: Record<number, Ball> = {};
    res.balls.forEach((b) => { simByN[b.n] = b; });
    let maxErr = 0, worstN: number | null = null;
    // every ball in POST must be on-table in the sim at the same spot
    for (const n of Object.keys(postByN)) {
        const nn = Number(n);
        const sb = simByN[nn];
        const pb = postByN[n];
        if (!sb || !sb.onTable) {
            return { ok: false, maxErr: Infinity, worstN: nn,
                reason: 'ball ' + nn + ' is in POST but sim pocketed/lost it' };
        }
        const err = Math.hypot(sb.x - pb.x, sb.y - pb.y);
        if (err > maxErr) { maxErr = err; worstN = nn; }
    }
    // every on-table ball in the sim must appear in POST (no ball the sim kept was dropped)
    for (const b of res.balls) {
        if (!b.onTable) continue;
        if (postByN[String(b.n)] == null) {
            return { ok: false, maxErr: Infinity, worstN: b.n,
                reason: 'ball ' + b.n + ' still on felt in sim but missing from POST' };
        }
    }
    return { ok: maxErr <= T, maxErr, worstN, reason: maxErr <= T ? null : 'max drift ' + maxErr.toFixed(2) + 'px > ' + T };
}

// -----------------------------------------------------------------------------
// aimGhostBall(cue, target, pocket) - aim angle d (y-down) that sends the cue
// into the ghost-ball contact point so `target` heads toward `pocket`.
// Returns { d, ghostX, ghostY, cutAngle } or null if geometrically impossible.
// -----------------------------------------------------------------------------
function aimGhostBall(cue: Point, target: Point, pocket: Point) {
    const tpx = pocket.x - target.x, tpy = pocket.y - target.y;
    const tpLen = Math.hypot(tpx, tpy);
    if (tpLen < 1e-6) return null;
    const ux = tpx / tpLen, uy = tpy / tpLen;
    // ghost ball sits one diameter behind the target along the target->pocket line
    const ghostX = target.x - ux * R2;
    const ghostY = target.y - uy * R2;
    const ax = ghostX - cue.x, ay = ghostY - cue.y;
    const aLen = Math.hypot(ax, ay);
    if (aLen < 1e-6) return null;
    const d = Math.atan2(ay, ax);
    const dot = (ax / aLen) * ux + (ay / aLen) * uy;
    const cutAngle = Math.acos(Math.max(-1, Math.min(1, dot)));
    return { d, ghostX, ghostY, cutAngle };
}

// -----------------------------------------------------------------------------
// pathClear(balls, from, toX, toY, ignoreN) - is the straight path from `from`
// to (toX,toY) clear of other balls (within a ball-diameter corridor)?
// -----------------------------------------------------------------------------
function pathClear(balls: Ball[], from: Ball, toX: number, toY: number, ignoreN?: number) {
    const dx = toX - from.x, dy = toY - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const ux = dx / len, uy = dy / len;
    for (const b of balls) {
        if (!b.onTable) continue;
        if (b.n === from.n || b.n === ignoreN) continue;
        const rx = b.x - from.x, ry = b.y - from.y;
        const t = rx * ux + ry * uy;
        if (t <= 0 || t >= len) continue;
        const perp = Math.abs(rx * uy - ry * ux);
        if (perp < R2 - 1) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// confidentPot(cue, target, pocket, balls, ignoreN) - the HONEST-POT gate. Returns
// a confidence-scored aim ONLY for a pot so robust it drops under any reasonable
// physics (2D sim OR GamePigeon's Box2D). This is what kills the "magic pockets"
// bug: Bot may only CLAIM a pot the geometry guarantees, never a marginal cut /
// bank / cascade artifact where the sim and Box2D diverge.
//
// A confident pot requires ALL of:
//   * a valid ghost-ball aim (aimGhostBall != null);
//   * a NEAR-STRAIGHT cut - cutAngle <= MAX_CONF_CUT (~40deg). Cut-induced throw &
//     deflection grow fast past this; the sim can't be trusted on thin cuts.
//   * the target's line to the pocket is CLEAR of other balls (pathClear);
//   * the cue's line to the ghost-ball point is CLEAR (pathClear);
//   * the target sits a comfortable distance from the pocket - not so far the shot
//     needs hero power/precision (MAX_CONF_TP), not needing a bank.
//   * comfortable pocket-approach margin: the target->pocket ray, extended, lands
//     the ball within the pocket jaw with room to spare (implicit in low cut).
// Returns { d, cutAngle, tpDist, confidence } or null. Higher confidence = safer.
// -----------------------------------------------------------------------------
const MAX_CONF_CUT = 0.70;        // ~40deg - max cut angle we'll call "confident"
const MAX_CONF_TP = 300;          // px - max target->pocket distance we'll trust
function confidentPot(cue: Ball, target: Ball, pocket: Point, balls: Ball[], ignoreN?: number) {
    const aim = aimGhostBall(cue, target, pocket);
    if (!aim) return null;
    if (aim.cutAngle > MAX_CONF_CUT) return null;
    const tpDist = Math.hypot(pocket.x - target.x, pocket.y - target.y);
    if (tpDist > MAX_CONF_TP) return null;
    // target must not already be basically in the pocket (guard against junk coords)
    if (!inBounds(target.x, target.y)) return null;
    // cue -> ghost point clear (ignore the target itself, which sits just ahead)
    if (!pathClear(balls, cue, aim.ghostX, aim.ghostY, target.n)) return null;
    // target -> pocket clear (ignore the cue, which is behind the target)
    if (!pathClear(balls, target, pocket.x, pocket.y, ignoreN != null ? ignoreN : cue.n)) return null;
    // Confidence: straighter + closer + shorter cue travel = safer. Normalize each
    // to [0,1] and blend. This is a RANK, not a probability.
    const straight = 1 - (aim.cutAngle / MAX_CONF_CUT);            // 1 = dead straight
    const closeness = 1 - (tpDist / MAX_CONF_TP);                  // 1 = hanging in the jaws
    const cueDist = Math.hypot(aim.ghostX - cue.x, aim.ghostY - cue.y);
    const cueClose = 1 - Math.min(1, cueDist / 700);              // shorter cue travel = safer
    const confidence = straight * 0.55 + closeness * 0.30 + cueClose * 0.15;
    return { d: aim.d, cutAngle: aim.cutAngle, tpDist, confidence };
}

// =============================================================================
// FAIR-PLAY SHOT-SELECTION WEAKENING (the pool competitive fix, 2026-07-07)
// =============================================================================
// This retained approximation planner serves legacy tests and dry-run callers.
// Live pool-play selects and encodes shots through pool-real-engine; its fair-play
// choices are implemented there. Here, fairness changes only the approximate
// shot selection and aim, keeping this planner's returned sim self-consistent.
//
// The old planShot was UNBEATABLE in the adaptive band: it only ever chose a
// CONFIDENT pot (one the geometry guarantees drops), so it NEVER missed an attempted
// pot, and its lone "decline and play safe" branch was gated on factor < 0.60 - but
// the adaptive floor IS 0.60, so that branch was DEAD CODE. Bot potted every
// makeable ball, every game, and won ~75-90%.
//
// Two honest levers, both scaled continuously by (1 - skill) via fair-play:
//   * DECLINE-TO-SAFE: as skill drops, Bot increasingly declines a makeable pot and
//     plays a legal defensive safety instead (fewer pots, slower clearing, more
//     innings for the opponent). Active across the WHOLE band, not just below 0.60.
//   * HONEST MISS: when Bot does go for a pot, a low-skill Bot may misjudge the
//     aim (small angular error) and/or under-hit, so the object ball slides past or
//     stops short. The shot is SIMULATED for real and accepted ONLY if it stays
//     legal (no scratch, no illegal / off-suit / early-8 pot); otherwise Bot falls
//     back to the clean pot. So every emitted card is honest, legal, and on-felt -
//     Bot just plays like a person who rattles shots when it's coasting.
// At skill 1 (factor >= 1.30) both levers are 0: Bot takes the surest pot dead-on,
// byte-identical to the old flawless planner.
// -----------------------------------------------------------------------------
const MAX_DECLINE = 0.55;  // peak P(decline a makeable pot, play safe) at max wildness
const MAX_MISS = 0.70;     // peak P(attempt a pot but wobble the aim) at max wildness
const MISS_MAX_ANGLE = 0.055; // rad - widest aim error a fully-wild miss adds (~3.2deg)

// tableSeed(balls) -> a stable uint32 from the on-table layout so the decline/miss
// RNG is deterministic per position (reproducible, no Math.random) yet varies as the
// table evolves shot to shot.
function tableSeed(balls: Ball[]) {
    const parts = [];
    for (const b of balls) {
        if (b.onTable === false) continue;
        parts.push(b.n, Math.round(b.x), Math.round(b.y));
    }
    return fair.hashSeed.apply(null, parts);
}

// missLegal(sim, legalSet, targetN) - a wobbled shot is a LEGAL miss/pot only if it
// did not scratch, did not sink the 8 early, and sank nothing off-suit. Mirrors
// potClaimOK's legality test but tolerates potting NOTHING (a genuine miss).
function missLegal(sim: ApproximateSimulation, legalSet: Set<number>, targetN: number) {
    const potted = sim.pocketedThisShot;
    if (potted.indexOf(0) >= 0) return false;              // scratched - reject the miss
    const eightIsTarget = targetN === 8;
    for (const n of potted) {
        if (n === targetN) continue;
        if (n === 8 && !eightIsTarget) return false;       // sank the 8 by accident - reject
        if (!legalSet.has(n)) return false;                // sank an off-suit ball - reject
    }
    return true;
}

// tryHonestMiss(balls, cueN, pick, legalSet, skill, rng) -> { d, power, sim } | null.
// Wobble the chosen pot's aim (small angular error + likely under-hit) and return the
// FIRST perturbation whose REAL sim is legal (missLegal). The returned shot may still
// drop the target (Bot made it despite the wobble) or miss it entirely - both are
// honest. Returns null if no legal wobble was found (caller uses the clean pot).
function tryHonestMiss(balls: Ball[], cueN: number, pick: { d: number; target: number }, legalSet: Set<number>, skill: number, rng: () => number) {
    const wild = fair.wildness(skill);
    const angMag = MISS_MAX_ANGLE * wild;
    for (let k = 0; k < 5; k++) {
        const dOff = fair.bipolar(rng) * angMag;          // aim error, bell-ish
        const power = 0.5 + rng() * 0.5;                  // 0.5..1.0 - under-hit likely
        const sim = simulate(balls, { cueN, d: pick.d + dOff, power });
        if (missLegal(sim, legalSet, pick.target)) {
            return { d: pick.d + dOff, power, sim };
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// planShot(balls, legalTargets, opts) - pick Bot's shot HONESTLY, then return the
// TRUE simulation of that exact shot. SELF-CONSISTENCY is the whole point: the
// returned `sim` IS the shot the caller encodes (d/power), so the caller builds the
// POST directly from `sim.balls` and the encoded header always replays to the
// encoded POST. Honesty is achieved by CHOOSING robust shots (confidentPot), NOT by
// surgically editing the POST afterward (that decoupling is exactly what broke it).
//   legalTargets = array of ballNums Bot may hit first (its suit, or ALL non-8
//     balls pre-assignment; [8] when only the 8 remains).
//   opts = { cueN=0, factor (0..1) }.
// Returns:
//   { kind:'pot', d, power, target, pocket, cut, confidence, sim, claim:[ballNums] }
//   { kind:'safe', d, power, target, sim, claim:[ballNums] }
//   or null (no legal target / no cue).
// `claim` = EXACTLY the balls this shot's sim pocketed (minus the cue). Because the
// POST is the same sim's output, claim and POST are consistent BY CONSTRUCTION - a
// claimed ball is dropped precisely because the sim dropped it, never a phantom.
// A 'pot' shot is only chosen when a confident pot's sim actually sinks the target
// WITHOUT scratching the cue; otherwise we fall through to a gentle legal safety.
// -----------------------------------------------------------------------------
function planShot(balls: Ball[], legalTargets: number[], opts?: { cueN?: number; factor?: number }) {
    opts = opts || {};
    const cueN = opts.cueN != null ? opts.cueN : 0;
    const byN: Record<number, Ball> = {}; balls.forEach((b) => { byN[b.n] = b; });
    const cue = byN[cueN];
    if (!cue || !cue.onTable) return null;
    const factor = opts.factor != null ? opts.factor : 1;

    // Object balls left off the cue's shot (used to reject a claim that also sinks
    // an OFF-SUIT / illegal ball - see potClaimOK below).
    const legalSet = new Set(legalTargets);

    // A claim is honest only if the sim pocketed the intended target, did NOT scratch
    // the cue, and did NOT also sink the 8 early or an illegal ball. On the 8-ball
    // endgame (legalTargets === [8]) sinking the 8 is the intended, legal claim.
    function potClaimOK(sim: ApproximateSimulation, targetN: number) {
        const potted = sim.pocketedThisShot;
        if (potted.indexOf(0) >= 0) return false;                 // scratched - not a clean pot
        if (potted.indexOf(targetN) < 0) return false;            // didn't actually sink the target
        const eightIsTarget = targetN === 8;
        for (const n of potted) {
            if (n === targetN) continue;
            if (n === 8 && !eightIsTarget) return false;          // sank the 8 by accident - illegal
            if (!legalSet.has(n)) return false;                   // sank an off-suit ball - decline
        }
        return true;
    }

    // Enumerate every CONFIDENT (robust) pot at a legal target toward a pocket.
    const pots = [];
    for (const tN of legalTargets) {
        const target = byN[tN];
        if (!target || !target.onTable) continue;
        for (const pk of POCKETS) {
            const conf = confidentPot(cue, target, pk, balls, cueN);
            if (!conf) continue;
            pots.push({ d: conf.d, target: tN, pocket: pk, cut: conf.cutAngle,
                tpDist: conf.tpDist, confidence: conf.confidence });
        }
    }
    // Best confidence first.
    pots.sort((a, b) => b.confidence - a.confidence);

    // Fair-play: continuous skill from the shared handicap factor + a deterministic
    // per-table RNG (reproducible; varies as the table evolves).
    const skill = fair.factorToSkill(factor);
    const rng = fair.mulberry32(tableSeed(balls));

    if (pots.length > 0) {
        // DECLINE-TO-SAFE (continuous, whole-band): a low-skill Bot increasingly
        // passes on a makeable pot to play a defensive safety instead. At skill 1 it
        // never declines; at the floor it declines the majority of the time. When it
        // declines we fall through to the SAFE branch below (a real gentle roll).
        const declined = fair.chance(skill, MAX_DECLINE, rng);
        if (!declined) {
            // Pick WHICH confident pot: the surest (index 0) at high skill; bias toward
            // a lower-confidence (harder, thinner-cut / longer) pot as skill drops.
            const span = pots.length - 1;
            const idx = span > 0 ? Math.round(fair.wildness(skill) * span) : 0;
            const order = [Math.min(span, Math.max(0, idx))];
            for (let i = 0; i < pots.length; i++) if (order.indexOf(i) < 0) order.push(i);
            // Take the first pot whose OWN clean sim cleanly sinks its target with no
            // scratch / illegal drop (self-consistency: the shot we return is verified).
            for (const oi of order) {
                const pick = pots[oi];
                const cleanSim = simulate(balls, { cueN, d: pick.d, power: 1 });
                if (!potClaimOK(cleanSim, pick.target)) continue;
                // HONEST MISS: a low-skill Bot may wobble this pot. tryHonestMiss
                // returns a REAL, legal wobbled shot (may miss or still drop the
                // target); if none is legal it returns null and we keep the clean pot.
                let chosen = { d: pick.d, power: 1, sim: cleanSim };
                if (fair.chance(skill, MAX_MISS, rng)) {
                    const miss = tryHonestMiss(balls, cueN, pick, legalSet, skill, rng);
                    if (miss) chosen = miss;
                }
                const claim = chosen.sim.pocketedThisShot.filter((n) => n !== 0);
                const sankTarget = chosen.sim.pocketedThisShot.indexOf(pick.target) >= 0;
                return {
                    kind: sankTarget ? 'pot' : 'safe',
                    d: chosen.d, power: chosen.power, target: pick.target, pocket: pick.pocket,
                    cut: pick.cut, confidence: pick.confidence, tpDist: pick.tpDist,
                    sim: chosen.sim, claim, candidates: pots.length,
                };
            }
        }
    }

    // No confident pot survived its own sim (or easy-mode declined): legal SAFE
    // contact - roll gently into the nearest legal target. The claim is EXACTLY what
    // the sim pocketed (normally nothing); if the gentle roll happens to drop the
    // target legally that's a real pot and stays consistent, but we NEVER scratch.
    let nearest = null, best = Infinity;
    for (const tN of legalTargets) {
        const t = byN[tN];
        if (!t || !t.onTable) continue;
        const dd = Math.hypot(t.x - cue.x, t.y - cue.y);
        if (dd < best) { best = dd; nearest = t; }
    }
    if (!nearest) return null;
    const d = Math.atan2(nearest.y - cue.y, nearest.x - cue.x);
    // Gentle power so the safety doesn't cascade balls around. Scaled to just reach.
    let reach = Math.max(0.22, Math.min(0.5, best / 950));
    let sim = simulate(balls, { cueN, d, power: reach });
    // If the gentle safe SCRATCHED the cue (drove it into a pocket), soften further;
    // a safe that scratches is worse than a soft tap that just kisses the target.
    if (sim.cueScratched) {
        reach = Math.max(0.16, reach * 0.6);
        sim = simulate(balls, { cueN, d, power: reach });
    }
    // Claim = whatever the sim actually potted (minus cue) - keeps POST consistent
    // even if a soft safety legally drops a suit ball. An off-suit/8 accidental drop
    // is filtered by the caller's win/suit logic; here we just report the truth.
    const claim = sim.pocketedThisShot.filter((n) => n !== 0);
    return { kind: 'safe', d, power: reach, target: nearest.n, sim, claim, candidates: 0 };
}

export const poolEngine = {
    FIELD_W, FIELD_H, BALL_R, R2, POCKETS, POCKET_R, FELT_INSET,
    FULL_POWER_SPEED, FRICTION, RESTITUTION, CUSHION_REST,
    CUSHION_X0, CUSHION_X1, CUSHION_Y0, CUSHION_Y1,
    simulate, aimGhostBall, pathClear, planShot, cloneBalls,
    confidentPot, inBounds, isOffTable, clampToFelt, settleToFelt,
    simInsideFelt, simMatchesPost,
    // fair-play shot-selection weakening (exported for tests)
    tableSeed, missLegal, tryHonestMiss, MAX_DECLINE, MAX_MISS, MISS_MAX_ANGLE,
};

