// games/beer-engine.ts
import type { Point3, Random, BeerTurnOptions, BeerTurnResult, BeerBuildReplay, BeerThrow, BeerParsedMove } from './engine-types.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// Cup Pong engine (game=beer) - NATIVE board:/move: wire, no I/O
// =============================================================================
//
// Bot now speaks Cup Pong's REAL gameplay wire (the shared `replay` field), the
// exact string a genuine GamePigeon client emits from cuppong.gd::export_replay().
// This replaces the old per-slot `replay1` + trusted-score encoding, which the tester's
// authentic client DISCARDED (foreign field) - so his board reset every turn and
// he never saw Bot's throws. The native format makes the board PERSIST, Bot's
// throw RENDER, and the made cups REGISTER on his device.
//
// ======================= WIRE FORMAT (BYTE-PROVEN) ===========================
// The shared `replay` value is a `|`-joined sequence:
//
//   board:<rack1>&<rack2> | move:<traj><cup?>&24 | ... | board:<rack1>&<rack2>
//
//   * board:<rack1>&<rack2>  - two comma lists of STANDING cup indices (0..9).
//       rack1 = player-2's cups (the rack player 1 throws at).
//       rack2 = player-1's cups (the rack player 2 throws at).
//       (Positional + STABLE across the whole game - proven by tracing the
//        export_board()/player-flip logic in cuppong.gd.) An empty rack = "".
//       The FIRST board = state at the start of this turn; the LAST board = state
//       at the end (it becomes the next sender's start board).
//
//   * move:<traj><cup?>&24  - one thrown ball. `traj` is a per-frame ball flight:
//       6 chars/frame = 3 base-74 fixed-point pairs decoding to world (x,y,z):
//         x = convback(pair)*6 - 3 ; y = convback(pair)*4 - 2 ; z = convback(pair)*8 - 4
//       The receiver's playReplay() TWEENS the ball through these points (pure
//       animation - no physics, no collision). MADE vs MISS is encoded by LENGTH,
//       not the arc: a MADE throw appends the 0-based cup index digit after the
//       frames (len % 6 == 1); the receiver runs remove_cup(digit+1), deleting
//       `digit` from that rack's standing list. A MISS is exactly 6*N chars (no
//       digit). The `&24...` tail is cosmetic bounce-frame indices - IGNORED by
//       the parser (`spl[1].split("&")[0]`). We emit a constant `&24`.
//
//   * CHARMAP (len 74). cuppong.gd's literal is "...()_+-.';" with '+' at index 69,
//       BUT GamePigeon form-decodes the value, turning that '+' into a SPACE - so
//       on the decoded wire (what our parseEnvelope yields and what the peer's game
//       logic reads) index 69 is ' '. The tester's real card carries literal spaces mid
//       trajectory, confirming it. We therefore use ' ' at index 69 for BOTH conv
//       and convback; convback also accepts a stray '+' defensively.
//
// PROVEN: decoding the tester's two real throws (chat.db game UuXa7c1IZLLkfEZi, ROWID
// 33180) yields frame 0 == (0,-0.574,-0.80) == the engine's replay_ball_start_pos,
// a clean parabola (peak +0.258), z marching monotonically toward the cups; and a
// synthesized arc round-trips byte-identically through the real envelope.
//
// RE-RACK (mode "n"): cuppong.gd re-forms the rack when it drops to exactly 6 or 3
// cups (arrangeCups → cups_in_play becomes [0..5] / [0..2]). We mirror this after
// every made cup so our digits + board always match what the peer's client computes.
// Mode "h" (random cup positions) never re-racks - indices stay 0..9.
// =============================================================================

// Standard Cup Pong rack = 4-3-2-1 triangle = 10 cups.
const TOTAL_CUPS = 10;

// =============================================================================
// SECTION 1 - base-74 trajectory codec (ported from cuppong.gd conv/convback)
// =============================================================================
// cuppong.gd's charmap has '+' at index 69; the form-decode turns it into ' '.
const CHARMAP_RAW = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!@*()_+-.';";
const CHARMAP = CHARMAP_RAW.slice(0, 69) + ' ' + CHARMAP_RAW.slice(70); // ' ' at index 69
const CHARMAP_LEN = CHARMAP.length; // 74
const CHARMAP_MAX = CHARMAP_LEN * CHARMAP_LEN - 1; // 5475

