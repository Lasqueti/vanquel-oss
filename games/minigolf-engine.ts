// games/minigolf-engine.ts
import type { Point2, GolfMap, GolfStroke, GolfWasm, GolfPlan, GolfFrontier, GolfSink, GolfReach, GolfOptions } from './engine-types.ts';
import { minigolfRealEngine as real } from './minigolf-real-engine.ts';
import { wasmGlue } from './wasm-glue.ts';
// =============================================================================
// GamePigeon Mini Golf ENGINE - faithful, WASM-backed (game=golf)
// =============================================================================
//
// This is a THIN adapter over games/minigolf-real-engine.ts (OpenPigeon's
// transcription of GamePigeon's Box2D mini golf - GolfTable / GolfBall /
// GolfContactListener on the @gamepigeon box2d fork + a faithful C++ port of
// GolfMapGenerator.kt - compiled to WebAssembly). The old hand-rolled JS physics
// + map generator DIVERGED from the device's re-sim (dead slopes, ignored
// diagonal banks, a swept-circle solver != Box2D 60/60+CCD), so shots Bot
// certified in its own sim missed on the recipient. This engine removes that gap:
// the map generator matches the device's drand48 consumption order exactly, and
// the physics IS the device's.
//
// TRUST MODEL: a golf card carries only seed + mode + the per-hole shot list
// (dist,rotation). The recipient REGENERATES the exact course from the seed and
// RE-SIMULATES every shot in Box2D; the score is the STROKE COUNT. Bot cannot
// dictate the ball's path - it can only choose shots whose re-sim on the device
// sinks the ball. So the planner (planHole) plans + CERTIFIES a sinking line in
// this same engine, and - crucially - only accepts shots that are ROBUST under
// small perturbation (the recipient's engine is OpenPigeon's approximation of
// GamePigeon; real human sinks are often knife-edge - 1/9 perturbation-robust -
// so Bot must pick the wide-basin shots that reliably reproduce).
//
// Public API is kept byte-compatible with what minigolf-play.ts consumes:
//   load() / ready()                              async prewarm + sync gate
//   normalizeMode / holeCountFor / dimensionsFor  pure
//   parseReplay / strokesToSegment / appendSegment / hasSegment   pure
//   createMap(seed, holeIndex, mode)              -> map (WASM-configured)
//   buildColliders(map)                           -> colliders (geometry for LOS)
//   simulateShot(map, colliders, x, y, dist, rot, opts) -> { pos, captured, sunk, frames }
//   planHole(map, slot, opts)                     -> { sunk, strokes:[{dist,rotation}] }
//   tryDirectPutt(map, colliders, pos, hole, cap) -> { sunk, dist, rotation } | null
//   clearLineOfSight(map, colliders, ax,ay,bx,by) -> bool
//   paramForRoll / rollDistanceForParam           power<->roll heuristic
//   certifyPlan(map, slot, strokes)               -> robustness 0..1 (end-to-end jitter)
//   coldReplay(map, slot, strokes)                -> recipient-faithful replay on the
//                                                    DEDICATED VERIFIER instance
//   refreshVerifier()                             -> fire-and-forget fresh verifier swap
// =============================================================================

const createGolfModule = wasmGlue<GolfWasm>('golf');

// ------------------------------- constants -----------------------------------
const TILE = 65;
const SEG_SEP = '|';
const BALL_SEP = '&';
const FIELD_SEP = ',';
const DEFAULT_MODE = '3';
const MODE_RACE = 'race';

const LAUNCH_MULT = 2.0;            // GolfShot: velocity(course) = dist * 2 * dir
const AIM_MAX_DIST = 300;
const BALL_RADIUS = 4.0;
const STEP_DT = 1 / 60;
const BALL_LINEAR_DAMPING = 1.0;
const STOP_LINEAR_SPEED = 1.0;
const MAX_FRAMES_PER_SHOT = 1200;

const HOLE_CAPTURE_RADIUS = 6.5;
const HOLE_SINK_RADIUS = 2.0;

const HALF_TILE = TILE * 0.5;       // 32.5 - blocked-cell + boundary half-extent

