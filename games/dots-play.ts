// games/dots-play.ts
import type { PlayStateRead, PlayContextRead, PlayAdaptiveRead, DotsSolveRead, GameDecision } from './play-types.ts';
import type { DotsBoard, DotsOptions } from './target-engine-types.ts';
import { dotsEngine as engine } from './dots-engine.ts';
import { rubberBand as rb } from './rubber-band.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// Dots & Boxes auto-play (game=dots) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'dots'
//   displayName : 'Dots & Boxes'
//   solve(state, deps) -> parsed board context | null (null => fail-safe skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// Dots & Boxes is an OUTCOME-move logic game with a MULTI-MOVE turn: completing a
// box grants another move, so one Bot turn can draw several edges (each capture
// chains) before passing. The reply appends ALL of Bot's line:/square: events to
// the `replay`. Bot (the recipient) OPENS the game - see TURN ORDER below. Skill
// is rubber-banded via the shared fair-play helper so it converges on ~50%.
//
// ============================ VERIFICATION STATUS ============================
// INVITE - CONFIRMED from a real capture (a test line sms.db ROWID 105, decoded via
// gamepigeon-cipher.parseEnvelope). Fields: {game:'dots', game_name:'Dots & Boxes',
// version:'5', start:'', caption:"Let's play Dots & Boxes!", id:<16-char session>,
// player:'2', player2:<inviter uuid>, size:'4', num:'1', sender, tver:'5', ios,
// build, avatar2}. It is a BARE invite - NO player1, NO replay => empty board, the
// recipient is expected to make the first edge (this is the tester's "can't play first").
//
// COORD MODEL - CONFIRMED from a real gameplay capture (main-line chat.db rows
// 33184–33197, 2026-07-08, decoded via gamepigeon-cipher.parseEnvelope). GamePigeon's
// wire `size` = DOTS per side (D). A D-dot grid has DxD dots indexed [row,col] 0..D-1
// and (D-1)x(D-1) BOXES indexed 0..D-2. (the tester's live game: size=4 -> 4x4 dots ->
// 3x3 boxes; the capture never exceeds dot index 3.) `line:P,r1,c1,r2,c2` joins two
// adjacent dots:
//   horizontal = same row, |c1-c2|=1 (top edge of box row r, col min(c));
//   vertical   = same col, |r1-r2|=1 (left edge of box row min(r), col c).
// `square:P,r,c` = box (r,c) 0..D-2.
// The engine (dots-engine.ts) is BOX-indexed: dots-play converts boxSize = D-1 before
// calling in. Passing the raw wire D would invent a phantom ring of off-grid edges +
// boxes - the exact defect that let Bot draw a line above the top row of dots and
// claim an illegal extra move. See wireSizeToBoxSize() below.
//
// WIRE FORMAT - CONFIRMED. Every REAL GamePigeon gameplay card (the tester's, is_from_me=0)
// carries the FULL ACCUMULATED board on BOTH sides of that turn's delta:
//   replay = board:<BEFORE> | line:P,... [| line:... | square:...] | board:<AFTER>
//   board:<snapshot> = "board:" + "#"-joined entries, each entry "P,r1,c1,r2,c2" =
//     EVERY edge drawn so far by BOTH players (leading player digit, then the same 4
//     dot-coords as a line:). BEFORE = the cumulative board before this turn; AFTER =
//     that plus this turn's new edges. The `line:` section between the two `board:`
//     tokens is ONLY that turn's delta, NOT an accumulating log.
// This is byte-identical in shape to DARTS (state:pre|move|state:post) - the cumulative
// state lives in the snapshot token, the delta in the move token.
//
// THE BUG THIS FILE HAD (fixed 2026-07-08): it treated the `line:` list as the full
// game log and threw the `board:` snapshot away, so each reply carried only the last
// turn's 1–2 edges and NO cumulative board. On reload the single updating card had
// nothing to draw the full board from (moves vanished), and Bot's own parse saw an
// almost-empty board so it re-drew already-drawn edges and stalled. FIX: parse the
// authoritative `board:` snapshot; emit a COMPLETE board:BEFORE|delta|board:AFTER on
// every reply so the one card always renders the whole game and Bot plays to the end.
//
// FIRST REPLY (invite -> gameplay): confirmed on the wire that Bot's opening reply
// may carry a bare `line:` (no BEFORE board, board is empty) and a real device renders
// it; we still append a trailing board:<AFTER> so even the opening card carries a full
// snapshot. We follow the proven darts/connect4 pattern of DROPPING `player` on the
// invite reply and stamping it on later turns (matches the capture: Bot's num=2 card
// carried no player, later cards stamped player=mover-slot).
//
// WIN: board full = every edge drawn. For a D-dot wire grid (boxSize B = D-1) that is
// 2*B*(B+1) edges (24 for D=4/B=3) and B*B boxes (9 for D=4); majority of boxes wins.
// winner field = "<sender uuid>|<flag>", flag 1=that uuid won / -1=lost / 0=draw
// (format CONFIRMED from the anagrams capture winner="<uuid>|-1").
// ============================================================================