// conv(f in [0,1]) -> two charmap chars (a base-74 fixed-point pair).
function conv(f: number) {
    let idx = Math.round(f * CHARMAP_MAX);
    if (idx < 0) idx = 0;
    if (idx > CHARMAP_MAX) idx = CHARMAP_MAX;
    return CHARMAP[Math.floor(idx / CHARMAP_LEN)] + CHARMAP[idx % CHARMAP_LEN];
}

// convback(2-char pair) -> f in [0,1]. Accepts a stray '+' as index 69 defensively.
function convback(pair: string) {
    let a = CHARMAP.indexOf(pair[0]);
    let b = CHARMAP.indexOf(pair[1]);
    if (a < 0) a = (pair[0] === '+') ? 69 : 0;
    if (b < 0) b = (pair[1] === '+') ? 69 : 0;
    return (b + a * CHARMAP_LEN) / CHARMAP_MAX;
}

// Encode / decode a single world point <-> a 6-char frame group.
function encodePoint(p: Point3) {
    return conv((p.x + 3) / 6) + conv((p.y + 2) / 4) + conv((p.z + 4) / 8);
}
function decodePoint(grp: string) {
    return {
        x: convback(grp.slice(0, 2)) * 6 - 3,
        y: convback(grp.slice(2, 4)) * 4 - 2,
        z: convback(grp.slice(4, 6)) * 8 - 4,
    };
}

// =============================================================================
// SECTION 2 - cup geometry (world positions the ball arcs toward)
// =============================================================================
// The ball is spawned at replay_ball_start_pos and flies toward the cups (more
// negative z). Positions below are lifted byte-for-byte from cuppong.gd::
// arrangeCups() for the 6-cup and 3-cup re-racks; the 10-cup triangle is a
// faithful 4-3-2-1 reconstruction sharing that spacing (x step 0.142, z step
// 0.120). Geometry is COSMETIC (the removed cup is chosen by the emitted digit,
// not by where the ball lands) so a small offset never affects correctness.
const BALL_START = { x: 0.0, y: -0.574, z: -0.80 };
const CUP_MOUTH_Y = -0.455;      // aim plane cupWorld() hands out (mouth level)

const TRIANGLE_10 = [
    { x: 0.000, z: -1.967 },                                   // 0 front
    { x: -0.071, z: -2.087 }, { x: 0.071, z: -2.087 },          // 1,2
    { x: -0.142, z: -2.207 }, { x: 0.000, z: -2.207 }, { x: 0.142, z: -2.207 }, // 3,4,5
    { x: -0.213, z: -2.327 }, { x: -0.071, z: -2.327 }, { x: 0.071, z: -2.327 }, { x: 0.213, z: -2.327 }, // 6,7,8,9 back
];
const RERACK_6 = [
    { x: 0.000, z: -1.967 },
    { x: -0.071, z: -2.087 }, { x: 0.071, z: -2.087 },
    { x: -0.142, z: -2.207 }, { x: 0.000, z: -2.207 }, { x: 0.142, z: -2.207 },
];
const RERACK_3 = [
    { x: 0.000, z: -2.027 },
    { x: -0.071, z: -2.147 }, { x: 0.071, z: -2.147 },
];

// cupWorld(digit, standingCount, mode, randomPositions) -> {x,y,z} mouth-level.
// Formation depends on standing count (mirrors the re-rack passes).
function cupWorld(digit: number, standingCount: number, mode: unknown, randomPositions?: Point3[]) {
    if (mode === 'h' && randomPositions && randomPositions[digit]) {
        const p = randomPositions[digit];
        return { x: p.x, y: CUP_MOUTH_Y, z: p.z };
    }
    let table;
    if (standingCount >= 7) table = TRIANGLE_10;
    else if (standingCount >= 4) table = RERACK_6;
    else table = RERACK_3;
    const c = table[digit] || table[table.length - 1] || { x: 0, z: -2.1 };
    return { x: c.x, y: CUP_MOUTH_Y, z: c.z };
}

