// games/fill-engine.ts
import type { FillOptions, FillChild, FillChoice } from './engine-types.ts';
// =============================================================================
// Filler engine (game=fill) - board model + seed generator + negamax AI
// =============================================================================
//
// Pure logic, no I/O. Consumed by fill-play.ts (the wire/decision module).
//
// BOARD MODEL (ported from OpenPigeon fill.gd, app/src/main/assets/fill/fill.gd):
//   - 8 wide x 7 tall = 56 cells, 6 colors (0..5).
//   - Flat row-major order: flatIndex = y * 8 + x (y=0..6 rows, x=0..7 cols).
//     Confirmed against fill.gd parse_replay_string: `flat_i := y * BOARD_WIDTH + x`.
//   - Player slot 1 owns corner (x=0, y=0)  = flat index 0.
//     Player slot 2 owns corner (x=7, y=6)  = flat index 55.
//     Confirmed against fill.gd _update_start_positions(): player==2 =>
//     my corner = (BOARD_WIDTH-1, BOARD_HEIGHT-1), else (0,0). The 180-degree grid
//     rotation for player 2 is display-only and never touches the wire.
//   - A MOVE is picking a color c: every cell of your connected region (4-adjacent
//     component of your corner's color, containing your corner) becomes c; adjacent
//     components of color c merge in (they already have color c, so the post board
//     is exactly "old region recolored to c" - verified against fill.gd
//     _on_color_selection_made, whose `added` cells are already the picked color).
//   - LEGALITY: you may not pick your own current color OR the opponent's current
//     color (fill.gd line `if [left_color, right_color].has(selected)` blocks it).
//     6 colors minus at most 2 exclusions => always >= 4 legal moves.
//   - GAME OVER (fill.gd check_win): unique colors on board <= 2 AND
//     myRegion + oppRegion >= 56. Bigger region wins; 28-28 is a draw.
//
// SEED GENERATOR (generateBoard): byte-exact port of fill.gd
// generate_gamepigeon_board(), which is OpenPigeon's reverse of the REAL
// GamePigeon board-from-seed algorithm (they interop with real clients, so the
// stream must match). srand48/drand48 LCG (A=0x5DEECE66D, C=0xB, mod 2^48,
// state seeded ((seed & 0xFFFFFFFF) << 16) | 0x330E), 56 raw draws row-major,
// corner-triple distinctness re-rolls for BOTH corners, then 15 "polish"
// iterations that re-roll every >=2-cell monochrome cluster except the 6
// protected corner cells. Draw ORDER matters - the DFS in iterateCheck visits
// left, right, up, down exactly like fill.gd _filler_iterate_check, and re-rolls
// happen in component-discovery order, so the drand48 stream stays aligned.
// =============================================================================

const BOARD_WIDTH = 8;
const BOARD_HEIGHT = 7;
const CELLS = BOARD_WIDTH * BOARD_HEIGHT; // 56
const NUM_COLORS = 6;
const CORNER1 = 0;          // slot 1 corner (x=0, y=0)
const CORNER2 = CELLS - 1;  // slot 2 corner (x=7, y=6)

// Precomputed 4-neighbour adjacency (flat indices).
const NEIGHBORS = (() => {
    const out = [];
    for (let i = 0; i < CELLS; i++) {
        const x = i % BOARD_WIDTH;
        const y = (i - x) / BOARD_WIDTH;
        const n = [];
        if (x > 0) n.push(i - 1);
        if (x < BOARD_WIDTH - 1) n.push(i + 1);
        if (y > 0) n.push(i - BOARD_WIDTH);
        if (y < BOARD_HEIGHT - 1) n.push(i + BOARD_WIDTH);
        out.push(n);
    }
    return out;
})();

// -----------------------------------------------------------------------------
// drand48 - exact port of fill.gd's _filler_srand48/_filler_drand48 (which is
// glibc srand48/drand48). BigInt keeps the 48-bit multiply exact.
// -----------------------------------------------------------------------------
const DRAND48_A = 25214903917n; // 0x5DEECE66D
const DRAND48_C = 11n;          // 0xB
const DRAND48_MASK = (1n << 48n) - 1n;
const DRAND48_DENOM = 281474976710656; // 2^48

