// games/dots-engine.ts
import type { DotsBoard, DotsOptions } from './target-engine-types.ts';
// =============================================================================
// Dots & Boxes engine (game=dots) - edge/box model + greedy+double-cross AI
// =============================================================================
//
// Pure logic, no I/O. Consumed by games/dots-play.ts.
//
// BOARD MODEL (from OpenPigeon dots/dots_boxes.gd + the multi-game plan):
//   `size` = BOXES per side (this engine is box-indexed). A size-N board has:
//     - (N+1) x N horizontal edges + N x (N+1) vertical edges
//     - N x N boxes
//   NOTE: GamePigeon's wire `size` is DOTS per side, not boxes - a D-dot grid has
//   D-1 boxes per side. dots-play.ts converts (boxes = dots - 1) before calling in,
//   so a wire size of 4/5/6 dots reaches this engine as N = 3/4/5 boxes.
//   State in `replay`: a |-joined move log of events:
//     - line:P,r1,c1,r2,c2  = player P drew an edge between dots (r1,c1)-(r2,c2)
//     - square:P,r,c        = player P captured box (r,c)
//     - board:...           = optional snapshots
//   The two dots of a `line` differ by exactly 1 in exactly one coordinate:
//     horizontal edge: same row, cols differ by 1  -> between box (r-1,c) & (r,c)
//     vertical edge:   same col, rows differ by 1  -> between box (r,c-1) & (r,c)
//
// TURN RULE: completing a box grants ANOTHER move. So one Bot "turn" may draw
// MULTIPLE edges (each capture chains) before passing. The reply appends all of
// Bot's line:/square: events for the whole chain, then stops when a non-capturing
// edge is drawn (turn passes) or the board is full (game over).
//
// AI TIERS (rubber-band via the shared factor -> tier):
//   greedy  : take any box-completing edge; else a "safe" edge (does not create a
//             3-sided box); else forced to open the smallest chain.
//   double-cross : greedy + when forced to open a chain, leave the last 2 boxes to
//             control parity (all-but-two / hard-hearted handback). Beats humans.
// This is a clean-room implementation of standard Dots & Boxes chain strategy, not
// a copy of any GPL source.
//
// ============================ VERIFICATION STATUS ============================
// The `line`/`square` tuple coordinate system is CORROBORATED: this engine uses a
// DOT-COORDINATE edge model (r,c in 0..N for dots) and a box-coordinate capture
// model (r,c in 0..N-1), and the OpenPigeon dots_boxes.gd `_get_dev_data` example
// (line:2,1,1,2,1 -> internal V:1,1 bordering boxes (1,0)&(1,1); square:2,1,0
// captures box (1,0)) round-trips exactly through wireLineToEdge + edgeBoxes +
// drawEdge (see dots-play.ts self-test). Still send-GATED (GP_DOTS_SEND off) until
// a real dots GAMEPLAY + FINISHED card confirms the two open wire points documented
// in dots-play.ts VERIFICATION STATUS (first-reply `player` field, `board:` snapshot).
// =============================================================================

// --- board construction ------------------------------------------------------
// Edges are keyed canonically as "H:r,c" (horizontal, top edge of box row r at
// col c; r in 0..N, c in 0..N-1) and "V:r,c" (vertical, left edge of box (r,c);
// r in 0..N-1, c in 0..N). This is an internal representation; the play module
// converts to/from the dot-coordinate `line:P,r1,c1,r2,c2` wire tuples.

function newBoard(size: number): DotsBoard {
    // edges     : Set of drawn edge keys, in INSERTION (chronological) order.
    // owner     : "r,c" box -> player who completed it.
    // edgeOwner : edge key -> player who DREW that edge. Needed so a full-board
    //             wire snapshot (board:P,r1,c1,r2,c2#...) can re-stamp every edge
    //             with the correct player digit (edges render per-player-colour).
    return { size, edges: new Set(), owner: {}, edgeOwner: {} };
}

// The 4 edges surrounding box (r,c).
function boxEdges(r: number, c: number) {
    return [
        'H:' + r + ',' + c,       // top
        'H:' + (r + 1) + ',' + c, // bottom
        'V:' + r + ',' + c,       // left
        'V:' + r + ',' + (c + 1), // right
    ];
}

function boxSideCount(board: DotsBoard, r: number, c: number) {
    let n = 0;
    for (const e of boxEdges(r, c)) if (board.edges.has(e)) n++;
    return n;
}

// All undrawn edges on the board.
function allEdges(size: number) {
    const edges = [];
    for (let r = 0; r <= size; r++) for (let c = 0; c < size; c++) edges.push('H:' + r + ',' + c);
    for (let r = 0; r < size; r++) for (let c = 0; c <= size; c++) edges.push('V:' + r + ',' + c);
    return edges;
}
function undrawnEdges(board: DotsBoard) {
    return allEdges(board.size).filter((e) => !board.edges.has(e));
}

// edgeInBounds(edge, size) - true iff `edge` is a real edge of a `size`-BOX grid.
// The exact bounds allEdges() enumerates: H:r,c has r in 0..size, c in 0..size-1;
// V:r,c has r in 0..size-1, c in 0..size. This is the structural gate the play
// module uses to make an off-grid edge (the "line above the top row of dots" bug)
// impossible to claim or encode. Anything malformed / off-grid returns false.
function edgeInBounds(edge: unknown, size: number) {
    const m = /^([HV]):(\d+),(\d+)$/.exec(String(edge));
    if (!m) return false;
    const r = Number(m[2]);
    const c = Number(m[3]);
    if (m[1] === 'H') return r >= 0 && r <= size && c >= 0 && c <= size - 1;
    return r >= 0 && r <= size - 1 && c >= 0 && c <= size;
}