// _generate_random_cup_positions(seed) - port of cuppong.gd (mode "h" only).
function randomCupPositions(seed: number) {
    const MASK = (1n << 48n) - 1n;
    let state = ((BigInt(seed | 0) & 0xFFFFFFFFn) << 16n | 0x330En) & MASK;
    function drand48() {
        state = (state * 0x5DEECE66Dn + 0xBn) & MASK;
        return Number(state) / Number(1n << 48n);
    }
    const TARGET = 10, MIN_DIST = 0.136;
    const X_BASE = -0.426, X_SCALE = 0.852, Z_BASE = -1.907, Z_SCALE = -0.4207, Y = -0.597;
    const positions = [];
    let attempts = 5000;
    while (positions.length < TARGET && attempts-- > 0) {
        const x = X_BASE + X_SCALE * drand48();
        const z = Z_BASE + Z_SCALE * drand48();
        let ok = true;
        for (const p of positions) {
            if (Math.hypot(p.x - x, p.z - z) < MIN_DIST) { ok = false; break; }
        }
        if (ok) positions.push({ x, y: Y, z });
    }
    return positions;
}

// =============================================================================
// SECTION 3 - rack math (standing lists + re-rack)
// =============================================================================
// A rack is an ordered list of standing cup indices. rerack() renumbers to the
// compact formation the instant the count hits 6 or 3 (mode "n" only).
function rerack(list: number[], mode: unknown): unknown {
    if (mode === 'h') return list.slice();
    if (list.length === 6) return [0, 1, 2, 3, 4, 5];
    if (list.length === 3) return [0, 1, 2];
    return list.slice();
}

// removeCup(list, digit, mode) -> new standing list with `digit` gone + re-racked.
function removeCup(list: number[], digit: number, mode: unknown): unknown {
    const out = list.filter((v) => v !== digit);
    return rerack(out, mode);
}

// rackToCsv([0,2,3]) -> "0,2,3"  (empty -> "").
function rackToCsv(list: number[]): unknown {
    return list.join(',');
}
// csvToRack("0,2,3") -> [0,2,3]  ("" -> []).
function csvToRack(s: unknown) {
    if (s == null || s === '') return [];
    return String(s).split(',').map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
}

// =============================================================================
// SECTION 4 - trajectory synthesis (real ballistics at native cadence)
// =============================================================================
// Every arc is a TRUE projectile integration matched frame-for-frame to the
// profile measured from the tester's own captured throws (round-2 diagnosis, game
// gggyOgFmtDuvxv2x rows 267-270 + the 15 earlier captured misses):
//
//   * FIXED LAUNCH CREST. Every native throw - make or miss - crests at world-y
//     +0.258 (the game launches at fixed power; the player aims only in x/z).
//     Vertical motion is y(i) = y0 + v0y*i - g/2*i² with g ≈ 0.0105-0.0114 per
//     recorded frame² (native fits) and v0y solved from the crest.
//   * NATIVE CADENCE FOR FREE. Sampling that parabola at uniform frames yields
//     native's signature gap profile (≈0.14 at launch → 0.05 at apex → 0.13 at
//     landing) with zero shaping - it IS the physics.
//   * EXACT LANDING. Frame count N = round(ideal flight time); g is re-solved
//     from N so frame N lands EXACTLY on the aim point. Native throws show the
//     same per-throw g wobble - it's frame quantization.
//
// MISS TAILS (the round-2 flash fix). The old rollOff() tunneled: wide misses
// slid LATERALLY THROUGH cup bodies at rim height and sank THROUGH the tabletop
// to the codec floor (y=-1.45) INSIDE the table footprint - mesh interpenetration
// the client renders as the "flashing" the tester reported. A second live issue showed
// that even a valid off-back miss leaves GamePigeon's table shadow plane: the
// shadow vanishes at z≈-2.6 and pops back with the next ball. Synthesized misses
// therefore finish ON the table using these endings:
//
//   RIM SIDE  - kiss the rim, deflect OUTWARD past the rack columns while still
//               above rim height, land on open table beside the rack, hop + roll
//               to rest at y≈-0.547 (tabletop -0.597 + ball radius 0.05 - the
//               exact bounce floor the tester's m4 shows).
//   SHORT     - a clean underthrow on the selected cup's x-line that bounces and
//               settles in front of the rack. This is the guaranteed fallback.
//
// Rim-side variants are validated against every standing cup (pathClearOfCups)
// and fall back to SHORT, so no emitted frame interpenetrates a cup/table or exits
// the receiver's shadow plane regardless of rack formation or random mode.
//
// Made balls fly to the mouth plane slightly off-center, then play a short
// in-cup settle to the native rest y=-0.545 (the tester m1/m2 tails). The made marker
// stays LENGTH-encoded: encodeMade returns exactly 6*N chars and buildReplay()
// appends the cup digit => len % 6 == 1.
//
// The receiver (cuppong.gd::playReplay) tweens each kept frame over 0.03 s and
// only hands the ball to physics if a single gap exceeds 0.5 - all gaps here stay
// ≤ ~0.17. It dedups frames closer than ~0.0316, which harmlessly thins the rest
// frames (native tails thin the same way).