class FillerRand {
    declare state: bigint;
    constructor(seedVal: unknown) {
        // fill.gd: s32 = seed & 0xFFFFFFFF; state = ((s32 << 16) | 0x330E) & MASK
        const s32 = BigInt.asUintN(32, BigInt(seedVal as bigint));
        this.state = ((s32 << 16n) | 0x330En) & DRAND48_MASK;
    }
    drand() {
        this.state = (DRAND48_A * this.state + DRAND48_C) & DRAND48_MASK;
        return Number(this.state) / DRAND48_DENOM;
    }
    piece() {
        return Math.floor(this.drand() * NUM_COLORS);
    }
}

// -----------------------------------------------------------------------------
// generateBoard(seed) -> flat 56-array. Byte-exact port of fill.gd
// generate_gamepigeon_board(seed). Internally 2D b[i][j] (i=row/y, j=col/x) so
// the polish DFS order matches the reference exactly; flattened y*8+x at the end.
// -----------------------------------------------------------------------------
const POLISH_ITERATIONS = 15;

function iterateCheck(b: number[][], i: number, j: number, c: number, temp: number[][]) {
    if (i < 0 || i >= BOARD_HEIGHT || j < 0 || j >= BOARD_WIDTH) return;
    for (let k = 0; k < temp.length; k++) {
        if (temp[k][0] === i && temp[k][1] === j) return;
    }
    if (b[i][j] !== c) return;
    temp.push([i, j]);
    if (j >= 1) iterateCheck(b, i, j - 1, c, temp);
    if (j + 1 < BOARD_WIDTH) iterateCheck(b, i, j + 1, c, temp);
    if (i >= 1) iterateCheck(b, i - 1, j, c, temp);
    if (i + 1 < BOARD_HEIGHT) iterateCheck(b, i + 1, j, c, temp);
}

function generateBoard(seedVal: unknown) {
    const r = new FillerRand(seedVal);

    const b = [];
    for (let i = 0; i < BOARD_HEIGHT; i++) {
        const row = [];
        for (let j = 0; j < BOARD_WIDTH; j++) row.push(r.piece());
        b.push(row);
    }

    // Protected cells: the 3-cell L around each starting corner never gets
    // re-rolled by the polish pass.
    const pmask = [];
    for (let i = 0; i < BOARD_HEIGHT; i++) pmask.push(new Array(BOARD_WIDTH).fill(false));
    pmask[0][0] = true;
    pmask[1][0] = true;
    pmask[0][1] = true;
    pmask[BOARD_HEIGHT - 1][BOARD_WIDTH - 1] = true;
    pmask[BOARD_HEIGHT - 1][BOARD_WIDTH - 2] = true;
    pmask[BOARD_HEIGHT - 2][BOARD_WIDTH - 1] = true;

    // Re-roll each corner triple until its 3 colors are pairwise distinct.
    for (;;) {
        b[0][0] = r.piece();
        b[0][1] = r.piece();
        b[1][0] = r.piece();
        if (b[0][0] !== b[0][1] && b[0][0] !== b[1][0] && b[0][1] !== b[1][0]) break;
    }
    for (;;) {
        b[BOARD_HEIGHT - 1][BOARD_WIDTH - 1] = r.piece();
        b[BOARD_HEIGHT - 1][BOARD_WIDTH - 2] = r.piece();
        b[BOARD_HEIGHT - 2][BOARD_WIDTH - 1] = r.piece();
        const a2 = b[BOARD_HEIGHT - 1][BOARD_WIDTH - 1];
        const b2 = b[BOARD_HEIGHT - 1][BOARD_WIDTH - 2];
        const c2 = b[BOARD_HEIGHT - 2][BOARD_WIDTH - 1];
        if (a2 !== b2 && a2 !== c2 && b2 !== c2) break;
    }

    // Polish: break up monochrome clusters (>= 2 cells) outside the protected
    // corners. Sequential + in-place, exactly like the reference, so the drand48
    // consumption order (and therefore the board) matches real GamePigeon.
    for (let iter = 0; iter < POLISH_ITERATIONS; iter++) {
        for (let i = 0; i < BOARD_HEIGHT; i++) {
            for (let j = 0; j < BOARD_WIDTH; j++) {
                const temp: number[][] = [];
                iterateCheck(b, i, j, b[i][j], temp);
                if (temp.length >= 2) {
                    for (let k = 0; k < temp.length; k++) {
                        const pr = temp[k][0];
                        const pc = temp[k][1];
                        if (!pmask[pr][pc]) b[pr][pc] = r.piece();
                    }
                }
            }
        }
    }

    const flat: number[] = new Array(CELLS);
    for (let i = 0; i < BOARD_HEIGHT; i++) {
        for (let j = 0; j < BOARD_WIDTH; j++) flat[i * BOARD_WIDTH + j] = b[i][j];
    }
    return flat;
}