// --------------------------- verifier instance -------------------------------
// A SECOND, dedicated WASM instance used ONLY to replay wire strokes (regen +
// re-sim - exactly the recipient device's usage). WHY: the planner runs thousands
// of sims per turn on the main instance, and accumulated Box2D/WASM state after
// enough planning sims can make even a regen-fresh replay THERE diverge from a
// pristine process (observed 2026-07-09: a 4-stroke line reported "sunk" on the
// warm world but missed by 327px in a pristine process AND on the tester's device -
// the honesty gate passed a line that never holes out). The verifier never plans,
// so it stays in the validated pristine regime, and refreshVerifier() swaps in a
// brand-new instance after every emitted turn (fire-and-forget) so each turn's
// honesty gate starts from a truly cold module.
let _verifier: GolfWasm | null = null;
let _verifierLoading: Promise<GolfWasm> | null = null;
function loadVerifier() {
    if (_verifier) return Promise.resolve(_verifier);
    if (!_verifierLoading) {
        _verifierLoading = createGolfModule().then((m) => { _verifier = m; return m; });
    }
    return _verifierLoading;
}
let _refreshPending = false;
function refreshVerifier() {
    if (_refreshPending) return; // dedupe: back-to-back turns share one swap
    _refreshPending = true;
    createGolfModule()
        .then((m) => { _verifier = m; _refreshPending = false; })
        .catch(() => { _refreshPending = false; /* keep the current instance */ });
}

// ----------------------------- lifecycle -------------------------------------
// Prewarm at require time (fire-and-forget); decideMove is sync, so the play
// module gates on ready() and skips the (rare) card that lands before warm-up,
// exactly like pool-play.ts. Warm-up is a few hundred ms; games are turn-based.
real.load().catch(() => { /* first ensureHole re-checks */ });
loadVerifier().catch(() => { /* ready() stays false until the verifier lands */ });
function load() { return Promise.all([real.load(), loadVerifier()]); }
function ready() { try { return real.ready() && _verifier != null; } catch (_) { return false; } }

// ------------------------------ pure helpers ---------------------------------
function normalizeMode(mode: unknown) {
    const t = String(mode == null ? '' : mode).trim();
    if (t === '5') return '5';
    if (t === '3') return '3';
    if (t === MODE_RACE) return MODE_RACE;
    if (t === '') return DEFAULT_MODE;
    // "N Holes" subcaption fallback
    const m = t.match(/(\d+)/);
    if (m) { if (m[1] === '5') return '5'; if (m[1] === '3') return '3'; }
    return t;
}
function holeCountFor(mode: unknown) {
    if (mode === '5') return 5;
    if (mode === '3') return 3;
    const n = parseInt(mode as string, 10);
    return Number.isFinite(n) ? Math.max(1, n) : 3;
}
// dimensionsFor - GolfConstants.dimensionsFor (rows x cols), kept for callers.
function dimensionsFor(_mode: unknown, mapNum: number) {
    const hole = Math.max(0, mapNum);
    switch (hole) {
        case 0: return [6, 4];
        case 1: return [7, 5];
        case 2: return [7, 7];
        case 3: return [10, 6];
        default: return [9, 8];
    }
}

function parseReplay(replay: unknown) {
    if (!replay) return [];
    return String(replay).split(SEG_SEP).map((seg) =>
        seg.split(BALL_SEP).filter((e) => e.length > 0).map((e) => {
            const parts = e.split(FIELD_SEP);
            if (parts.length < 2) return null;
            const dist = parseFloat(parts[0]);
            const rot = parseFloat(parts[1]);
            if (!Number.isFinite(dist) || !Number.isFinite(rot)) return null;
            return { dist, rotation: rot };
        }).filter(Boolean));
}
function fmt6(n: unknown) { return Number(n).toFixed(6); }
function strokesToSegment(strokes: GolfStroke[]): unknown {
    return strokes.map((s) => fmt6(s.dist) + FIELD_SEP + fmt6(s.rotation)).join(BALL_SEP);
}
function appendSegment(replay: unknown, holeIndex: number, strokes: GolfStroke[]) {
    const segments = replay ? String(replay).split(SEG_SEP) : [];
    while (segments.length <= holeIndex) segments.push('');
    segments[holeIndex] = strokesToSegment(strokes) as string;
    while (segments.length && segments[segments.length - 1] === '') segments.pop();
    return segments.join(SEG_SEP);
}
function hasSegment(replay: unknown, holeIndex: number) {
    if (holeIndex < 0) return false;
    const segs = parseReplay(replay);
    return !!segs[holeIndex] && segs[holeIndex].length > 0;
}