const GAME_ID = 'dots';
const DISPLAY_NAME = 'Dots & Boxes';
// Valid WIRE sizes = DOTS per side (GamePigeon offers 4/5/6-dot grids => 3/4/5 boxes).
const VALID_SIZES = new Set([4, 5, 6]);

// wireSizeToBoxSize(wireSize) -> boxes per side. GamePigeon's `size` counts DOTS; the
// engine is box-indexed and a D-dot grid has D-1 boxes per side. Every board this
// module builds goes through here, so the engine only ever sees the true box grid -
// which is what structurally forbids off-grid edges and phantom-box "completions".
function wireSizeToBoxSize(wireSize: unknown) {
    return Number(wireSize) - 1;
}

// Armed after the real gameplay capture confirmed the wire format (see VERIFICATION
// STATUS). GP_DOTS_SEND=1 turns live sending on.
const ENABLE_SEND = process.env.GP_DOTS_SEND === '1';

function getSubtitle(msg: unknown, _myUuid: unknown) {
    if (msg && (msg as PlayStateRead).winner) {
        const parts = String((msg as PlayStateRead).winner).split('|');
        const u = parts[0];
        const flag = parts[1];
        let iWon = ((msg as PlayStateRead).sender === u);
        if (flag === '-1') iWon = !iWon;
        if (flag === '0') return 'Draw!';
        return iWon ? 'I won!' : 'You Won!';
    }
    return 'Your Move.';
}

// -----------------------------------------------------------------------------
// wire <-> internal edge conversion (the capture-gated coordinate assumption).
//   wireLineToEdge('r1,c1,r2,c2') -> internal edge key "H:r,c" | "V:r,c" | null
//   edgeToWireLine(edge) -> [r1,c1,r2,c2] dot coords
// -----------------------------------------------------------------------------
function wireLineToEdge(coords: unknown) {
    const parts = String(coords).split(',').map(Number);
    if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [r1, c1, r2, c2] = parts;
    if (r1 === r2 && Math.abs(c1 - c2) === 1) {
        // horizontal edge: top edge of box row r1, col min(c1,c2)
        return 'H:' + r1 + ',' + Math.min(c1, c2);
    }
    if (c1 === c2 && Math.abs(r1 - r2) === 1) {
        // vertical edge: left edge of box col c1, row min(r1,r2)
        return 'V:' + Math.min(r1, r2) + ',' + c1;
    }
    return null;
}
function edgeToWireLine(edge: unknown): unknown[] {
    const [type, rc] = (edge as string).split(':');
    const [r, c] = rc.split(',').map(Number);
    if (type === 'H') return [r, c, r, c + 1];      // top edge dots (r,c)-(r,c+1)
    return [r, c, r + 1, c];                          // left edge dots (r,c)-(r+1,c)
}

