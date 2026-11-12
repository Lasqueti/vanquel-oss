// games/pool-real-engine.ts
// =============================================================================
// games/pool-real-engine.ts - the FAITHFUL GamePigeon 8-Ball physics engine
// =============================================================================
//
// This is the REAL pool engine: OpenPigeon's transcription of GamePigeon's Box2D
// pool (PoolTable/PoolBall/PoolContactListener on the @gamepigeon box2d fork),
// compiled to WebAssembly (float32, phone-exact math) and loaded here as a thin,
// self-contained Node module. It supersedes the spin-blind 2D approximation in
// `pool-engine.ts` for the ONE job that must match the recipient's device: telling
// us the TRUE end-state of a shot (where every ball - including the cue - comes to
// rest, what got potted, and whether the cue scratched).
//
// WHY IT MATTERS (the trust model that makes pool tractable over iMessage):
//   * When Bot sends a pool card, the recipient's GamePigeon FORCES the object
//     balls to the POST block Bot encoded (rigged pocket radius) but RE-DERIVES
//     the cue position + scratch from the shot params (d, x, y, p, s). So the cue
//     and the scratch verdict are the ONLY things Bot cannot dictate - the device
//     recomputes them. Matching THIS engine (a faithful transcription of that same
//     Box2D) makes Bot's predicted cue + scratch match the device's, so a shot
//     that this engine says "pots ball 3, cue rests mid-table, no scratch" plays
//     back on the phone as exactly that.
//   * pool-play.ts therefore SIMULATES its chosen shot through this engine and
//     encodes the engine's own result as the POST => the encoded card is
//     self-consistent with what the device will animate.
//
// ------------------------------- ASSET LAYOUT --------------------------------
//   games/pool-real-engine.ts       (this loader)
//   GAMES_WASM_DIR/pool-glue.cjs    (Emscripten MODULARIZE glue, unmodified)
//   GAMES_WASM_DIR/pool.wasm        (the compiled engine; located by the glue via
//                                    __dirname, so it MUST sit beside the glue)
//
// NOT shipped in this repo. Built with emcc from OpenPigeon's pool C++ + a small
// driver + a box2d fork; see games/README.md, "Pool and Mini Golf".
//
// ------------------------------- LOAD MODEL ----------------------------------
// Emscripten instantiation is async (WebAssembly.instantiate returns a Promise
// even for a synchronously-read buffer), but the watcher's decideMove() is sync.
// So we PRE-WARM: load() is idempotent and fire-and-forget-able; pool-play.ts
// calls it at require time so the engine is ready long before any pool card is
// handled (and pool is gated OFF until armed anyway). simulateShot() is fully
// synchronous once ready() is true.
//
//   await poolRealEngine.load();
//   const { simulateShot, ready } = poolRealEngine;
//   const res = simulateShot(preBalls, { d, x, y, p, s }, { first });
//
//   preBalls : [{ n, x, y, rot?, density? }]  (WIRE order; cue is n=0)
//   shot     : { d (aim rad, y-down), x (spinX), y (spinY), p (wire power 0..2000),
//                s (suit int) }
//   opts     : { first?: bool }   (break flag; Bot never breaks, so always false)
//   returns  : { postBalls:[{n,x,y,rot}], potted:[{n,order,pocket}], scratch:bool,
//                cue:{x,y,potted}, firstHit:int|null, cueSunk:bool, frames:int }
// =============================================================================

import type { CreatePoolWasmModule, PoolWasmModule, PoolWasmBallRecord, RealBall, RealPostBall, Shot, SimulationResult } from './pool-types.ts';
import { wasmGlue } from './wasm-glue.ts';

// The Emscripten glue (MODULARIZE=1, EXPORT_NAME=createPoolModule). Locating
// pool.wasm relies on the glue's own __dirname, so both live in GAMES_WASM_DIR.
const createPoolModule: CreatePoolWasmModule = wasmGlue<PoolWasmModule>('pool');

let _mod: PoolWasmModule | null = null;      // the instantiated Emscripten module (null until loaded)
let _loading: Promise<PoolWasmModule> | null = null;  // the in-flight load promise (idempotent)

// ---------------------------------------------------------------------------
// load() - instantiate the WASM once. Idempotent: repeated calls return the same
// promise / the already-loaded module. Never rejects loudly on a second call.
// ---------------------------------------------------------------------------
async function load() {
    if (_mod) return { simulateShot, module: _mod };
    if (!_loading) {
        _loading = createPoolModule().then((m) => { _mod = m; return m; });
    }
    await _loading;
    return { simulateShot, module: _mod };
}