// The 1 or 2 boxes an edge borders.
function edgeBoxes(edge: string, size: number) {
    const [type, rc] = edge.split(':');
    const [r, c] = rc.split(',').map(Number);
    const boxes: [number, number][] = [];
    if (type === 'H') {
        if (r - 1 >= 0) boxes.push([r - 1, c]);       // box above
        if (r < size) boxes.push([r, c]);             // box below
    } else {
        if (c - 1 >= 0) boxes.push([r, c - 1]);       // box left
        if (c < size) boxes.push([r, c]);             // box right
    }
    return boxes;
}

// Draw an edge for `player`; returns the list of boxes COMPLETED by it.
function drawEdge(board: DotsBoard, edge: string, player: number) {
    if (board.edges.has(edge)) return [];
    board.edges.add(edge);
    board.edgeOwner[edge] = player;
    const completed: [number, number][] = [];
    for (const [r, c] of edgeBoxes(edge, board.size)) {
        if (boxSideCount(board, r, c) === 4 && board.owner[r + ',' + c] == null) {
            board.owner[r + ',' + c] = player;
            completed.push([r, c]);
        }
    }
    return completed;
}

function isComplete(board: DotsBoard) {
    return undrawnEdges(board).length === 0;
}

function scores(board: DotsBoard) {
    const s: Record<number, number> = { 1: 0, 2: 0 };
    for (const k of Object.keys(board.owner)) s[board.owner[k]]++;
    return s;
}

// --- move classification -----------------------------------------------------
// A "safe" edge is one whose draw does NOT create a 3-sided box (i.e. does not hand
// the opponent a free capture next turn).
function edgeIsSafe(board: DotsBoard, edge: string) {
    for (const [r, c] of edgeBoxes(edge, board.size)) {
        if (boxSideCount(board, r, c) === 2) return false; // would become 3-sided
    }
    return true;
}
// An edge that immediately completes at least one box.
function edgeCompletes(board: DotsBoard, edge: string) {
    let n = 0;
    for (const [r, c] of edgeBoxes(edge, board.size)) {
        if (boxSideCount(board, r, c) === 3) n++;
    }
    return n;
}

// --- AI: pick ONE edge for `player` at the current board -> { edge, tier } ----
// Order: (1) any edge that completes a box; (2) any safe edge; (3) forced sacrifice
// - with double-cross, prefer opening the SMALLEST chain (fewest boxes given away).
function pickEdge(board: DotsBoard, _player: number, opts?: DotsOptions) {
    const options = opts || {};
    const doubleCross = options.doubleCross !== false; // default on
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const blunderProb = options.blunderProb != null ? options.blunderProb : 0;
    const undrawn = undrawnEdges(board);
    if (undrawn.length === 0) return null;

    // ease-up blunder: random legal edge
    if (blunderProb > 0 && rng() < blunderProb) {
        return { edge: undrawn[Math.floor(rng() * undrawn.length)], tier: 'blunder' };
    }

    // 1) capturing edge (take the free box)
    const capturing = undrawn.filter((e) => edgeCompletes(board, e) > 0);
    if (capturing.length) {
        // prefer the edge that completes the MOST boxes (double capture)
        capturing.sort((a, b) => edgeCompletes(board, b) - edgeCompletes(board, a));
        return { edge: capturing[0], tier: 'capture' };
    }

    // 2) safe edge (does not create a 3-sided box)
    const safe = undrawn.filter((e) => edgeIsSafe(board, e));
    if (safe.length) {
        return { edge: safe[Math.floor(rng() * safe.length)], tier: 'safe' };
    }

    // 3) forced to open a chain. Rank each sacrificing edge by how many boxes it
    //    gives the opponent (approx: the size of the chain it opens). Choose the
    //    one giving away the FEWEST. (double-cross itself is applied at capture
    //    time: when we later take a chain we leave 2, but that logic is handled by
    //    the play module deciding when to STOP capturing - see dots-play.)
    let best = undrawn[0];
    let bestCost = Infinity;
    for (const e of undrawn) {
        const cost = sacrificeCost(board, e);
        if (cost < bestCost) {
            bestCost = cost;
            best = e;
        }
    }
    return { edge: best, tier: doubleCross ? 'sacrifice:min-chain' : 'sacrifice' };
}

// Approximate the cost of opening with `edge`: draw it on a clone and count how
// many boxes the opponent could then chain-capture greedily.
function sacrificeCost(board: DotsBoard, edge: string) {
    const clone = cloneBoard(board);
    drawEdge(clone, edge, 0); // neutral owner marker for the probe
    let gained = 0;
    let guard = 0;
    while (guard++ < 200) {
        const cap = undrawnEdges(clone).find((e) => edgeCompletes(clone, e) > 0);
        if (!cap) break;
        const completed = drawEdge(clone, cap, 0);
        gained += completed.length;
    }
    return gained;
}

function cloneBoard(board: DotsBoard) {
    return {
        size: board.size,
        edges: new Set(board.edges),
        owner: { ...board.owner },
        edgeOwner: { ...board.edgeOwner },
    };
}

export const dotsEngine = {
    newBoard,
    boxEdges,
    boxSideCount,
    allEdges,
    undrawnEdges,
    edgeInBounds,
    edgeBoxes,
    drawEdge,
    isComplete,
    scores,
    edgeIsSafe,
    edgeCompletes,
    pickEdge,
    sacrificeCost,
    cloneBoard,
};

