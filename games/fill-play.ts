// games/fill-play.ts
import type { ExtraContextRead, ExtraDecision, FillSolveRead } from './play-extra-types.ts';
import type { PlayStateRead, PlayAdaptiveRead } from './play-types.ts';
import { fillEngine as engine } from './fill-engine.ts';
import { rubberBand as rb } from './rubber-band.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// Filler auto-play (game=fill) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'fill'
//   displayName : 'Filler'
//   solve(state, deps) -> parsed board context | null (null => fail-safe skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// Filler is an OUTCOME-board logic game: each move is just a color pick, the
// recipient renders the boards carried on the wire directly, and every gameplay
// card carries the FULL board state on both sides of the turn's delta:
//   replay = "board:<56 pre cells>|move:<colorIndex>|board:<56 post cells>"
// so no cross-card accumulation is needed - the newest card IS the game.
//
// ============================ VERIFICATION STATUS ============================
// REFERENCE-ONLY. NO real Filler card has ever been captured on any line. The
// wire grammar below is derived from OpenPigeon's fill.gd (app/src/main/assets/fill/fill.gd), which
// interops with real GamePigeon clients:
//   - Board: 8 wide x 7 tall = 56 cells, flat ROW-MAJOR (flat = y*8 + x),
//     colors 0..5. (fill.gd parse_replay_string: `flat_i := y * BOARD_WIDTH + x`.)
//   - Slots: player1 owns corner (0,0) = flat 0; player2 owns corner (7,6) =
//     flat 55 (fill.gd _update_start_positions; the 180-degree rotation for
//     player 2 is display-only).
//   - replay: "board:<pre csv>|move:<c>|board:<post csv>" - exactly 3 '|' parts
//     (fill.gd _on_color_selection_made builds it; parse_replay_string requires
//     parts.size() == 3 and both board: prefixes).
//   - MOVE legality: c may equal NEITHER player's current corner color.
//   - Fresh invite: no replay; the board is regenerated from the wire `seed`
//     via GamePigeon's srand48/drand48 generator (ported byte-exact in
//     fill-engine.generateBoard - corner-triple re-rolls + 15 polish passes).
//   - winner = "<sender uuid>|<flag>", flag 1 = that uuid won / -1 = lost /
//     0 = draw (fill.gd builds `my_uuid + "|" + win_loss_state`; same convention
//     capture-confirmed on anagrams).
//   - Game over: unique colors <= 2 AND the two regions cover all 56 cells;
//     bigger region wins, 28-28 draws (fill.gd check_win).
//
// SEND IS OBSERVE-GATED (GP_FILL_SEND) and should STAY OFF until a real capture
// confirms, in order of importance:
//   1. A fill INVITE - confirms game=, seed presence, invite markers
//      (start/game_name/caption/version=5), and the inviter's slot (assumed
//      player2 like the confirmed dots invite).
//   2. That fill-engine.generateBoard(seed) reproduces the REAL invite board -
//      compare the first real opponent move card's `board:<pre>` against
//      generateBoard(seed). This is the single riskiest assumption: if the
//      seed->board port diverges, Bot's first reply would carry a wrong pre
//      board and desync the rendered game.
//   3. A MID-GAME card - confirms the replay grammar + cell order byte-for-byte.
// Until then this module decodes + plans + round-trips in dry-run only (every
// decision returns action:'skip' with a full summary in `reason`).
// ============================================================================
//
// FAIL-CLOSED VALIDATION (the dots-boxes lesson, applied):
//   - board csv must be EXACTLY 56 single digits 0..5; anything else rejects.
//   - move must be a single digit 0..5.
//   - SEMANTIC ORACLE: the card's post board must equal applyMove(pre, corner,
//     move) for a corner from which that move was LEGAL. A card whose pre/move/
//     post don't reproduce under our flood model means our model diverges from
//     the real game (or the card is hostile) - we skip rather than play on.
//   - TURN DISCIPLINE: the corner that produced the inbound card's move must be
//     the OPPONENT's corner; a card claiming a move from Bot's own corner (that
//     isn't Bot's echo) is inconsistent - skip.

const GAME_ID = 'fill';
const DISPLAY_NAME = 'Filler';

