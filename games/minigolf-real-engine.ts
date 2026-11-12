// games/minigolf-real-engine.ts
import type { LocalGolfWasm, GolfStartView } from './target-engine-types.ts';
import { wasmGlue } from './wasm-glue.ts';
// =============================================================================
// games/minigolf-real-engine.ts - the FAITHFUL GamePigeon Mini Golf engine
// =============================================================================
//
// This is the REAL minigolf engine: OpenPigeon's transcription of GamePigeon's
// Box2D mini golf (GolfTable / GolfBall / GolfContactListener on the @gamepigeon
// box2d fork, the SAME fork the pool WASM uses), compiled to WebAssembly (float32,
// phone-exact math), PLUS a faithful C++ port of GolfMapGenerator.kt so the course
// itself (grid / diagonal banks / slopes / obstacles / tee / hole) is byte-identical
// to what the recipient's GamePigeon generates for a given seed.
//
// WHY IT MATTERS (the trust model that makes minigolf tractable over iMessage):
//   * A minigolf card carries only seed + mode + the list of shots (dist,rotation).
//     The recipient's GamePigeon REGENERATES the exact course from the seed and
//     RE-SIMULATES every shot in Box2D. The outcome (stroke count) is whatever the
//     recipient's re-sim produces. Bot cannot dictate the ball's path - it can only
//     choose shots whose re-sim on the device sinks the ball. So Bot must simulate
//     with the SAME map generator + SAME physics the device uses.
//   * Bot's old hand-rolled `minigolf-engine.ts` diverged (dead slopes, ignored
//     diagonal banks, a swept-circle solver ≠ Box2D 60/60 + CCD), so certified-in-
//     its-own-sim shots missed on the device. This engine removes that gap: the map
//     gen matches drand48 consumption order exactly, and the physics IS the device's.
//
// ------------------------------- ASSET LAYOUT --------------------------------
//   games/minigolf-real-engine.ts       (this loader)
//   GAMES_WASM_DIR/golf-glue.cjs        (Emscripten MODULARIZE glue, unmodified)
//   GAMES_WASM_DIR/golf.wasm            (compiled engine; located by the glue via
//                                        __dirname, so it MUST sit beside the glue)
//
// NOT shipped in this repo. Built with emcc from OpenPigeon's golf C++ + a
// small driver + a box2d fork; see games/README.md, "Pool and Mini Golf".
//
// ------------------------------- LOAD MODEL ----------------------------------
// Emscripten instantiation is async but the watcher's decideMove() is sync, so we
// PRE-WARM: load() is idempotent and fire-and-forget-able; minigolf-play.ts calls it
// at require time. generateMap()/simulateShot() are fully synchronous once ready().
//
//   await minigolfRealEngine.load();
//   const golf = minigolfRealEngine;
//   const map = golf.generateMap(seed, holeIdx, mode);      // mode: '3' | '5' | 3 | 5
//   const res = golf.simulateShot({ x: map.tee.x, y: map.tee.y }, dist, rotation);
//
//   generateMap -> { rows, cols, tileSize, mapSize, tee:{x,y}, hole:{x,y},
//                    grid:[[..]], walls:[{row,col}], banks:[{row,col}],
//                    obstacles:[{kind,x,y,rotation,scale,bouncy}],
//                    slopes:[{x,y,vx,vy,rotation}] }
//   simulateShot -> { path:[{x,y}..], restPos:{x,y}, sunk:bool, captured:bool, frames }
//
// simulateShot operates on the LAST course loaded by generateMap (the WASM keeps one
// configured GolfTable), so always call generateMap for the hole first.
//
// Launch mapping (GolfShot.kt): the on-wire value is `dist` in [0,300]; the launch
// velocity is dist * LAUNCH_MULT * (cos rot, sin rot). We apply LAUNCH_MULT here so
// callers pass the raw wire dist + rotation, exactly like the device's replay path.
// =============================================================================

const createGolfModule = wasmGlue('golf');

// GolfShot.LAUNCH_SPEED_MULTIPLIER - velocity(course) = dist * 2 * (cos,sin).
const LAUNCH_MULT = 2.0;

const MAP_BUF_FLOATS = 4096;   // header(10) + grid(≤72) + obstacles + slopes - ample
const PATH_BUF_FLOATS = 8192;  // header(5) + up to 1200 frames * 2

let _mod: unknown = null;
let _loading: Promise<unknown> | null = null;