// paramForRoll / rollDistanceForParam - a lightweight power<->roll model used only
// to seed the search with sensible power guesses (the actual outcome is always
// verified by the WASM simulateShot). Approximates a damped roll under
// LAUNCH_MULT; the search sweeps around these guesses.
function rollDistanceForParam(distParam: number) {
    let v = distParam * LAUNCH_MULT;
    let travel = 0;
    const damp = 1 / (1 + STEP_DT * BALL_LINEAR_DAMPING);
    for (let f = 0; f < MAX_FRAMES_PER_SHOT; f++) {
        v *= damp;
        travel += v * STEP_DT;
        if (v <= STOP_LINEAR_SPEED) break;
    }
    return travel;
}
function paramForRoll(targetDist: number) {
    let lo = 0, hi = AIM_MAX_DIST;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (rollDistanceForParam(mid) >= targetDist) hi = mid; else lo = mid;
    }
    return Math.min(AIM_MAX_DIST, hi);
}

// -------------------------------- map ----------------------------------------
// The WASM keeps ONE configured hole (its global GolfTable). createMap configures
// it and returns a JS view; ensureHole re-configures if a different hole became
// current between calls (only happens if callers interleave holes - planHole
// never does within a single hole).
let _loadedKey: string | null = null;
function keyOf(seed: number, mode: unknown, holeIndex: number) { return (seed | 0) + '|' + mode + '|' + Math.max(0, holeIndex); }

function createMap(seed: number, holeIndex: number, mode: unknown) {
    const nmode = normalizeMode(mode);
    const h = Math.max(0, holeIndex | 0);
    const wm = real.generateMap(seed | 0, h, nmode);
    _loadedKey = keyOf(seed, nmode, h);
    const tee = { x: wm.tee.x, y: wm.tee.y };
    return {
        seed: seed | 0, mode: nmode, holeIndex: h, mapNum: h, key: _loadedKey,
        rows: wm.rows, cols: wm.cols, tileSize: wm.tileSize, mapSize: wm.mapSize,
        grid: wm.grid, walls: wm.walls, banks: wm.banks,
        obstacles: wm.obstacles, slopes: wm.slopes,
        hole: { x: wm.hole.x, y: wm.hole.y },
        // both players share the tee (GolfMapGenerator: ball1 == ball2 non-race)
        ballStart1: tee, ballStart2: tee, tee,
    };
}
function ensureHole(map: GolfMap) {
    if (_loadedKey !== map.key) {
        real.generateMap(map.seed, map.holeIndex, map.mode);
        _loadedKey = map.key;
    }
}
function buildColliders(map: GolfMap) { return map; } // WASM owns physics; map carries LOS geometry

// world play-area bounds (matches createBoundaryWalls)
function boardBounds(map: GolfMap) {
    return {
        minX: -HALF_TILE, maxX: (map.cols - 1) * TILE + HALF_TILE,
        minY: -HALF_TILE, maxY: (map.rows - 1) * TILE + HALF_TILE,
    };
}
function offBoard(map: GolfMap, p: Point2) {
    const b = boardBounds(map);
    return p.x < b.minX - 2 || p.x > b.maxX + 2 || p.y < b.minY - 2 || p.y > b.maxY + 2;
}

// ------------------------------ shot sim -------------------------------------
function simulateShot(map: GolfMap, _colliders: unknown, startX: number, startY: number, dist: number, rotation: number, _opts?: unknown) {
    ensureHole(map);
    const d = Math.max(0, Math.min(AIM_MAX_DIST, dist));
    const r = real.simulateShot({ x: startX, y: startY }, d, rotation);
    return { pos: { x: r.restPos.x, y: r.restPos.y }, captured: r.captured, sunk: r.sunk, frames: r.frames };
}