// -----------------------------------------------------------------------------
// buildBoardFromReplay(replay, wireSize) -> { board, ok }. Reconstructs the CUMULATIVE
// board so the current position + every captured box are known. `wireSize` is the
// card's `size` field (DOTS per side); the board is built at boxSize = wireSize - 1
// so the engine grid matches what GamePigeon actually renders.
//
// A `board:<snapshot>` token is the AUTHORITATIVE cumulative state (every edge drawn
// by both players); it OVERRIDES anything reconstructed so far. So we replay the
// events in order, and whenever we hit a `board:` token we RESET the board to exactly
// that snapshot, then keep applying any later `line:` deltas. For a real card
// (board:BEFORE|line:delta|board:AFTER) the final board = AFTER (the true position).
// A legacy card that carries only `line:` events (no snapshot) still replays cleanly.
// `square:` events are derivable from the edges (drawEdge sets box owners) - tolerated
// and ignored. Snapshot entries are listed in chronological draw order, so rebuilding
// in that order credits each box to whoever drew its completing (chronologically last)
// edge, which is the correct owner.
//
// Every parsed edge is validated to be IN-BOUNDS for the box grid: an off-grid edge in
// an inbound card is corruption/hostile input, so we fail closed (ok:false) rather than
// build a bigger-than-real grid Bot would then play into.
// -----------------------------------------------------------------------------
function buildBoardFromReplay(replay: unknown, wireSize: unknown) {
    const boxSize = wireSizeToBoxSize(wireSize);
    let board = engine.newBoard(boxSize);
    if (replay == null || replay === '') return { board, ok: true };
    if (typeof replay !== 'string') return { board, ok: false };
    const applyEntry = (player: number, coords: unknown) => {
        const edge = wireLineToEdge(coords);
        if (!edge || (player !== 1 && player !== 2)) return false;
        if (!engine.edgeInBounds(edge, boxSize)) return false;
        engine.drawEdge(board, edge, player);
        return true;
    };
    for (const ev of replay.split('|')) {
        if (!ev) continue;
        if (ev.startsWith('board:')) {
            // Authoritative cumulative snapshot: reset and rebuild from it exactly.
            board = engine.newBoard(boxSize);
            const snap = ev.slice('board:'.length);
            if (snap.length) {
                for (const entry of snap.split('#')) {
                    if (!entry) continue;
                    const f = entry.split(',');
                    if (f.length === 5) {
                        if (!applyEntry(Number(f[0]), f.slice(1).join(','))) return { board, ok: false };
                    } else if (f.length === 3) {
                        // Late-game native snapshots append captured-square records
                        // as "P,r,c" after the edge records. Ownership is already
                        // derivable from the chronological edges; validate and
                        // preserve the explicit owner instead of rejecting the
                        // whole valid card (the row-478 one-turn-from-win stall).
                        const p = Number(f[0]), r = Number(f[1]), c = Number(f[2]);
                        if ((p !== 1 && p !== 2) || r < 0 || c < 0 || r >= boxSize || c >= boxSize) {
                            return { board, ok: false };
                        }
                        board.owner[r + ',' + c] = p;
                    } else {
                        return { board, ok: false };
                    }
                }
            }
        } else if (ev.startsWith('line:')) {
            const rest = ev.slice('line:'.length).split(',');
            if (!applyEntry(Number(rest[0]), rest.slice(1).join(','))) return { board, ok: false };
        } else if (ev.startsWith('square:')) {
            // derivable from the edges; tolerated and ignored.
            continue;
        }
    }
    return { board, ok: true };
}