// -----------------------------------------------------------------------------
// Board serialization. FAIL CLOSED: exactly 56 comma-joined single digits 0..5.
// (fill.gd tolerates short/empty entries by defaulting to 0; we reject instead -
// a malformed board in an inbound card is corruption/hostile input.)
// -----------------------------------------------------------------------------
function parseBoardCsv(s: unknown) {
    if (typeof s !== 'string') return null;
    const parts = s.split(',');
    if (parts.length !== CELLS) return null;
    const out: number[] = new Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
        const v = parts[i];
        if (v.length !== 1 || v < '0' || v > '5') return null;
        out[i] = v.charCodeAt(0) - 48;
    }
    return out;
}

function boardToCsv(board: number[]): unknown {
    return board.join(',');
}

// -----------------------------------------------------------------------------
// Flood helpers (4-adjacency, iterative BFS - no recursion on the hot path).
// -----------------------------------------------------------------------------

// floodCells(board, start) -> flat indices of the connected component of
// board[start] containing start.
function floodCells(board: number[], start: number) {
    const color = board[start];
    const visited = new Uint8Array(CELLS);
    const stack = [start];
    const cells = [];
    visited[start] = 1;
    while (stack.length) {
        const i = stack.pop()!;
        cells.push(i);
        const nb = NEIGHBORS[i];
        for (let k = 0; k < nb.length; k++) {
            const n = nb[k];
            if (!visited[n] && board[n] === color) {
                visited[n] = 1;
                stack.push(n);
            }
        }
    }
    return cells;
}

function regionSize(board: number[], corner: number) {
    return floodCells(board, corner).length;
}

// applyMove(board, corner, color) -> new board with the mover's region recolored
// to `color`. Adjacent components of `color` merge implicitly (they already have
// that color). Does NOT validate legality - callers do.
function applyMove(board: number[], corner: number, color: number): unknown {
    const region = floodCells(board, corner);
    const out = board.slice();
    for (let k = 0; k < region.length; k++) out[region[k]] = color;
    return out;
}

// legalMoves(board, myCorner, oppCorner) -> colors 0..5 minus both players'
// current colors (fill.gd's forbidden-pick rule).
function legalMoves(board: number[], myCorner: number, oppCorner: number) {
    const mine = board[myCorner];
    const theirs = board[oppCorner];
    const out = [];
    for (let c = 0; c < NUM_COLORS; c++) {
        if (c !== mine && c !== theirs) out.push(c);
    }
    return out;
}

function counts(board: number[]) {
    return { c1: regionSize(board, CORNER1), c2: regionSize(board, CORNER2) };
}

function uniqueColorCount(board: number[]) {
    let mask = 0;
    for (let i = 0; i < CELLS; i++) mask |= 1 << board[i];
    let n = 0;
    while (mask) { n += mask & 1; mask >>= 1; }
    return n;
}

// isTerminal - fill.gd check_win: <= 2 unique colors AND the two regions cover
// the board.
function isTerminal(board: number[]) {
    if (uniqueColorCount(board) > 2) return false;
    const { c1, c2 } = counts(board);
    return c1 + c2 >= CELLS;
}

// regionCanGrow(board, corner, otherCorner) -> can `corner`'s region EVER gain
// another cell? Regions are monotone (you can never pick the enemy's current
// color, so owned cells are never lost), and a region only grows through FREE
// cells (owned by neither player) adjacent to it. If no free cell touches the
// region, it is fenced off for the rest of the game.
function regionCanGrow(board: number[], corner: number, otherCorner: number) {
    const mine = new Uint8Array(CELLS);
    const myCells = floodCells(board, corner);
    for (let k = 0; k < myCells.length; k++) mine[myCells[k]] = 1;
    const theirs = new Uint8Array(CELLS);
    const theirCells = floodCells(board, otherCorner);
    for (let k = 0; k < theirCells.length; k++) theirs[theirCells[k]] = 1;
    for (let i = 0; i < CELLS; i++) {
        if (mine[i] || theirs[i]) continue; // not a free cell
        const nb = NEIGHBORS[i];
        for (let k = 0; k < nb.length; k++) {
            if (mine[nb[k]]) return true;
        }
    }
    return false;
}