// Observe-gated until a real capture verifies the wire (see VERIFICATION STATUS).
const ENABLE_SEND = process.env.GP_FILL_SEND === '1';

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
// parseReplay(replay) -> { pre, move, post, moverCorner } | null (fail closed).
// moverCorner = the corner (flat 0 or 55) whose region actually produced
// post from pre with a LEGAL move - the semantic oracle described above.
// -----------------------------------------------------------------------------
function parseReplay(replay: unknown) {
    if (typeof replay !== 'string') return null;
    const parts = replay.split('|');
    if (parts.length !== 3) return null;
    if (!parts[0].startsWith('board:') || !parts[1].startsWith('move:') || !parts[2].startsWith('board:')) {
        return null;
    }
    const pre = engine.parseBoardCsv(parts[0].slice('board:'.length));
    const post = engine.parseBoardCsv(parts[2].slice('board:'.length));
    const moveStr = parts[1].slice('move:'.length);
    if (!pre || !post) return null;
    if (moveStr.length !== 1 || moveStr < '0' || moveStr > '5') return null;
    const move = Number(moveStr);

    let moverCorner = null;
    for (const corner of [engine.CORNER1, engine.CORNER2]) {
        const other = corner === engine.CORNER1 ? engine.CORNER2 : engine.CORNER1;
        if (move === pre[corner] || move === pre[other]) continue; // illegal from here
        if (engine.boardsEqual((engine.applyMove(pre, corner, move) as number[]), post)) {
            moverCorner = corner;
            break;
        }
    }
    if (moverCorner == null) return null;
    return { pre, move, post, moverCorner };
}

// -----------------------------------------------------------------------------
// parseSeed(seed) -> integer | null. GamePigeon seeds are decimal integer
// strings; anything else fails closed (a bare invite without a usable seed has
// no knowable board, so we must not guess one).
// -----------------------------------------------------------------------------
function parseSeed(seed: unknown) {
    if (seed == null) return null;
    const s = String(seed);
    if (!/^-?\d{1,19}$/.test(s)) return null;
    return s;
}

// -----------------------------------------------------------------------------
// boardFromState(state) -> { board, replayInfo } | null. The newest card is the
// whole game: a gameplay card's post board is the current position; a bare
// invite regenerates the board from the seed.
// -----------------------------------------------------------------------------
function boardFromState(state: unknown) {
    const replay = (state as PlayStateRead).replay;
    if (replay != null && replay !== '') {
        const info = parseReplay(replay);
        if (!info) return null;
        return { board: info.post, replayInfo: info };
    }
    const seed = parseSeed((state as PlayStateRead).seed);
    if (seed == null) return null;
    return { board: engine.generateBoard(seed), replayInfo: null };
}

// -----------------------------------------------------------------------------
// looksLikeFill(state) - fail-safe field validation.
// -----------------------------------------------------------------------------
function looksLikeFill(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    return boardFromState(state) != null;
}

// -----------------------------------------------------------------------------
// solve(state, deps) - parse the current board. deps unused. Returns
// { board, replayInfo, c1, c2, terminal } or null to skip.
// -----------------------------------------------------------------------------
function solve(state: unknown /*, deps */) {
    if (!looksLikeFill(state)) return null;
    const built = boardFromState(state);
    if (!built) return null;
    const { c1, c2 } = engine.counts(built.board);
    return {
        board: built.board,
        replayInfo: built.replayInfo,
        c1,
        c2,
        terminal: engine.isTerminal(built.board),
    };
}