// clearLineOfSight - approximate: sample the segment; blocked if a sample lands
// inside a blocked cell (65x65 box), a diagonal bank cell, or near an obstacle.
// A guiding heuristic only (all sinks are WASM-verified); conservative (may report
// blocked when marginally open), which just nudges the planner toward a lay-up.
function clearLineOfSight(map: GolfMap, _colliders: unknown, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-6;
    const steps = Math.ceil(len / (BALL_RADIUS * 1.5));
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = ax + dx * t, y = ay + dy * t;
        const col = Math.round(x / TILE), row = Math.round(y / TILE);
        if (row >= 0 && row < map.rows && col >= 0 && col < map.cols) {
            const v = map.grid[row][col];
            if (v === 1) {
                if (Math.abs(x - col * TILE) <= HALF_TILE && Math.abs(y - row * TILE) <= HALF_TILE) return false;
            } else if (v === 3) {
                // diagonal bank: block near the cell center band
                if (Math.abs(x - col * TILE) <= HALF_TILE * 0.8 && Math.abs(y - row * TILE) <= HALF_TILE * 0.8) return false;
            }
        }
        for (const o of map.obstacles) {
            const rr = obstacleRadius(o);
            if ((x - o.x) * (x - o.x) + (y - o.y) * (y - o.y) < rr * rr) return false;
        }
    }
    return true;
}
function obstacleRadius(o: { kind: number; scale?: number }) {
    // rough blocking radius by kind/scale (kinds per GolfNativePhysics.obstacleKind)
    const s = o.scale || 1;
    switch (o.kind) {
        case 1: case 5: return 34 * s;   // square2 / round2 (large)
        case 3: return 30 * s;           // bar2 (large)
        case 7: return 32 * s;           // triangle2 (large)
        case 8: return 26 * s;           // cross
        case 4: return 12 * s;           // round (small, bouncy)
        default: return 16 * s;          // square / bar / triangle (small)
    }
}

// =============================================================================
// PLANNER - robust, WASM-certified.
// Doctrine: prefer a direct, gentle, wide-basin putt that DIES into the cup;
// use lay-ups only to reach a close, clear-line position; certify the whole
// sequence under perturbation so the recipient's (approximate) re-sim matches.
// =============================================================================
const JITTER = [                     // (ddist, drot) probes for per-shot robustness
    [0, 0], [2.0, 0], [-2.0, 0], [0, 0.012], [0, -0.012],
    [2.0, 0.012], [-2.0, -0.012], [2.0, -0.012], [-2.0, 0.012],
];

function sim(from: Point2, dist: number, rot: number) {
    const d = Math.max(0, Math.min(AIM_MAX_DIST, dist));
    return real.simulateShot(from, d, rot);
}
// round6 - the card writes each shot as %.6f (strokesToSegment); certify + finalize
// against the ROUNDED params so a plan that sinks at full precision but not after
// 6-decimal rounding is caught here, not on the recipient's device.
function round6(v: number) { return Math.round(v * 1e6) / 1e6; }
function roundStrokes(strokes: GolfStroke[]) { return strokes.map((s) => ({ dist: round6(s.dist), rotation: round6(s.rotation) })); }
// nominalSinks - does this exact (rounded) stroke list hole out from the tee?
function nominalSinks(map: GolfMap, slot: number, strokes: GolfStroke[]) {
    const tee = slot === 2 ? map.ballStart2 : map.ballStart1;
    let pos = { x: tee.x, y: tee.y };
    for (const s of strokes) { const r = sim(pos, s.dist, s.rotation); if (r.sunk) return true; pos = { x: r.restPos.x, y: r.restPos.y }; }
    return false;
}
// finalizePlan - return wire-precision strokes guaranteed to hole out nominally.
// If 6-decimal rounding broke the sink, replay the rounded lead-in and re-solve the
// final shot from the exact rounded position (a wide-basin sink survives rounding).
function finalizePlan(map: GolfMap, slot: number, strokes: GolfStroke[]): unknown {
    const rounded = roundStrokes(strokes);
    if (nominalSinks(map, slot, rounded)) return rounded;
    const tee = slot === 2 ? map.ballStart2 : map.ballStart1;
    let pos = { x: tee.x, y: tee.y };
    for (let i = 0; i < rounded.length - 1; i++) {
        const r = sim(pos, rounded[i].dist, rounded[i].rotation);
        if (r.sunk) return rounded.slice(0, i + 1);
        pos = { x: r.restPos.x, y: r.restPos.y };
    }
    const s = findSink(map, pos);
    if (s) {
        const fixed = rounded.slice(0, Math.max(0, rounded.length - 1)).concat([{ dist: round6(s.dist), rotation: round6(s.rotation) }]);
        if (nominalSinks(map, slot, fixed)) return fixed;
    }
    return rounded; // best effort (should be unreachable)
}
function sinkRobustness(from: Point2, dist: number, rot: number) {
    let s = 0;
    for (const [dd, dr] of JITTER) { if (sim(from, dist + dd, rot + dr).sunk) s++; }
    return s / JITTER.length;
}
// cellKey - quantize a rest position to a half-tile grid cell for BFS dedup.
function cellKey(x: number, y: number) { return Math.round(x / (TILE * 0.5)) + '_' + Math.round(y / (TILE * 0.5)); }