const G_FRAME = 0.0105;          // gravity per recorded-frame² (native fit)
const APEX_Y = 0.258;            // fixed launch crest (every native throw)
const RIM_Y = -0.445;            // cup mouth plane (client CUP_MOUTH_Y)
const BALL_R = 0.05;             // ball radius (bounce floor -0.547 = table + r)
const TABLE_Y = -0.597;          // tabletop surface (cups' Y_FIXED)
const TABLE_REST_Y = TABLE_Y + BALL_R; // ball center at rest on the table
const CUP_REST_Y = -0.545;       // ball center at rest inside a cup (native)
const TABLE_BACK_Z = -2.6;       // back edge (client out-of-play boundary)
const MISS_FLOOR_Y = -1.0;       // deepest a native miss falls before it ends

// clampAxis / safePoint - final guard keeping every coordinate strictly inside
// the base-74 codec box so no point ever saturates (a saturated point folds into
// a jump the renderer reads as a discontinuity). The synthesis above never
// reaches these clamps by construction.
function clampAxis(v: number, lo: number, hi: number) { return v < lo ? lo : (v > hi ? hi : v); }
function safePoint(p: Point3) {
    return {
        x: clampAxis(p.x, -2.9, 2.9),
        y: clampAxis(p.y, -1.45, 0.9),
        z: clampAxis(p.z, -3.9, -0.1),
    };
}

// buildArc(target, apexY, minFrames) - the flight: a real parabola from BALL_START through
// the fixed crest, landing EXACTLY on `target` at frame N. Returns
// { pts, vx, vz, g, vyEnd, frames } so tails can continue the motion seamlessly.
// (`apexY` <= 0 or omitted falls back to the native crest.)
function buildArc(target: Point3, apexY?: number, minFrames?: number) {
    const crest = (typeof apexY === 'number' && apexY > 0) ? apexY : APEX_Y;
    const rise = crest - BALL_START.y;
    const fall = Math.max(crest - target.y, 0.05);
    const s = Math.sqrt(rise) + Math.sqrt(fall);
    let N = Math.round(s * Math.sqrt(2 / G_FRAME));
    if (N < 16) N = 16;
    if (Number.isFinite(minFrames) && N < minFrames!) N = minFrames!;
    if (N > 34) N = 34;
    const g = 2 * s * s / (N * N);         // re-solved so frame N is the landing
    const v0y = Math.sqrt(2 * g * rise);
    const vx = (target.x - BALL_START.x) / N;
    const vz = (target.z - BALL_START.z) / N;
    const pts = [];
    for (let i = 0; i <= N; i++) {
        pts.push(safePoint({
            x: BALL_START.x + vx * i,
            y: BALL_START.y + v0y * i - 0.5 * g * i * i,
            z: BALL_START.z + vz * i,
        }));
    }
    return { pts, vx, vz, g, vyEnd: v0y - g * N, frames: N };
}

// pathClearOfCups(pts, standing, aimed) - TRUE iff no frame interpenetrates a
// standing cup body or the tabletop. Frames at cup-body altitude must stay
// ≥ 0.125 (xz) from every standing cup center; the aimed cup alone may be kissed
// at rim height (the deliberate rim-out contact). Frames inside the table
// footprint must never dip below the on-table ball floor.
function pathClearOfCups(pts: Point3[], standing: Point3[] | undefined, aimed: Point3 | undefined) {
    if (!standing || standing.length === 0) return true;
    for (const p of pts) {
        const inFootprint = Math.abs(p.x) < 1.05 && p.z > -2.58 && p.z < -0.9;
        if (inFootprint && p.y < TABLE_REST_Y - 0.012) return false; // under-table
        if (p.y >= -0.385 || p.y <= TABLE_Y) continue;               // above rims / off table
        for (const c of standing) {
            const d = Math.hypot(p.x - c.x, p.z - c.z);
            const isAimed = aimed && Math.hypot(c.x - aimed.x, c.z - aimed.z) < 0.01;
            if (isAimed) {
                if (d <= 0.115 && p.y < -0.43) return false; // sank into the aimed cup
            } else if (d < 0.125) {
                return false;                                 // clipped a neighbor
            }
        }
    }
    return true;
}