// -----------------------------------------------------------------------------
// factorToStrength(factor) - map the shared rubber-band factor onto Filler
// strength via the CONTINUOUS fair-play skill curve. Two honest levers:
//   depth       - negamax plies (8 = sharp, 2 = short-sighted)
//   blunderProb - per-move chance to play a random legal NON-best color
// Filler rewards greedy play, so even depth 2 is coherent; the blunder knob is
// what genuinely loses cells to a human.
// -----------------------------------------------------------------------------
function factorToStrength(factor: number) {
    const skill = fair.factorToSkill((factor as number));
    const depth =
        skill >= 0.92 ? 8 :
        skill >= 0.75 ? 6 :
        skill >= 0.5 ? 4 :
        skill >= 0.3 ? 3 : 2;
    const blunderProb = fair.wildness(skill) * 0.85; // 0 at skill 1, ~0.78 at floor
    const label =
        (skill >= 0.9 ? 'ramp-up:deep' : skill >= 0.5 ? 'mid:solid' : 'ease-up:loose') +
        ' skill=' + skill.toFixed(2) + ' depth=' + depth + ' blunder=' + blunderProb.toFixed(2);
    return { skill, depth, blunderProb, label };
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solveResult)
//   ctx = { botUuid, botAvatar, rbState }
// Returns { action:'ignore'|'result'|'play'|'skip', ... }.
// -----------------------------------------------------------------------------
function decideMove(state: unknown, ctx: unknown, solveResult: unknown): ExtraDecision {
    if (!looksLikeFill(state)) return { action: 'ignore' };
    const rbState = (((ctx && (ctx as ExtraContextRead).rbState) || {}) as PlayAdaptiveRead);

    // Bot's slot if already established on the card (used by both the result
    // and play paths).
    const botSlotFromIds =
        (state as PlayStateRead).player1 === (ctx as ExtraContextRead).botUuid ? 1 :
        (state as PlayStateRead).player2 === (ctx as ExtraContextRead).botUuid ? 2 : null;

    // --- finished game (explicit winner field) -------------------------------
    if ((state as PlayStateRead).winner) {
        const parts = String((state as PlayStateRead).winner).split('|');
        const wUuid = parts[0];
        const flag = parts[1];
        let botWon;
        if (flag === '0') botWon = null;
        else {
            const senderWon = flag === '1';
            const senderIsBot = ((state as PlayStateRead).sender === (ctx as ExtraContextRead).botUuid);
            botWon = senderIsBot ? senderWon : !senderWon;
        }
        // Reconstruct final region counts so the rubber-band + log see real scores.
        let botScore = null;
        let oppScore = null;
        const built = boardFromState(state);
        if (built && botSlotFromIds) {
            const sc = engine.counts(built.board);
            botScore = botSlotFromIds === 1 ? sc.c1 : sc.c2;
            oppScore = botSlotFromIds === 1 ? sc.c2 : sc.c1;
        }
        return { action: 'result', winner: wUuid, flag, botWon, botScore, oppScore };
    }

    if (!solveResult) return { action: 'ignore' };

    // --- echo guard: Bot only sees inbound cards; a card whose sender is Bot
    // is an echo of Bot's own move.
    if ((state as PlayStateRead).sender && (state as PlayStateRead).sender === (ctx as ExtraContextRead).botUuid) {
        return { action: 'ignore' };
    }

    // --- Which slot is Bot? Priority:
    //   1. player1/player2 uuid match (authoritative once slots are claimed).
    //   2. The replay's mover corner: the sender just moved from that corner, so
    //      Bot owns the other one.
    //   3. The invite's `player` field = the inviter's slot; Bot takes the other
    //      (dots-confirmed convention: inviter is player2, recipient opens).
    //   4. Bare default: slot 1.
    const info = (solveResult as FillSolveRead).replayInfo;
    let player;
    if (botSlotFromIds) {
        player = botSlotFromIds;
    } else if (info) {
        player = info.moverCorner === engine.CORNER1 ? 2 : 1;
    } else if ((state as PlayStateRead).player === '1' || (state as PlayStateRead).player === '2') {
        player = (state as PlayStateRead).player === '1' ? 2 : 1;
    } else {
        player = 1;
    }
    const opponent = player === 1 ? 2 : 1;
    const myCorner = player === 1 ? engine.CORNER1 : engine.CORNER2;
    const oppCorner = player === 1 ? engine.CORNER2 : engine.CORNER1;

    // --- turn discipline: the inbound card's move must have come from the
    // OPPONENT's corner. A non-echo card claiming a move from Bot's corner is
    // corrupt/hostile - fail-safe skip, never build on it.
    if (info && botSlotFromIds && info.moverCorner === myCorner) {
        return { action: 'skip', reason: 'fill: inbound move came from Bot\'s own corner (inconsistent card)' };
    }

    const board = (solveResult as FillSolveRead).board;
    const myCount = engine.regionSize(board, myCorner);
    const oppCount = engine.regionSize(board, oppCorner);

    // --- board already terminal but no winner field: nothing to play. If we can
    // tell which side Bot is, record the result; otherwise ignore.
    if ((solveResult as FillSolveRead).terminal) {
        if (!botSlotFromIds) return { action: 'ignore' };
        const botWon = myCount > oppCount ? true : myCount < oppCount ? false : null;
        return {
            action: 'result',
            winner: null,
            flag: botWon === null ? '0' : botWon ? '1' : '-1',
            botWon,
            botScore: myCount,
            oppScore: oppCount,
        };
    }

    const factor = rb.handicapFactor(rbState);
    const strat = factorToStrength((factor as number));

    // Deterministic per-position RNG (no Math.random in the decision path):
    // seeded from the session id + exact board + slot, so the same card always
    // produces the same move, and different turns/games vary.
    const rng = fair.mulberry32(
        fair.hashSeed((state as PlayStateRead).id || 'fill', engine.boardToCsv(board), player));

    // WITHIN-GAME catch-up: blunder MORE when ahead on cells, less when behind,
    // so a mid-game lead does not run away. Honest - a blunder is a real weaker
    // color pick, never a faked board. Skipped when the user pinned a try-hard
    // difficulty.
    let blunderProb = strat.blunderProb;
    const diff = rbState.difficulty;
    if (diff !== 'sweat' && diff !== 'max') {
        const lead = myCount - oppCount; // + => Bot ahead
        const sig = fair.catchupSignal(lead, 10); // ~10-cell lead = full swing
        blunderProb = fair.clamp(strat.blunderProb + sig * 0.25, 0, 0.95);
    }
    // ENDGAME STALL GUARD: once the opponent's region is fenced off (no free
    // cell adjacent to it), regions are monotone so they can NEVER gain another
    // cell - the outcome is fixed except for Bot's own remaining captures.
    // Easing can no longer transfer anything to them, and negamax would prefer
    // flipping colors forever over capturing into a terminal loss. Switch to
    // straight greedy capture (finishGreedy) so the game honestly plays out
    // and actually ends.
    const oppFenced = !engine.regionCanGrow(board, oppCorner, myCorner);
    if (oppFenced) blunderProb = 0;

    const pick = engine.chooseMove(board, myCorner, oppCorner, {
        depth: strat.depth,
        blunderProb,
        rng,
        finishGreedy: oppFenced,
    });
    if (!pick) {
        return { action: 'skip', reason: 'fill: no legal color (should be impossible)' };
    }

    const newBoard = engine.applyMove(board, myCorner, pick.color);
    const newReplay =
        'board:' + engine.boardToCsv(board) +
        '|move:' + pick.color +
        '|board:' + engine.boardToCsv((newBoard as number[]));

    const myAfter = engine.regionSize((newBoard as number[]), myCorner);
    const oppAfter = engine.regionSize((newBoard as number[]), oppCorner);
    const finished = engine.isTerminal((newBoard as number[]));

    const updates: PlayStateRead = {
        sender: (ctx as ExtraContextRead).botUuid,
        ['player' + player]: (ctx as ExtraContextRead).botUuid,
        ['avatar' + player]: (ctx as ExtraContextRead).botAvatar,
        replay: newReplay,
    };
    let botWon = null;
    if (finished) {
        botWon = myAfter > oppAfter ? true : myAfter < oppAfter ? false : null;
        updates.winner =
            (ctx as ExtraContextRead).botUuid + '|' + (myAfter > oppAfter ? '1' : myAfter < oppAfter ? '-1' : '0');
    }

    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };
    if (newState.player2 !== (ctx as ExtraContextRead).botUuid && !newState.player1) newState.player1 = (ctx as ExtraContextRead).botUuid;

    // INVITE -> GAMEPLAY rewrite (the byte-proven darts/dots/connect pattern):
    // drop the invite-only markers, stamp version=0 / num=2, and do NOT stamp
    // `player` on the invite reply; later turns stamp player = the slot that
    // just moved and advance num. The seed stays on the card untouched.
    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        delete newState.start;      // invite-only
        delete newState.caption;    // "Let's play Filler!" - gameplay carries none
        delete newState.game_name;  // invite-only
        delete newState.player;     // invite-only bare slot claim
        newState.version = '0';     // gameplay generation (invite: 5)
        newState.num = '2';         // second card in the session (invite: 1)
    } else {
        newState.num = (state as PlayStateRead).num ? String(Number((state as PlayStateRead).num) + 1) : '2';
        newState.player = String(player);
    }

    const replaySummary =
        'fill reply: slot=' + player + ' vs opp=' + opponent +
        ' move=' + pick.color + (pick.color !== pick.bestColor ? ' (blunder, best=' + pick.bestColor + ')' : '') +
        ' cells=' + myCount + '->' + myAfter + ' vs ' + oppCount + '->' + oppAfter +
        ' tier=' + strat.label +
        ' version=' + newState.version +
        (newState.winner ? ' winner=' + newState.winner : ' (your-move)');
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND
            ? undefined
            : 'GP_FILL_SEND!=1 (reference-only wire - needs a real capture before arming) | ' + replaySummary,
        newState,
        botScore: myAfter,
        oppScore: oppAfter,
        botWords: pick.color,          // reuse for logs: the color Bot picked
        mode: strat.label,
        targetN: null,
        fullScore: myAfter,
        fullWords: engine.CELLS,
        finishes: finished,
        botWon,
        player,
        opponent,
    };
}

export const fillPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    looksLike: looksLikeFill,
    looksLikeFill,
    parseReplay,
    parseSeed,
    boardFromState,
    factorToStrength,
};