// findSink - best single sinking shot from `from`, scored by robustness first,
// then directness, then gentleness (lower power = wider basin at the cup).
function findSink(map: GolfMap, from: Point2) {
    const cup = map.hole;
    const base = Math.atan2(cup.y - from.y, cup.x - from.x);
    const dCup = Math.hypot(cup.x - from.x, cup.y - from.y);

    const angOffs = [0];
    for (let a = 0.04; a <= 0.52; a += 0.04) { angOffs.push(a, -a); }
    for (const a of [0.8, 1.1, 1.5, 2.0, 2.6, Math.PI]) { angOffs.push(a, -a); }

    const powers = [];
    for (let f = 0.9; f <= 1.65; f += 0.09) powers.push(paramForRoll(dCup * f));
    powers.push(paramForRoll(dCup * 1.9), AIM_MAX_DIST);

    let best: GolfSink | null = null;
    for (const ao of angOffs) {
        const rot = base + ao;
        for (const dp of powers) {
            const d = Math.min(AIM_MAX_DIST, dp);
            const r = sim(from, d, rot);
            if (!r.sunk) continue;
            const rob = sinkRobustness(from, d, rot);
            const sc = rob * 1000 - Math.abs(ao) * 12 - d * 0.03;
            if (!best || sc > best.sc) best = { dist: d, rotation: rot, rob, frames: r.frames, sc, pos: cup };
        }
    }
    return best;
}

// tryDirectPutt - a direct, gentle sink aimed straight at the cup (kept for the
// play module's lay-up padding). Returns the most-robust direct putt, or null.
function tryDirectPutt(map: GolfMap, _colliders: unknown, pos: Point2, hole: Point2, _captured: unknown) {
    ensureHole(map);
    const base = Math.atan2(hole.y - pos.y, hole.x - pos.x);
    const dCup = Math.hypot(hole.x - pos.x, hole.y - pos.y);
    let best: GolfSink | null = null;
    for (let ao = -0.18; ao <= 0.181; ao += 0.03) {
        const rot = base + ao;
        for (let f = 0.95; f <= 1.5; f += 0.05) {
            const d = Math.min(AIM_MAX_DIST, paramForRoll(dCup * f));
            const r = sim(pos, d, rot);
            if (!r.sunk) continue;
            const rob = sinkRobustness(pos, d, rot);
            const sc = rob * 1000 - Math.abs(ao) * 12 - d * 0.03;
            if (!best || sc > best.sc) best = { sunk: true, dist: d, rotation: rot, rob, sc };
        }
    }
    return best;
}

// probeSink - a CHEAP robust-sink probe aimed at the cup (fewer samples than
// findSink); used to test every BFS frontier node. Returns the best sinking shot
// {dist, rotation, rob} or null. Prefers wide-basin (robust) sinks.
function probeSink(map: GolfMap, from: Point2) {
    const cup = map.hole;
    const base = Math.atan2(cup.y - from.y, cup.x - from.x);
    const dCup = Math.hypot(cup.x - from.x, cup.y - from.y);

    const angOffs = [0];
    for (let a = 0.06; a <= 0.48; a += 0.06) { angOffs.push(a, -a); }

    const powers = [];
    for (let f = 0.95; f <= 1.5; f += 0.11) powers.push(paramForRoll(dCup * f));
    powers.push(AIM_MAX_DIST);

    let best: GolfSink | null = null;
    for (const ao of angOffs) {
        const rot = base + ao;
        for (const dp of powers) {
            const d = Math.min(AIM_MAX_DIST, dp);
            const r = sim(from, d, rot);
            if (!r.sunk) continue;
            const rob = sinkRobustness(from, d, rot);
            const sc = rob * 1000 - Math.abs(ao) * 12 - d * 0.03;
            if (!best || sc > best.sc) best = { dist: d, rotation: rot, rob, sc };
        }
    }
    return best;
}

// reachableShots - a spread of shots from `from` (full 360, several powers) whose
// rests stay on the board; the BFS expansion operator. Also flags incidental sinks.
const REACH_ROLLS = [55, 130, 230, 350, 500];
const REACH_ANGLES = 24;
function reachableShots(map: GolfMap, from: Point2) {
    const out: GolfReach[] = [];
    for (let ai = 0; ai < REACH_ANGLES; ai++) {
        const rot = (ai / REACH_ANGLES) * 2 * Math.PI;
        for (const roll of REACH_ROLLS) {
            const d = Math.min(AIM_MAX_DIST, paramForRoll(roll));
            const r = sim(from, d, rot);
            if (r.sunk) { out.push({ dist: d, rotation: rot, pos: { x: r.restPos.x, y: r.restPos.y }, sunk: true }); continue; }
            if (offBoard(map, r.restPos)) continue;
            out.push({ dist: d, rotation: rot, pos: { x: r.restPos.x, y: r.restPos.y }, sunk: false });
        }
    }
    return out;
}