// load() - instantiate the WASM once. Idempotent.
async function load() {
    if (_mod) return _mod;
    if (!_loading) {
        _loading = createGolfModule().then((m) => { _mod = m; return m; });
    }
    await _loading;
    return _mod;
}

// ready() - true once the WASM is instantiated and the sync API can run.
function ready() { return _mod != null; }

function _requireMod() {
    if (!_mod) {
        throw new Error('minigolf-real-engine not loaded: await minigolfRealEngine.load() first');
    }
    return _mod as LocalGolfWasm;
}

function _mode5(mode: unknown) {
    const s = String(mode == null ? '3' : mode).trim();
    return (s === '5') ? 1 : 0;
}

// generateMap(seed, holeIdx, mode) - regenerate the hole AND configure the WASM
// physics table for the subsequent simulateShot() calls.
function generateMap(seed: number, holeIdx: number, mode: unknown) {
    const M = _requireMod();
    const outPtr = M._malloc(MAP_BUF_FLOATS * 4);
    try {
        const n = M._golfGenerateMap(seed | 0, holeIdx | 0, _mode5(mode), outPtr, MAP_BUF_FLOATS);
        if (n < 0) throw new Error('golfGenerateMap overflow (increase MAP_BUF_FLOATS)');
        const a = M.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + n);
        const rows = Math.round(a[0]);
        const cols = Math.round(a[1]);
        const tileSize = a[2];
        const mapSize = a[3];
        const tee = { x: a[4], y: a[5] };
        const hole = { x: a[6], y: a[7] };
        const nObs = Math.round(a[8]);
        const nSlp = Math.round(a[9]);

        let k = 10;
        const grid = [];
        const walls = [];
        const banks = [];
        for (let r = 0; r < rows; r++) {
            const row = [];
            for (let c = 0; c < cols; c++) {
                const v = Math.round(a[k++]);
                row.push(v);
                if (v === 1) walls.push({ row: r, col: c });
                else if (v === 3) banks.push({ row: r, col: c });
            }
            grid.push(row);
        }
        const obstacles = [];
        for (let i = 0; i < nObs; i++) {
            obstacles.push({
                kind: Math.round(a[k++]),
                x: a[k++], y: a[k++],
                rotation: a[k++], scale: a[k++],
                bouncy: Math.round(a[k++]) === 1,
            });
        }
        const slopes = [];
        for (let i = 0; i < nSlp; i++) {
            slopes.push({ x: a[k++], y: a[k++], vx: a[k++], vy: a[k++], rotation: a[k++] });
        }
        return { rows, cols, tileSize, mapSize, tee, hole, grid, walls, banks, obstacles, slopes };
    } finally {
        M._free(outPtr);
    }
}

// simulateShot(ballState, power, angle) - re-sim one shot on the currently-loaded
// hole. `power` is the on-wire launch dist (0..300); we apply LAUNCH_MULT. `angle`
// is rotation in radians (y-DOWN screen coords). Returns the full path + rest + sunk.
function simulateShot(ballState: unknown, power: number, angle: number) {
    const M = _requireMod();
    const startX = (ballState && (ballState as GolfStartView).x != null) ? (ballState as GolfStartView).x : 0;
    const startY = (ballState && (ballState as GolfStartView).y != null) ? (ballState as GolfStartView).y : 0;
    const velX0 = power * LAUNCH_MULT * Math.cos(angle);
    const velY0 = power * LAUNCH_MULT * Math.sin(angle);

    const outPtr = M._malloc(PATH_BUF_FLOATS * 4);
    try {
        const n = M._golfSimulateShot(startX, startY, velX0, velY0, outPtr, PATH_BUF_FLOATS);
        if (n < 0) throw new Error('golfSimulateShot failed (map not configured?)');
        const a = M.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + n);
        const frames = Math.round(a[0]);
        const restPos = { x: a[1], y: a[2] };
        const sunk = Math.round(a[3]) === 1;
        const captured = Math.round(a[4]) === 1;
        const nPts = (n - 5) / 2;
        const path = [];
        for (let i = 0; i < nPts; i++) path.push({ x: a[5 + i * 2], y: a[5 + i * 2 + 1] });
        return { path, restPos, sunk, captured, frames };
    } finally {
        M._free(outPtr);
    }
}

export const minigolfRealEngine = { load, ready, generateMap, simulateShot, LAUNCH_MULT };