// ready() - true once the WASM is instantiated and simulateShot can run sync.
function ready() {
    return _mod != null;
}

// ---------------------------------------------------------------------------
// simulateShot(preBalls, shot, opts) - run ONE shot to rest. Synchronous; throws
// if the engine has not finished loading (call/await load() first). The marshalling
// mirrors the C ABI in wasm-driver.cpp exactly:
//   in  : n*5 float32  [number, x, y, rot, density]
//   out : n*8 float32  [number, x, y, rot, sunkOrder, numberHit, holeX, holeY]
// ---------------------------------------------------------------------------
function simulateShot(preBalls: RealBall[], shot: Shot, opts: { first?: boolean } = {}): SimulationResult {
    if (!_mod) {
        throw new Error('pool-real-engine not loaded: await poolRealEngine.load() first');
    }
    const M = _mod;
    const first = opts.first ? 1 : 0;
    const n = preBalls.length;

    const inBytes = n * 5 * 4;
    const outBytes = n * 8 * 4;
    const inPtr = M._malloc(inBytes);
    let outPtr: number | undefined;
    try {
        outPtr = M._malloc(outBytes);
        const inArr = new Float32Array(n * 5);
        for (let i = 0; i < n; i++) {
            const b = preBalls[i];
            inArr[i * 5 + 0] = b.n;
            inArr[i * 5 + 1] = b.x;
            inArr[i * 5 + 2] = b.y;
            inArr[i * 5 + 3] = (b.rot != null) ? b.rot : 0;
            inArr[i * 5 + 4] = (b.density != null) ? b.density : 1;
        }
        M.HEAPF32.set(inArr, inPtr >> 2);

        // simulateShot(preBalls, nBalls, dir, spinX, spinY, power, suit, first, out)
        const suit = (shot.s != null) ? (shot.s | 0) : 0;
        const frames = M._simulateShot(inPtr, n, shot.d, shot.x, shot.y, shot.p, suit, first, outPtr);

        const outArr = M.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + n * 8);

        const order = [];
        const byNumber = new Map<number, PoolWasmBallRecord>();
        for (let i = 0; i < n; i++) {
            const rec = {
                n:         Math.round(outArr[i * 8 + 0]),
                x:         outArr[i * 8 + 1],
                y:         outArr[i * 8 + 2],
                rot:       outArr[i * 8 + 3],
                sunkOrder: Math.round(outArr[i * 8 + 4]),
                numberHit: Math.round(outArr[i * 8 + 5]),
                holeX:     outArr[i * 8 + 6],
                holeY:     outArr[i * 8 + 7],
            };
            order.push(rec.n);
            byNumber.set(rec.n, rec);
        }

        // potted (sunkOrder != -1), sorted by sink order
        const potted = [];
        for (const rec of byNumber.values()) {
            if (rec.sunkOrder !== -1) {
                potted.push({ n: rec.n, order: rec.sunkOrder, pocket: { x: rec.holeX, y: rec.holeY } });
            }
        }
        potted.sort((a, b) => a.order - b.order);

        // POST block in wire order; potted balls dropped (exportBalls drops sunk).
        const postBalls: RealPostBall[] = [];
        const seen = new Set<number>();
        for (const num of order) {
            if (seen.has(num)) continue;
            seen.add(num);
            const rec = byNumber.get(num);
            if (!rec || rec.sunkOrder !== -1) continue;
            postBalls.push({ n: num, x: rec.x, y: rec.y, rot: rec.rot });
        }

        const cueRec = byNumber.get(0);
        const cueSunk = !cueRec || cueRec.sunkOrder !== -1;
        const firstHit = cueRec ? cueRec.numberHit : -1;
        let cue: SimulationResult['cue'];
        if (cueRec && cueRec.sunkOrder === -1) {
            cue = { x: cueRec.x, y: cueRec.y, potted: false };
        } else {
            cue = { x: null, y: null, potted: true };
        }

        // Base foul: cue potted OR cue hit nothing.
        const scratch = cueSunk || firstHit === -1;

        return {
            postBalls,
            potted,
            scratch,
            cue,
            firstHit: firstHit === -1 ? null : firstHit,
            cueSunk,
            frames,
        };
    } finally {
        M._free(inPtr);
        if (outPtr !== undefined) M._free(outPtr);
    }
}

export const poolRealEngine = { load, ready, simulateShot };