// certifyFrom - re-sim a stroke sequence from an ARBITRARY start under per-shot
// jitter and report the fraction that still holes out. certifyPlan is the tee-start
// case (byte-identical to the original). certifyFrom lets the play module's stroke-
// easing re-plan a robust FINISH from any resting ball position (the reproducible
// easing mechanism that replaced the fragile lay-up padder).
function certifyFrom(map: GolfMap, start: Point2, strokes: GolfStroke[]) {
    ensureHole(map);
    const M = 8;
    let sinks = 0;
    for (let m = 0; m < M; m++) {
        // deterministic small jitter pattern (spans the perturbation box)
        const jd = ((m % 3) - 1) * 1.6;
        const jr = (Math.floor(m / 3) - 1) * 0.010;
        let pos = { x: start.x, y: start.y };
        let sunk = false;
        for (let i = 0; i < strokes.length; i++) {
            const first = i === 0;
            const r = sim(pos, strokes[i].dist + (first ? jd : jd * 0.6), strokes[i].rotation + (first ? jr : jr * 0.6));
            pos = { x: r.restPos.x, y: r.restPos.y };
            if (r.sunk) { sunk = true; break; }
        }
        if (sunk) sinks++;
    }
    return sinks / M;
}
// certifyPlan - re-sim the whole sequence from the tee under per-shot jitter and
// report the fraction that still holes out. The recipient runs an approximation
// of this engine; a high certification == the sink reliably reproduces there.
function certifyPlan(map: GolfMap, slot: number, strokes: GolfStroke[]) {
    const tee = slot === 2 ? map.ballStart2 : map.ballStart1;
    return certifyFrom(map, tee, strokes);
}

// searchPlan - breadth-first reachability search that navigates mazes and returns
// the plan with the best END-TO-END robustness (certifyPlan re-sims the whole
// sequence from the tee under jitter - the quantity that decides whether the
// recipient's re-sim actually drops the ball). Each depth: (a) form a finishing
// candidate from every frontier node (findSink at the tee for a fuller sweep,
// probeSink deeper), CERTIFY it, keep the global best, early-return once a plan
// clears EARLY_STOP; (b) expand the frontier by firing a spread of shots and
// keeping the newly reached cells closest to the cup. Shortest plans compound
// least, so they tend to certify highest - this naturally prefers few strokes.
const FRONTIER_CAP = 8;
const SEARCH_MAX_DEPTH = 5;  // holes are par 2-4; deeper just compounds - cap it
const EARLY_STOP = 7 / 8;    // certify good enough to return immediately
const SETTLE_STOP = 6 / 8;   // a short, robust-enough plan - stop expanding deeper
function searchPlan(map: GolfMap, _slot: number, maxStrokes: number, startPos?: Point2): GolfPlan | null {
    const start = startPos ? { x: startPos.x, y: startPos.y } : { x: map.tee.x, y: map.tee.y };
    const cup = map.hole;
    const depthCap = Math.min(maxStrokes, SEARCH_MAX_DEPTH);
    let frontier: GolfFrontier[] = [{ pos: start, path: [] }];
    const visited = new Set([cellKey(start.x, start.y)]);
    let bestPlan: { strokes: GolfStroke[]; rob: number } | null = null; // { strokes, rob }

    const consider = (rawStrokes: GolfStroke[]) => {
        const strokes = roundStrokes(rawStrokes); // certify the exact wire-precision shots
        // certify from the ACTUAL start (tee for a full plan; ball rest for a re-plan).
        const rob = certifyFrom(map, start, strokes);
        if (!bestPlan || rob > bestPlan.rob ||
            (rob === bestPlan.rob && strokes.length < bestPlan.strokes.length)) {
            bestPlan = { strokes, rob };
        }
        return rob;
    };

    for (let depth = 1; depth <= depthCap; depth++) {
        for (const node of frontier) {
            const fin = depth === 1 ? findSink(map, node.pos) : probeSink(map, node.pos);
            if (!fin) continue;
            if (consider(node.path.concat([{ dist: fin.dist, rotation: fin.rotation }])) >= EARLY_STOP) {
                return { sunk: true, strokes: bestPlan!.strokes, robustness: bestPlan!.rob };
            }
        }
        // a decent short plan already in hand - deeper lines only compound worse.
        if (depth >= 2 && bestPlan && (bestPlan as { strokes: GolfStroke[]; rob: number }).rob >= SETTLE_STOP) break;
        if (depth === depthCap) break;

        const next: (GolfFrontier & { dcup: number })[] = [];
        for (const node of frontier) {
            for (const sh of reachableShots(map, node.pos)) {
                if (sh.sunk) { consider(node.path.concat([{ dist: sh.dist, rotation: sh.rotation }])); continue; }
                const ck = cellKey(sh.pos.x, sh.pos.y);
                if (visited.has(ck)) continue;
                visited.add(ck);
                next.push({ pos: sh.pos, path: node.path.concat([{ dist: sh.dist, rotation: sh.rotation }]),
                            dcup: Math.hypot(cup.x - sh.pos.x, cup.y - sh.pos.y) });
            }
        }
        if (next.length === 0) break;
        next.sort((a, b) => a.dcup - b.dcup);
        frontier = next.slice(0, FRONTIER_CAP);
    }

    return bestPlan ? { sunk: true, strokes: (bestPlan as { strokes: GolfStroke[]; rob: number }).strokes, robustness: (bestPlan as { strokes: GolfStroke[]; rob: number }).rob } : null;
}