// -----------------------------------------------------------------------------
// boardToWireEntries(board) -> ["P,r1,c1,r2,c2", ...] for every drawn edge, in the
// order they were drawn (Set insertion order = chronological). This is the payload
// of a `board:<snapshot>` token: the FULL accumulated board, each edge stamped with
// the player who drew it (board.edgeOwner) so it renders in that player's colour.
// -----------------------------------------------------------------------------
function boardToWireEntries(board: DotsBoard) {
    const entries = [];
    for (const edge of board.edges) {
        const p = board.edgeOwner[edge] != null ? board.edgeOwner[edge] : 0;
        const [r1, c1, r2, c2] = edgeToWireLine(edge);
        entries.push(p + ',' + r1 + ',' + c1 + ',' + r2 + ',' + c2);
    }
    // Native late-game board snapshots carry square ownership after the edges.
    // Including it keeps the single updating card's score/colours self-contained.
    for (const key of Object.keys(board.owner)) {
        const [r, c] = key.split(',').map(Number);
        entries.push(board.owner[key] + ',' + r + ',' + c);
    }
    return entries;
}

// -----------------------------------------------------------------------------
// looksLikeDots(state) - fail-safe field validation.
// -----------------------------------------------------------------------------
function looksLikeDots(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    const size = Number((state as PlayStateRead).size);
    if (!Number.isFinite(size) || !VALID_SIZES.has(size)) return false;
    if ((state as PlayStateRead).replay != null && typeof (state as PlayStateRead).replay === 'string' && ((state as PlayStateRead).replay as string).length > 0) {
        if (!buildBoardFromReplay((state as PlayStateRead).replay, size).ok) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// solve(state, deps) - build the board. deps unused. Returns { board, size,
// drawnEdges } or null to skip.
// -----------------------------------------------------------------------------
function solve(state: unknown /*, deps */) {
    if (!looksLikeDots(state)) return null;
    const size = Number((state as PlayStateRead).size);
    const built = buildBoardFromReplay((state as PlayStateRead).replay, size);
    if (!built.ok) return null;
    return { board: built.board, size, drawnEdges: built.board.edges.size };
}

// -----------------------------------------------------------------------------
// factorToStrength(factor) - map the shared rubber-band factor onto dots strategy
// via the CONTINUOUS fair-play skill curve (NOT a discrete ladder). Dots is a
// punishing endgame-parity game: a "smart" AI (take free boxes, never hand a box,
// open the smallest chain) beats a casual human almost every time, so a 4-band
// blunder ladder that tops out at ~30% error SATURATES - Bot stays near-unbeatable
// and never converges. fair.factorToSkill is continuous across the whole adaptive
// band, so easing genuinely reaches weak play:
//   factor 0.60 (floor) -> skill ~0.08 -> blunderProb ~0.83, greedy-only (loose)
//   factor 0.90 (neutral)-> skill ~0.47 -> blunderProb ~0.48
//   factor 1.30 (ceil)  -> skill 1.00  -> blunderProb 0, sharp chain control
// `blunderProb` is the per-edge chance Bot plays a RANDOM legal edge instead of
// the engine's best (a real weakening: it may skip a free box or open a chain).
// `doubleCross` (smarter min-chain sacrifice ranking) is only enabled in the strong
// band. The self-tuner walks the factor, so dots converges on ~50% for the opponent.
// -----------------------------------------------------------------------------
function factorToStrength(factor: number) {
    const skill = fair.factorToSkill(factor);
    const blunderProb = fair.wildness(skill) * 0.9; // 0 at skill 1, ~0.83 at floor
    const doubleCross = skill >= 0.5;
    const label =
        (skill >= 0.9 ? 'ramp-up:sharp' : skill >= 0.5 ? 'mid:solid' : 'ease-up:loose') +
        ' skill=' + skill.toFixed(2) + ' blunder=' + blunderProb.toFixed(2);
    return { skill, blunderProb, doubleCross, label };
}

// -----------------------------------------------------------------------------
// playTurn(board, player, opts) -> { events, capturedTotal, passes, finished }
// Plays Bot's FULL turn: keep drawing capturing edges (chaining) then draw ONE
// non-capturing edge to pass (unless the board finishes on a capture). Each edge
// draw appends a line: event (+ square: events for boxes it completed). The
// double-cross "leave 2" is applied when opening chains via the engine's pickEdge
// ordering; a fuller all-but-two handback can be layered later once verified.
// -----------------------------------------------------------------------------
function playTurn(board: DotsBoard, player: number, opts: DotsOptions) {
    const events = [];
    const maxDot = board.size; // boxSize = D-1; wire dot coords are valid in 0..maxDot
    let capturedTotal = 0;
    let passed = false;
    let guard = 0;
    while (guard++ < 500) {
        if (engine.isComplete(board)) break;
        const pick = engine.pickEdge(board, player, opts);
        if (!pick) break;
        // LEGALITY GUARDS (belt-and-suspenders on top of the box-grid enumeration):
        // never claim an off-grid edge, and never re-claim an already-drawn one.
        // Either would mean pickEdge is broken - end the turn rather than emit an
        // illegal line.
        if (!engine.edgeInBounds(pick.edge, board.size) || board.edges.has(pick.edge)) break;
        const [r1, c1, r2, c2] = edgeToWireLine(pick.edge);
        // The edge->dot mapping must render INSIDE the grid (0..maxDot on both axes).
        // If it ever fell outside, we would draw a line above/beside the dots - refuse.
        if ([r1, c1, r2, c2].some((n) => (n as number) < 0 || (n as number) > maxDot)) break;
        const completed = engine.drawEdge(board, pick.edge, player);
        events.push('line:' + player + ',' + r1 + ',' + c1 + ',' + r2 + ',' + c2);
        for (const [br, bc] of completed) {
            events.push('square:' + player + ',' + br + ',' + bc);
            capturedTotal++;
        }
        // TURN DISCIPLINE: `completed` is recomputed by drawEdge against the TRUE
        // accumulated board (a box counts only when all 4 of its sides are claimed).
        // Keep going ONLY while the just-claimed edge closed >=1 real box; a
        // non-capturing edge ends the turn (exactly one edge drawn, then pass). This
        // is what makes an illegal 2-edge no-capture turn impossible.
        if (completed.length === 0) {
            passed = true;
            break;
        }
        // captured a real box => Bot moves again (chain continues)
    }
    return { events, capturedTotal, passed, finished: engine.isComplete(board) };
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solveResult)
// -----------------------------------------------------------------------------
function decideMove(state: unknown, ctx: unknown, solveResult: unknown): GameDecision {
    if (!looksLikeDots(state)) return { action: 'ignore' };
    const rbState = (((ctx && (ctx as PlayContextRead).rbState) || {}) as PlayAdaptiveRead);

    // --- finished game -----------------------------------------------------
    if ((state as PlayStateRead).winner) {
        const parts = String((state as PlayStateRead).winner).split('|');
        const wUuid = parts[0];
        const flag = parts[1];
        let botWon;
        if (flag === '0') botWon = null;
        else {
            const senderWon = flag === '1';
            const senderIsBot = ((state as PlayStateRead).sender === (ctx as PlayContextRead).botUuid);
            botWon = senderIsBot ? senderWon : !senderWon;
        }
        // Reconstruct the final box counts from the replay so the rubber-band + log
        // see real scores (dots has no `score*` fields - box ownership is the score).
        let botScore = null;
        let oppScore = null;
        if (looksLikeDots(state)) {
            const built = buildBoardFromReplay((state as PlayStateRead).replay, Number((state as PlayStateRead).size));
            if (built.ok) {
                const sc = engine.scores(built.board);
                const botSlot =
                    (state as PlayStateRead).player1 === (ctx as PlayContextRead).botUuid ? 1 :
                    (state as PlayStateRead).player2 === (ctx as PlayContextRead).botUuid ? 2 : null;
                if (botSlot) {
                    botScore = sc[botSlot];
                    oppScore = sc[botSlot === 1 ? 2 : 1];
                }
            }
        }
        return { action: 'result', winner: wUuid, flag, botWon, botScore, oppScore };
    }

    if (!solveResult) return { action: 'ignore' };

    // --- Whose turn is it? MULTI-TURN game: after Bot plays once, its uuid stays
    // in a slot for the rest of the game, so slot-ownership can NOT tell whose turn
    // it is. The reliable signal is state.sender = who sent THIS card. Bot only
    // ever sees INBOUND cards (is_from_me=0); if the sender is Bot it is an ECHO
    // of Bot's own move -> ignore. Otherwise the opponent just moved and it is
    // Bot's turn again, even when Bot already owns a slot from a prior turn.
    if ((state as PlayStateRead).sender && (state as PlayStateRead).sender === (ctx as PlayContextRead).botUuid) {
        return { action: 'ignore' };
    }
    // Bot replies in the slot it already owns (subsequent turns); on the first
    // turn Bot takes the slot the opponent does NOT occupy (bare invite: the
    // inviter is player2, so Bot takes slot 1).
    let player;
    let opponent;
    if ((state as PlayStateRead).player1 === (ctx as PlayContextRead).botUuid) { player = 1; opponent = 2; }
    else if ((state as PlayStateRead).player2 === (ctx as PlayContextRead).botUuid) { player = 2; opponent = 1; }
    else if ((state as PlayStateRead).player1 && (state as PlayStateRead).player1 !== (ctx as PlayContextRead).botUuid) { opponent = 1; player = 2; }
    else if ((state as PlayStateRead).player2 && (state as PlayStateRead).player2 !== (ctx as PlayContextRead).botUuid) { opponent = 2; player = 1; }
    else { opponent = 2; player = 1; } // bare invite: inviter is player2

    const factor = rb.handicapFactor(rbState);
    const strat = factorToStrength(factor as number);

    // Deterministic per-position RNG (no Math.random in the decision path): seeded
    // from the session id + board fill + slot so the blunder/edge choices vary
    // turn-to-turn and game-to-game yet are fully reproducible + testable.
    const rng = fair.mulberry32(
        fair.hashSeed((state as PlayStateRead).id || 'dots', (solveResult as DotsSolveRead).size, (solveResult as DotsSolveRead).drawnEdges, player));

    const board = (solveResult as DotsSolveRead).board;

    // WITHIN-GAME catch-up: read the CURRENT box margin and blunder MORE when Bot is
    // ahead (genuinely hand chains/boxes back) / less when behind, so a mid-game lead
    // does not run away. Honest - a blunder is a real random legal edge, never a faked
    // score. Skipped when the user pinned a try-hard difficulty (sweat/max), and only
    // once boxes exist to compare.
    let blunderProb = strat.blunderProb;
    const diff = rbState.difficulty;
    if (diff !== 'sweat' && diff !== 'max') {
        const sc = engine.scores(board);
        if ((sc[1] || 0) + (sc[2] || 0) > 0) {
            const lead = (sc[player] || 0) - (sc[opponent] || 0); // + => Bot ahead
            const sig = fair.catchupSignal(lead, 3);              // ~3-box lead = full swing
            blunderProb = fair.clamp(strat.blunderProb + sig * 0.30, 0, 0.95);
        }
    }

    // Snapshot the FULL cumulative board BEFORE Bot's turn (every edge by both
    // players). playTurn mutates `board`, so capture this first.
    const beforeEntries = boardToWireEntries(board);
    const turn = playTurn(board, player, {
        doubleCross: strat.doubleCross,
        blunderProb,
        rng,
    });
    if (!turn.events.length) {
        return { action: 'skip', reason: 'dots: no legal edge (board full?)' };
    }
    // Snapshot the FULL cumulative board AFTER Bot's turn (before + Bot's new edges).
    const afterEntries = boardToWireEntries(board);

    // Emit the EXACT real-GamePigeon wire shape: board:<BEFORE> | <this turn's
    // line:/square: deltas> | board:<AFTER>. Both board: tokens carry the COMPLETE
    // accumulated board so the single updating card always renders the whole game on
    // reload, and Bot's next parse sees the full state. On the opening (empty board)
    // there is no BEFORE snapshot - a bare leading line: is what a real device emits
    // and renders - but we still append board:<AFTER> so even that card is complete.
    const replayParts = [];
    if (beforeEntries.length) replayParts.push('board:' + beforeEntries.join('#'));
    for (const ev of turn.events) replayParts.push(ev);
    replayParts.push('board:' + afterEntries.join('#'));
    const newReplay = replayParts.join('|');

    const finalScores = engine.scores(board);
    const botBoxes = finalScores[player];
    const oppBoxes = finalScores[opponent];

    const updates: PlayStateRead = {
        sender: (ctx as PlayContextRead).botUuid,
        ['player' + player]: (ctx as PlayContextRead).botUuid,
        ['avatar' + player]: (ctx as PlayContextRead).botAvatar,
        replay: newReplay,
    };
    let botWon = null;
    if (turn.finished) {
        botWon = botBoxes > oppBoxes ? true : botBoxes < oppBoxes ? false : null;
        updates.winner = (ctx as PlayContextRead).botUuid + '|' + (botBoxes > oppBoxes ? '1' : botBoxes < oppBoxes ? '-1' : '0');
    }

    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };
    if (newState.player2 !== (ctx as PlayContextRead).botUuid && !newState.player1) newState.player1 = (ctx as PlayContextRead).botUuid;

    // INVITE -> GAMEPLAY rewrite. The confirmed dots invite carries start/caption/
    // game_name + version=5 + player='2' (inviter's slot) and no replay. Bot's
    // reply is the game's FIRST move (Bot opens). We drop the invite-only markers
    // and stamp version=0 / num=2, matching the byte-proven darts + connect4 pattern
    // that renders on real devices. The real capture confirms Bot's first reply
    // (num=2) carried NO `player` field and rendered fine, and later gameplay cards
    // DO stamp player=mover-slot - so we drop `player` on the invite reply and stamp
    // it on every later turn (the else branch below).
    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        delete newState.start;      // invite-only
        delete newState.caption;    // "Let's play Dots & Boxes!" - gameplay carries none
        delete newState.game_name;  // invite-only
        delete newState.player;     // invite-only bare slot claim (see OPEN WIRE POINT)
        newState.version = '0';     // gameplay generation (invite: 5)
        newState.num = '2';         // second card in the session (invite: 1)
    } else {
        // Subsequent turn (not the invite): advance num so each card in the
        // session carries a fresh incrementing number, matching real GamePigeon,
        // and stamp player = the slot that just moved (Bot's), so the card is not
        // mislabelled with the opponent's stale slot inherited from the inbound card.
        newState.num = (state as PlayStateRead).num ? String(Number((state as PlayStateRead).num) + 1) : '2';
        newState.player = String(player);
    }

    const replaySummary =
        'dots reply: slot=' + player + ' vs opp=' + opponent +
        ' size=' + (solveResult as DotsSolveRead).size +
        ' drewEdges=' + turn.events.filter((e) => e.startsWith('line:')).length +
        ' captured=' + turn.capturedTotal +
        ' boxes=' + botBoxes + '/' + oppBoxes +
        ' tier=' + strat.label +
        ' events=' + turn.events.join('|') +
        ' version=' + newState.version +
        (newState.winner ? ' winner=' + newState.winner : ' (your-move)');
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_DOTS_SEND!=1 | ' + replaySummary,
        newState,
        botScore: botBoxes,
        oppScore: oppBoxes,
        botWords: turn.capturedTotal,
        mode: strat.label,
        targetN: null,
        fullScore: botBoxes,
        fullWords: oppBoxes,
        finishes: turn.finished,
        botWon,
        player,
        opponent,
    };
}

export const dotsPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    looksLikeDots,
    buildBoardFromReplay,
    boardToWireEntries,
    wireLineToEdge,
    edgeToWireLine,
    playTurn,
    factorToStrength,
};