// missLong(nearPos, rng) - overthrow: sail over the whole rack, cross the back
// edge still above the tabletop, free-fall to the native miss floor. Provably
// clear of every formation (descent crosses rim height behind the last row).
function missLong(nearPos: Point3, rng?: Random) {
    const lx = nearPos.x + (rng ? fair.bipolar(rng) * 0.08 : 0);
    const lz = TABLE_BACK_Z - 0.06 - (rng ? rng() * 0.10 : 0.05);
    const fl = buildArc({ x: lx, y: -0.50, z: lz });
    const pts = fl.pts.slice();
    let x = lx, y = -0.50, z = lz, vy = fl.vyEnd;
    for (let i = 0; i < 8; i++) {
        vy -= fl.g;
        if (vy < -0.13) vy = -0.13; // native falls never exceed ~0.13/frame
        x += fl.vx; y += vy; z += fl.vz;
        if (y < MISS_FLOOR_Y - 0.05) y = MISS_FLOOR_Y - 0.05;
        pts.push(safePoint({ x, y, z }));
        if (y <= MISS_FLOOR_Y) break;
    }
    return pts;
}

// missShort(nearPos, rng) - a clean underthrow that lands and settles on the
// front half of the table. The old final fallback always sailed beyond z=-2.6;
// GamePigeon's shadow receiver ends at that back edge, so the ball shadow vanished
// until the next throw spawned. This path still aims on the selected cup's x-line,
// but finishes safely in front of the rack and never leaves the shadow plane.
function missShort(nearPos: Point3, rng?: Random) {
    const wobbleX = rng ? fair.bipolar(rng) * 0.055 : 0.02;
    const wobbleZ = rng ? fair.bipolar(rng) * 0.025 : 0;
    const lx = clampAxis(nearPos.x + wobbleX, -0.72, 0.72);
    const lz = clampAxis(nearPos.z + 0.30 + wobbleZ, -1.78, -1.56);
    const fl = buildArc({ x: lx, y: TABLE_REST_Y, z: lz }, undefined, 34);
    const pts = fl.pts.slice();

    // A tiny native-looking table bounce and damped roll. It stays in front of
    // the first cup row, above the tabletop, and inside the shadow camera bounds.
    let x = lx, z = lz;
    let vx = rng ? fair.bipolar(rng) * 0.006 : 0.003;
    let vz = -0.014;
    const hop = [-0.522, -0.508, -0.516, -0.535, TABLE_REST_Y];
    for (const y of hop) {
        vx *= 0.82; vz *= 0.78;
        x = clampAxis(x + vx, -0.78, 0.78);
        z = clampAxis(z + vz, -1.84, -1.50);
        pts.push(safePoint({ x, y, z }));
    }
    for (let i = 0; i < 6; i++) {
        vx *= 0.62; vz *= 0.62;
        x = clampAxis(x + vx, -0.78, 0.78);
        z = clampAxis(z + vz, -1.84, -1.50);
        pts.push(safePoint({ x, y: TABLE_REST_Y, z }));
    }
    return pts;
}

// missRimBack(nearPos, rng) - the tester's m3 byte-for-byte: descend onto the far lip
// of the aimed cup, glance forward off it (keeps most forward speed), second arc
// clears the remaining rows and falls off the back edge. Front-half cups only
// (caller gates on nearPos.z) so the edge is crossed while still above the table.
function missRimBack(nearPos: Point3, rng?: Random) {
    const cx = nearPos.x + (rng ? fair.bipolar(rng) * 0.045 : 0);
    const cz = nearPos.z - 0.055;
    const fl = buildArc({ x: cx, y: RIM_Y + 0.03, z: cz }, undefined, 34);
    const pts = fl.pts.slice();
    const vy0 = 0.058 + (rng ? rng() * 0.004 : 0.002);
    // Forward speed solved so the ball crosses the back edge exactly as it comes
    // back down to tabletop height (native m3 crossed at y=-0.574): tEdge = frames
    // until the bounce arc returns to y=-0.55.
    const tEdge = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G_FRAME * (RIM_Y + 0.03 + 0.55))) / G_FRAME;
    let vz = (TABLE_BACK_Z - 0.04 - cz) / tEdge;
    if (vz > -0.032) vz = -0.032;
    if (vz < -0.058) vz = -0.058;
    let vy = vy0;
    const vx = (rng ? fair.bipolar(rng) * 0.018 : 0.01);
    let x = cx, y = RIM_Y + 0.03, z = cz;
    for (let i = 0; i < 26; i++) {
        vy -= G_FRAME;
        if (vy < -0.13) vy = -0.13;
        x += vx; y += vy; z += vz;
        if (y < MISS_FLOOR_Y - 0.05) y = MISS_FLOOR_Y - 0.05;
        pts.push(safePoint({ x, y, z }));
        if (y <= MISS_FLOOR_Y || z <= -2.95) break;
    }
    return pts;
}