// planHole - the entry point. Returns a certified sunk plan via the BFS search;
// a last-resort aim-at-cup shot (never malformed) only if the search finds nothing
// (should be unreachable - every generated hole has a tee->cup path).
function planHole(map: GolfMap, slot: number, opts?: GolfOptions) {
    ensureHole(map);
    const maxStrokes = (opts && opts.maxStrokes) || 8;
    const tee = { x: map.tee.x, y: map.tee.y };
    const cup = map.hole;

    const plan = searchPlan(map, slot, maxStrokes);
    if (plan && plan.sunk) {
        return { sunk: true, strokes: finalizePlan(map, slot, plan.strokes), robustness: plan.robustness };
    }

    const d = Math.min(AIM_MAX_DIST, paramForRoll(Math.hypot(cup.x - tee.x, cup.y - tee.y) + 6));
    const rot = Math.atan2(cup.y - tee.y, cup.x - tee.x);
    return { sunk: false, strokes: roundStrokes([{ dist: d, rotation: rot }]), robustness: 0 };
}

// coldReplay - the RECIPIENT-FAITHFUL replay, run on the DEDICATED VERIFIER WASM
// instance (see the verifier section up top). The recipient always regenerates the
// course from the seed and re-sims just the wire strokes; the verifier does exactly
// that and nothing else. The old version regen-replayed on the MAIN world under the
// doctrine that regen fully resets it - violated in practice: after enough planning
// sims the warm world reported a 4-stroke line "sunk" that a pristine process (and
// the device) missed by 327px (2026-07-09). A replay-only instance, refreshed after
// every emitted turn, cannot accumulate that state. Falls back to a main-world regen
// replay only during the pre-warm window before the verifier instance lands.
// Returns { sunk, sunkAt (index of the sinking stroke, -1 if none), rest }.
const V_MAP_FLOATS = 4096;   // mirror minigolf-real-engine's marshalling buffer sizes
const V_PATH_FLOATS = 8192;
function _vShot(M: GolfWasm, from: Point2, dist: number, rot: number) {
    const d = Math.max(0, Math.min(AIM_MAX_DIST, dist));
    const ptr = M._malloc(V_PATH_FLOATS * 4);
    try {
        const n = M._golfSimulateShot(from.x, from.y,
            d * LAUNCH_MULT * Math.cos(rot), d * LAUNCH_MULT * Math.sin(rot), ptr, V_PATH_FLOATS);
        if (n < 0) return null;
        const a = M.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + 5);
        return { rest: { x: a[1], y: a[2] }, sunk: Math.round(a[3]) === 1 };
    } finally { M._free(ptr); }
}
function coldReplay(map: GolfMap, slot: number, strokes: GolfStroke[] | undefined) {
    const tee = slot === 2 ? map.ballStart2 : map.ballStart1;
    let pos = { x: tee.x, y: tee.y };
    const list = strokes || [];
    const M = _verifier;
    if (M) {
        // configure the verifier's table: fresh regen, exactly as the recipient does
        const mp = M._malloc(V_MAP_FLOATS * 4);
        let ok = false;
        try {
            ok = M._golfGenerateMap(map.seed | 0, map.holeIndex | 0, map.mode === '5' ? 1 : 0, mp, V_MAP_FLOATS) >= 0;
        } finally { M._free(mp); }
        if (ok) {
            for (let i = 0; i < list.length; i++) {
                const r = _vShot(M, pos, list[i].dist, list[i].rotation);
                if (!r) break; // marshalling failure -> report the miss; the repair path handles it
                if (r.sunk) return { sunk: true, sunkAt: i, rest: r.rest };
                pos = r.rest;
            }
            return { sunk: false, sunkAt: -1, rest: pos };
        }
    }
    // pre-warm fallback: main-world regen replay (the pre-verifier behaviour)
    real.generateMap(map.seed, map.holeIndex, map.mode);
    _loadedKey = map.key;
    for (let i = 0; i < list.length; i++) {
        const d = Math.max(0, Math.min(AIM_MAX_DIST, list[i].dist));
        const r = real.simulateShot({ x: pos.x, y: pos.y }, d, list[i].rotation);
        if (r.sunk) return { sunk: true, sunkAt: i, rest: { x: r.restPos.x, y: r.restPos.y } };
        pos = { x: r.restPos.x, y: r.restPos.y };
    }
    return { sunk: false, sunkAt: -1, rest: pos };
}
// holesOutCold - boolean form of coldReplay (the honesty gate decideMove leans on).
function holesOutCold(map: GolfMap, slot: number, strokes: GolfStroke[] | undefined) {
    if (!strokes || !strokes.length) return false;
    return coldReplay(map, slot, strokes).sunk;
}