function boardsEqual(a: number[] | null | undefined, b: number[] | null | undefined) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// -----------------------------------------------------------------------------
// AI - negamax with alpha-beta. Branching factor is only 4, board ops are 56-cell
// floods, so depth 8 answers in well under a second. Eval = my region minus the
// opponent's; terminal positions get a decisive +-500 bonus so the search never
// trades a real win for cell count.
// -----------------------------------------------------------------------------
function negamax(board: number[], meCorner: number, themCorner: number, depth: number, alpha: number, beta: number) {
    const my = regionSize(board, meCorner);
    const op = regionSize(board, themCorner);
    if (my + op >= CELLS && uniqueColorCount(board) <= 2) {
        return my > op ? 500 + (my - op) : my < op ? -500 + (my - op) : 0;
    }
    if (depth <= 0) return my - op;
    const moves = legalMoves(board, meCorner, themCorner);
    // Order children by immediate gain (greedy) for better alpha-beta cuts;
    // color index is the deterministic tie-break.
    const children: FillChild[] = [];
    for (let k = 0; k < moves.length; k++) {
        const nb = applyMove(board, meCorner, moves[k]) as number[];
        children.push({ c: moves[k], nb, g: regionSize(nb, meCorner) });
    }
    children.sort((a, b) => (b.g - a.g) || (a.c - b.c));
    let best = -Infinity;
    for (let k = 0; k < children.length; k++) {
        const v = -negamax(children[k].nb, themCorner, meCorner, depth - 1, -beta, -alpha);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
    }
    return best;
}

// chooseMove(board, myCorner, oppCorner, opts) -> { color, value, gain, bestColor }
//   opts: { depth (plies incl. this move), blunderProb, rng, finishGreedy }
// Deterministic given the same board + opts + rng stream. A "blunder" is a REAL
// weaker move: a uniformly-random pick among the legal non-best moves (honest
// weakening - the engine never fakes a score, it genuinely plays worse).
//
// finishGreedy: for DECIDED endgames (opponent's region fenced off - see
// fill-play's stall guard). Negamax scores a terminal loss -500, so in a lost
// position it would otherwise prefer flipping colors FOREVER over capturing the
// last free cell (stalling a finished game). With finishGreedy the move is
// ranked by immediate capture gain first (value as tie-break) and never
// blunders: since the opponent can no longer gain, greedy capture IS the
// honest score-maximizing line, and it terminates the game.
function chooseMove(board: number[], myCorner: number, oppCorner: number, opts?: FillOptions) {
    const o = opts || {};
    const depth = Number.isFinite(o.depth) ? Math.max(1, o.depth!) : 6;
    const blunderProb = Number.isFinite(o.blunderProb) ? o.blunderProb! : 0;
    const rng = typeof o.rng === 'function' ? o.rng : () => 0.5;

    const moves = legalMoves(board, myCorner, oppCorner);
    if (!moves.length) return null; // unreachable: 6 colors, at most 2 excluded

    const myBefore = regionSize(board, myCorner);
    const scored: FillChoice[] = [];
    for (let k = 0; k < moves.length; k++) {
        const nb = applyMove(board, myCorner, moves[k]) as number[];
        const v = -negamax(nb, oppCorner, myCorner, depth - 1, -Infinity, Infinity);
        scored.push({ color: moves[k], v, gain: regionSize(nb, myCorner) - myBefore });
    }
    if (o.finishGreedy) {
        scored.sort((a, b) => (b.gain - a.gain) || (b.v - a.v) || (a.color - b.color));
        const g = scored[0];
        return { color: g.color, value: g.v, gain: g.gain, bestColor: g.color };
    }
    scored.sort((a, b) => (b.v - a.v) || (b.gain - a.gain) || (a.color - b.color));

    let pick = scored[0];
    if (blunderProb > 0 && scored.length > 1 && rng() < blunderProb) {
        const others = scored.slice(1);
        pick = others[Math.min(others.length - 1, Math.floor(rng() * others.length))];
    }
    return { color: pick.color, value: pick.v, gain: pick.gain, bestColor: scored[0].color };
}

export const fillEngine = {
    BOARD_WIDTH,
    BOARD_HEIGHT,
    CELLS,
    NUM_COLORS,
    CORNER1,
    CORNER2,
    NEIGHBORS,
    FillerRand,
    generateBoard,
    parseBoardCsv,
    boardToCsv,
    floodCells,
    regionSize,
    applyMove,
    legalMoves,
    counts,
    uniqueColorCount,
    isTerminal,
    regionCanGrow,
    boardsEqual,
    negamax,
    chooseMove,
};