// missRimSide(nearPos, rng) - kiss the rim, deflect OUTWARD past the rack
// columns (still above rim height the whole way across), land on open table
// beside the rack, hop once, roll to rest. Ends like the tester's m4: at rest on the
// table, nowhere near a cup body.
function missRimSide(nearPos: Point3, rng?: Random) {
    let s;
    if (nearPos.x > 0.02) s = 1;
    else if (nearPos.x < -0.02) s = -1;
    else s = (rng && fair.bipolar(rng) >= 0) ? 1 : -1;
    const cx = nearPos.x + s * 0.075;
    const cz = nearPos.z + (rng ? fair.bipolar(rng) * 0.02 : 0);
    const fl = buildArc({ x: cx, y: RIM_Y + 0.03, z: cz });
    const pts = fl.pts.slice();
    let vy = 0.056 + (rng ? fair.bipolar(rng) * 0.004 : 0);
    let vx = s * (0.028 + (rng ? rng() * 0.008 : 0.004));
    let vz = fl.vz * 0.45;
    if (vz < (-2.42 - cz) / 14) vz = (-2.42 - cz) / 14; // keep the landing on the table
    let x = cx, y = RIM_Y + 0.03, z = cz;
    // deflection arc down to the table
    for (let i = 0; i < 20; i++) {
        vy -= G_FRAME;
        x += vx; y += vy; z += vz;
        if (z < -2.46) { z = -2.46; vz = 0; }
        if (y <= TABLE_REST_Y) { y = TABLE_REST_Y; vz *= 0.6; pts.push(safePoint({ x, y, z })); break; }
        pts.push(safePoint({ x, y, z }));
    }
    // small hop + roll to rest (decaying, like a ping-pong ball settling)
    vy = 0.024;
    for (let i = 0; i < 5; i++) {
        vy -= G_FRAME;
        vx *= 0.85; vz *= 0.85;
        x += vx; y += vy; z += vz;
        if (y < TABLE_REST_Y) y = TABLE_REST_Y;
        if (Math.abs(x) > 1.0) x = (x > 0 ? 1 : -1) * 1.0;
        if (z < -2.46) { z = -2.46; vz = 0; }
        pts.push(safePoint({ x, y, z }));
    }
    for (let i = 0; i < 6; i++) {
        vx *= 0.72; vz *= 0.72;
        if (Math.hypot(vx, vz) < 0.004) break;
        x += vx; z += vz;
        if (Math.abs(x) > 1.0) x = (x > 0 ? 1 : -1) * 1.0;
        if (z < -2.46) { z = -2.46; vz = 0; }
        pts.push(safePoint({ x, y: TABLE_REST_Y, z }));
    }
    pts.push(safePoint({ x, y: TABLE_REST_Y, z }));
    pts.push(safePoint({ x, y: TABLE_REST_Y, z }));
    return pts;
}