// planFromPos - a robust, WASM-certified FINISH from an arbitrary ball rest position
// (not just the tee). Same BFS as planHole but seeded at startPos and certified from
// there. This is the engine primitive the play module's stroke-easing leans on: after
// Bot deliberately takes a weak partial shot, it re-plans the rest of the hole from
// wherever the ball ACTUALLY stopped, so every finishing stroke is as reproducible as
// the optimal line and the ball genuinely holes out. Returns { sunk, strokes, robustness }.
function planFromPos(map: GolfMap, slot: number, startPos: Point2, maxStrokes?: number) {
    ensureHole(map);
    const mx = (maxStrokes && maxStrokes > 0) ? maxStrokes : 8;
    // FAST PATH: a WIDE-BASIN direct putt from here (the eased re-plan always calls
    // this from a ball rest that has been walked toward the cup, so a clear, robust
    // one-putt finish usually exists). It reproduces on the recipient as reliably as
    // a BFS finish but skips the thousands-of-sims maze search, keeping a live turn
    // fast. Only taken when the putt survives jitter (rob >= 0.78); otherwise we fall
    // through to the full BFS (walls in the way -> a bank/lay-up line is needed).
    const dp = tryDirectPutt(map, null, startPos, map.hole, false);
    if (dp && dp.rob >= 0.78) {
        return { sunk: true, strokes: roundStrokes([{ dist: dp.dist, rotation: dp.rotation }]), robustness: dp.rob };
    }
    const plan = searchPlan(map, slot, mx, startPos);
    if (plan && plan.sunk && plan.strokes && plan.strokes.length) {
        return { sunk: true, strokes: plan.strokes, robustness: plan.robustness };
    }
    // last resort: the best single sinking shot from here (rounded to wire precision).
    const s = findSink(map, startPos);
    if (s) return { sunk: true, strokes: roundStrokes([{ dist: s.dist, rotation: s.rotation }]), robustness: s.rob };
    return { sunk: false, strokes: [], robustness: 0 };
}

export const minigolfEngine = {
    load, ready, refreshVerifier,
    createMap, dimensionsFor, holeCountFor, normalizeMode,
    buildColliders, simulateShot,
    planHole, planFromPos, paramForRoll, rollDistanceForParam,
    clearLineOfSight, tryDirectPutt, certifyPlan, certifyFrom, finalizePlan,
    coldReplay, holesOutCold,
    parseReplay, strokesToSegment, appendSegment, hasSegment,
    TILE, SEG_SEP, BALL_SEP, FIELD_SEP, LAUNCH_MULT, AIM_MAX_DIST,
    HOLE_CAPTURE_RADIUS, HOLE_SINK_RADIUS,
};