// encodeMade(cupWorldPos, rng) -> traj chars: a real ballistic lob into the cup
// mouth (slightly off-center like native entries), then the native in-cup settle
// to rest. No cup digit here - buildReplay() appends it (len % 6 == 1).
function encodeMade(pos: Point3, rng?: Random) {
    // Keep the entry visibly inside the cup mouth. The old 2-3cm cosmetic offset
    // could make a registered make skim beside the mesh even though the marker
    // removed the cup correctly, which looked like the ball and cup disagreed.
    const ex = pos.x + (rng ? fair.bipolar(rng) * 0.008 : 0);
    const ez = pos.z + (rng ? fair.bipolar(rng) * 0.006 : 0);
    // GamePigeon starts the next replay ball on a fixed 1.00 s timer. Use at
    // least 35 real moving points (34 intervals) so the current shadow-casting
    // ball remains alive across that handoff after the receiver deduplicates the
    // tiny in-cup settle frames. Duplicate padding alone would be discarded.
    const fl = buildArc({ x: ex, y: RIM_Y, z: ez }, undefined, 34);
    const pts = fl.pts.slice();
    // In-cup settle (native m1/m2 tails): spiral to the cup axis while easing to
    // the rest height, with a tiny damped rebound off the bottom.
    let ox = ex - pos.x, oz = ez - pos.z;
    const drop = [-0.505, -0.538, CUP_REST_Y, -0.536, -0.543, CUP_REST_Y, CUP_REST_Y, CUP_REST_Y];
    const ang = (rng ? rng() : 0.5) * Math.PI * 2;
    for (let i = 0; i < drop.length; i++) {
        ox *= 0.55; oz *= 0.55;
        const w = 0.012 * Math.pow(0.7, i);
        pts.push(safePoint({
            x: pos.x + ox + Math.cos(ang + i * 1.1) * w,
            y: drop[i],
            z: pos.z + oz + Math.sin(ang + i * 1.1) * w,
        }));
    }
    return pts.map(encodePoint).join('');
}

// encodeMiss(nearPos, rng, standing) -> traj chars for a MISS near `nearPos`
// (a still-standing cup). Tries an on-table rim-side miss, validates the path
// against every standing cup (`standing` = [{x,y,z}] world positions), and falls
// back to the always-clear on-table SHORT shape if the rim variant would clip.
// Exactly 6*N chars (no digit) - the client registers no cup.
function encodeMiss(nearPos: Parameters<RetainedMissTrajectory>[0], rng?: Random, standing?: Point3[]) {
    const r = rng ? rng() : 0.2;
    let pts: Point3[] | null | undefined;
    if (r >= 0.35) pts = missRimSide(nearPos, rng);
    if (pts && !pathClearOfCups(pts, standing, nearPos)) pts = null;
    // Never fall back to an off-table sail: that exits the receiver's shadow
    // plane and visibly blinks the shadow until the next ball spawns.
    if (!pts) pts = missShort(nearPos, rng);
    return pts.map(encodePoint).join('');
}

// =============================================================================
// SECTION 5 - turn simulation (honest, ~skill per ball)
// =============================================================================
// simulateTurn: Bot throws at `rackTarget` (a copy) with per-ball make chance
// `skill`. Normal beer-pong pacing = pairs of 2 balls, "balls back" on a perfect
// pair; the turn ends after a non-perfect pair or when the rack clears. If Bot's
// OWN rack was already empty (`redemption`), Bot instead throws make-till-first-
// miss: a miss => Bot LOSES; clearing the target => OVERTIME (both racks -> 3).
//
// Returns { throws:[{traj,cup}], target, made, cleared, lostRedemption, overtime }.
// `cup` is the emitted 0-based digit (or null for a miss). Each made cup is removed
// (+ re-racked) BEFORE the next ball so digits + board match the peer's replay.
function simulateTurn(opts: BeerTurnOptions): BeerTurnResult {
    const mode = opts.mode;
    const skill = Math.max(0, Math.min(1, opts.skill));
    const rng = opts.rng;
    const randomPositions = opts.randomPositions;
    let target = opts.rackTarget.slice();
    const throws: BeerThrow[] = [];
    let made = 0;

    function pickDigit() {
        // Prefer a natural spread: choose a random standing cup.
        return target[Math.floor(rng() * target.length) % target.length];
    }
    function throwOne() {
        if (target.length === 0) return { cleared: true };
        const hit = rng() < skill;
        const beforeCount = target.length;
        if (hit) {
            const digit = pickDigit();
            const pos = cupWorld(digit, beforeCount, mode, randomPositions);
            throws.push({ traj: encodeMade(pos, rng), cup: digit });
            target = removeCup(target, digit, mode) as number[];
            made++;
            return { hit: true, cleared: target.length === 0 };
        }
        // Miss: aim near a still-standing cup so it reads as a rim-out/overshoot.
        // The full standing layout goes along so the miss path can prove itself
        // clear of every cup body (see pathClearOfCups).
        const nearDigit = target[Math.floor(rng() * target.length) % target.length];
        const nearPos = cupWorld(nearDigit, beforeCount, mode, randomPositions);
        const standingPos = target.map((d) => cupWorld(d, beforeCount, mode, randomPositions));
        throws.push({ traj: encodeMiss(nearPos, rng, standingPos), cup: null });
        return { hit: false, cleared: false };
    }

    if (opts.redemption) {
        // Make-till-first-miss. Miss => lose. Clear => overtime.
        for (;;) {
            const r = throwOne();
            if (r.cleared) {
                if (mode !== 'h') {
                    return { throws, target: [0, 1, 2], made, cleared: true, overtime: true, ownReset: [0, 1, 2] };
                }
                return { throws, target, made, cleared: true, overtime: false };
            }
            if (!r.hit) return { throws, target, made, cleared: false, lostRedemption: true };
        }
    }

    // Normal turn: pairs of 2, balls-back on a perfect pair.
    for (;;) {
        let pairMade = 0;
        let cleared = false;
        for (let b = 0; b < 2; b++) {
            const r = throwOne();
            if (r.cleared) { cleared = true; if (r.hit) pairMade++; break; }
            if (r.hit) pairMade++;
        }
        if (cleared) return { throws, target, made, cleared: true };
        if (pairMade === 2 && target.length > 0) continue; // balls back
        return { throws, target, made, cleared: false };
    }
}

// =============================================================================
// SECTION 6 - replay build / parse
// =============================================================================
// buildReplay: assemble the shared `replay` string in export_replay() order.
//   startRack1/2 = board at the start of Bot's turn (Bot's FIRST board).
//   throws       = [{traj, cup}] Bot's balls this turn.
//   endRack1/2   = board after Bot's turn (Bot's LAST board).
function buildReplay(o: BeerBuildReplay) {
    let s = 'board:' + rackToCsv(o.startRack1) + '&' + rackToCsv(o.startRack2);
    for (const th of o.throws) {
        s += '|move:' + th.traj + (th.cup != null ? String(th.cup) : '') + '&24';
    }
    s += '|board:' + rackToCsv(o.endRack1) + '&' + rackToCsv(o.endRack2);
    return s;
}

// parseReplay(str) -> { boards:[[r1,r2],...], moves:[{frames,cup,made,len}], ok }.
// Mirrors cuppong.gd's split-and-decode loop. ok=false on a malformed token so
// callers can fail safe (the watcher skips a card we don't understand).
function parseReplay(str: unknown) {
    if (typeof str !== 'string' || str.length === 0) {
        return { boards: [], moves: [], ok: true, empty: true };
    }
    const boards: number[][][] = [];
    const moves: BeerParsedMove[] = [];
    for (const elem of str.split('|')) {
        const c = elem.indexOf(':');
        if (c < 0) continue;
        const tag = elem.slice(0, c);
        const body = elem.slice(c + 1);
        if (tag === 'board') {
            const parts = body.split('&');
            if (parts.length < 2) return { boards, moves, ok: false };
            const r1 = csvToRack(parts[0]);
            const r2 = csvToRack(parts[1]);
            if ([...r1, ...r2].some((n) => n < 0 || n > 9)) return { boards, moves, ok: false };
            boards.push([r1, r2]);
        } else if (tag === 'move') {
            const mv = body.split('&')[0];
            const frames = [];
            for (let i = 0; i + 5 < mv.length; i += 6) frames.push(decodePoint(mv.slice(i, i + 6)));
            let cup: number | null = null;
            let made = 0;
            if (mv.length % 6 > 0) {
                cup = parseInt(mv[mv.length - 1], 10);
                if (!Number.isFinite(cup) || cup < 0 || cup > 9) return { boards, moves, ok: false };
                made = 1;
            }
            moves.push({ frames, cup, made, len: mv.length });
        }
    }
    return { boards, moves, ok: true };
}

// currentBoard(replayStr) -> { rack1, rack2 } from the LAST board:, or null.
function currentBoard(replayStr: unknown) {
    const p = parseReplay(replayStr);
    if (!p.ok || p.boards.length === 0) return null;
    const last = p.boards[p.boards.length - 1];
    return { rack1: last[0], rack2: last[1] };
}

type RetainedMissTrajectory = typeof missLong | typeof missRimBack;
export const beerEngine = {
    TOTAL_CUPS,
    CHARMAP,
    BALL_START,
    // codec
    conv,
    convback,
    encodePoint,
    decodePoint,
    // geometry
    cupWorld,
    randomCupPositions,
    // rack math
    rerack,
    removeCup,
    rackToCsv,
    csvToRack,
    // trajectory
    buildArc,
    encodeMade,
    encodeMiss,
    missShort,
    // turn
    simulateTurn,
    // replay
    buildReplay,
    parseReplay,
    currentBoard,
};

