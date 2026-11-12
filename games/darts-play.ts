// games/darts-play.ts
import type { PlayStateRead, PlayContextRead, PlayAdaptiveRead, DartsSolveRead, GameDecision } from './play-types.ts';
import { dartsEngine as engine } from './darts-engine.ts';
import { rubberBand as rb } from './rubber-band.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// Darts auto-play (game=darts) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'darts'
//   displayName : 'Darts'
//   solve(state, deps) -> parsed-turn context | null (null => skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// Darts is a countdown game. State lives in the `replay` field. AUTHORITATIVE wire
// grammar (from darts/darts.gd:send_replay + parse_replay + the on-device debug
// sample at darts.gd:103):
//   replay = "state:<p1>,<p2>|move:0,<x>,<y>,<pts>,<base>,<mult>|...|state:<p1'>,<p2'>"
//   - state: is BOTH players' REMAINING scores (pre-turn ... post-turn), NOT
//     "remaining,darts_left". Only two state: tokens matter: first=pre, last=post.
//   - move: FIRST field is a literal 0 (NOT the player). Then x,y (Godot board
//     coords), then <pts>=full points, <base>=sector value, <mult>=0 single /
//     2 double / 3 treble (bull=[25,25,0], double-bull=[50,25,2]).
//   Real sample: state:101,10|move:0,0.103483,0.142005,2,2,0|...|state:90,10
// `mode` = starting score, one of "101"/"201"/"301" (DartsGame.gameMode; NOT
// 101/301/501). Invite carries mode + style2=0 + avatar2, no replay.
//
// CORRECTNESS NOTE (darts.gd:play_replay): the receiver TRUSTS <pts> (move[3]) via
// dec_score(other_player, move[3]) and the post-`state:` scores for the SCOREBOARD.
// BUT the x,y are what the receiver ANIMATES the dart to (dart.throw), so a landing
// that doesn't fall in the region matching <pts> looks like a dart in the wood that
// still scored - exactly the bug the tester saw. The x,y are NOT "just cosmetic": they
// MUST land inside the wedge sector + ring band that yields (pts, mult). We place
// each dart at its region centre (+ a small in-region jitter) and RE-SCORE it with
// engine.scoreFromXY so the coordinate and the score can never disagree; the point
// totals + post-state (the scoreboard) are still computed exactly by darts-engine.
//
// ============================ VERIFICATION STATUS ============================
// Wire grammar built from OpenPigeon SOURCE (darts/DartsGame.kt + darts/darts.gd,
// `wordhunt` branch) and CONFIRMED against the tester's real captured cards (2026-07-07):
// the on-device darts.gd scoring functions (_hit_segment_from_world /
// _hit_multiplier_from_world / calc_shot_coordinates, board centre (0,0.344), radius
// 0.535) were ported to engine.scoreFromXY and reproduce every one of the tester's real
// singles exactly. The engine's landing geometry now scores 62/62 targets right and
// every emitted dart is re-scored before it ships. FAIL-SAFE: solve() returns null
// (=> skip) on a malformed card; decideMove skips if any coord/score check fails.
// Env-gated (GP_DARTS_SEND) until the tester's supervised live test.
// ============================================================================

const GAME_ID = 'darts';
const DISPLAY_NAME = 'Darts';
// DartsGame.kt config modes. Be lenient (accept any positive int for forward
// compat) but recognize the canonical three.
const VALID_START_SCORES = new Set([101, 201, 301]);

// Env gate (mirrors wordbites GP_WORDBITES_SEND). Staged 2026-07-07 for the tester's
// supervised live test.
const ENABLE_SEND = process.env.GP_DARTS_SEND === '1';

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
// parseReplay(replay) -> { preState, postState, moves, ok }
//   state:<p1>,<p2>  (both players' REMAINING scores). First = preState (before
//   the last turn), last = postState (after it). moves are the raw dart tuples.
// Mirrors darts.gd:parse_replay exactly: first state -> pre_state, second ->
// post_state; a move needs >=6 comma fields.
// -----------------------------------------------------------------------------
function parseReplay(replay: unknown) {
    if (typeof replay !== 'string' || replay.length === 0) {
        return { preState: null, postState: null, moves: [], ok: false };
    }
    let preState: number[] | null = null;
    let postState: number[] | null = null;
    const moves = [];
    for (const ev of replay.split('|')) {
        if (!ev) continue;
        if (ev.startsWith('state:')) {
            const rest = ev.slice('state:'.length).split(',');
            const p1 = Number(rest[0]);
            const p2 = rest.length > 1 ? Number(rest[1]) : NaN;
            if (!Number.isFinite(p1) || !Number.isFinite(p2)) {
                return { preState, postState, moves, ok: false };
            }
            if (preState == null) preState = [p1, p2];
            else postState = [p1, p2];
        } else if (ev.startsWith('move:')) {
            const parts = ev.slice('move:'.length).split(',');
            if (parts.length < 6) return { preState, postState, moves, ok: false };
            for (const v of parts) {
                if (!Number.isFinite(Number(v))) return { preState, postState, moves, ok: false };
            }
            moves.push(parts.map(Number));
        }
    }
    return { preState, postState, moves, ok: true };
}

// -----------------------------------------------------------------------------
// looksLikeDarts(state) - fail-safe field validation.
// -----------------------------------------------------------------------------
function looksLikeDarts(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    // mode should be a recognized starting score (be lenient: also accept any
    // positive integer, since variants exist - but reject junk).
    const mode: typeof VALID_START_SCORES extends Set<infer Score> ? Score : never = Number((state as PlayStateRead).mode);
    if (!Number.isFinite(mode) || mode <= 0) return false;
    // must have a parseable replay OR be a fresh invite (no replay yet)
    if ((state as PlayStateRead).replay != null && typeof (state as PlayStateRead).replay === 'string' && ((state as PlayStateRead).replay as string).length > 0) {
        if (!parseReplay((state as PlayStateRead).replay).ok) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// solve(state, deps) - parse the turn context. deps unused (no dictionary).
// Returns { p1, p2, startScore } (both players' REMAINING scores from the latest
// state) or null to skip. A fresh invite (no replay) starts both at `mode`
// (darts.gd:_set_game_data seeds p1_pre=p2_pre=mode when replay is empty).
// -----------------------------------------------------------------------------
function solve(state: unknown /*, deps */) {
    if (!looksLikeDarts(state)) return null;
    const startScore = Number((state as PlayStateRead).mode);
    let p1 = startScore;
    let p2 = startScore;
    if ((state as PlayStateRead).replay && typeof (state as PlayStateRead).replay === 'string' && ((state as PlayStateRead).replay as string).length > 0) {
        const parsed = parseReplay((state as PlayStateRead).replay);
        if (!parsed.ok) return null;
        const latest = parsed.postState || parsed.preState;
        if (latest) {
            p1 = latest[0];
            p2 = latest[1];
        }
    }
    if (!Number.isFinite(p1) || p1 < 0 || !Number.isFinite(p2) || p2 < 0) return null;
    return { p1, p2, startScore };
}

// -----------------------------------------------------------------------------
// factorToAggression(factor) - map the shared rubber-band factor onto a darts
// aim-quality knob in [0,1]. CONTINUOUS across the whole adaptive band
// [ADAPTIVE_MIN 0.60 .. ADAPTIVE_MAX 1.30] so easing actually REACHES genuinely-
// weak play instead of the old 4-step ladder that saturated at 0.3 (the bug that
// made Bot unbeatable: the adaptive floor 0.60 mapped to the SAME 0.3 as 0.79, so
// no number of Bot wins could ever weaken it, and 0.3 was still perfect accuracy).
//
// Anchors: factor 0.60 -> ~0.08 (very weak: low singles + heavy scatter, only easy
// finishes), 0.90 -> ~0.47, 1.00 -> ~0.61, 1.30 -> 0.87 (SKILL_CAP: strong human,
// ~13% scatter). Linear between; clamped to [0.05, fair.SKILL_CAP]. Self-tuner (updateAdaptive-
// State, shared) walks the factor up on a loss / down on a win, so darts converges
// on whatever aggression yields ~50% for this opponent.
// -----------------------------------------------------------------------------
function factorToAggression(factor: number) {
    const f = Number.isFinite(factor) ? factor : 0.9;
    const a = 0.08 + (f - 0.60) * (0.92 / 0.70); // 0.60->0.08, 1.30->1.00 (pre-cap)
    // Cap the strong end at fair.SKILL_CAP (0.87) so even a pinned max/sweat (factor
    // 1.30) plays a STRONG HUMAN, never a flawless robot: applyScatter's wildness is
    // 1 - aggression, so 0.87 => ~13% scatter (misses some checkouts/doubles). The
    // mid/low band is untouched - the cap only binds above factor ~1.20.
    return Math.max(0.05, Math.min(fair.SKILL_CAP, a));
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solveResult)
//   ctx = { botUuid, botAvatar, rbState }
// Returns { action:'ignore'|'result'|'play', ... }.
// -----------------------------------------------------------------------------
function decideMove(state: unknown, ctx: unknown, solveResult: unknown): GameDecision {
    if (!looksLikeDarts(state)) return { action: 'ignore' };
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
        return { action: 'result', winner: wUuid, flag, botWon };
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

    // Both players' remaining scores BEFORE Bot's turn (pre-state for the replay).
    const preP1 = (solveResult as DartsSolveRead).p1;
    const preP2 = (solveResult as DartsSolveRead).p2;
    const botRemaining = player === 1 ? preP1 : preP2;
    const oppRemaining = player === 1 ? preP2 : preP1;

    const factor = rb.handicapFactor(rbState);
    let aggression = factorToAggression(factor as number);
    // WITHIN-GAME catch-up: read the CURRENT race margin (both players' remaining) and
    // ease Bot's aggression when it is ahead / push when behind, so a runaway race
    // stays close. Honest - it only changes how hard Bot goes for the checkout, never
    // a faked score. Skipped when the user pinned a try-hard difficulty (sweat/max).
    const diff = rbState.difficulty;
    if (diff !== 'sweat' && diff !== 'max' && Number.isFinite(oppRemaining) && Number.isFinite(botRemaining)) {
        const lead = oppRemaining - botRemaining; // + => Bot ahead in the race (fewer left)
        const sig = fair.catchupSignal(lead, ((solveResult as DartsSolveRead).startScore || 101) * 0.5);
        aggression = fair.clamp(fair.applyCatchup(aggression, sig, { maxEase: 0.35, maxPush: 0.25 }), 0.05, 1.0);
    }
    const mode = (aggression >= 0.95 ? 'ramp-up:perfect-aim' : 'ease-up:soft-aim') +
        ' a=' + aggression.toFixed(2);

    // Plan Bot's turn (up to 3 darts) via the checkout calculator.
    //
    // DETERMINISM FIX (2026-07-08): the RNG seed must carry a per-GAME nonce, or two
    // games with the same score trajectory play byte-identically. Every fresh 101
    // starts (101,101), so without a nonce Bot's whole opening was identical game
    // after game ("plays exactly the same every time"). We fold the stable GamePigeon
    // session id (state.id, constant across a game's turns, unique per game) - plus
    // the player uuids + mode as a fallback - into a uint32 nonce. Combined with
    // botRemaining (per-turn) + oppRemaining (per-context) inside seedFrom, every
    // (game, turn) is unique yet DETERMINISTIC, so a re-processed inbound card still
    // reproduces the exact same move (round-trip stability the wire needs).
    const gameNonce = rb.hashSeed(
        (state as PlayStateRead).id || '',
        (state as PlayStateRead).player1 || '',
        (state as PlayStateRead).player2 || '',
        String((solveResult as DartsSolveRead).startScore || '')
    );
    const plan = engine.planTurn(botRemaining, 3, {
        aggression,
        seed: oppRemaining,
        gameId: gameNonce,
    });
    if (!plan.darts || plan.darts.length === 0) {
        // couldn't form any legal dart - fail safe.
        return { action: 'skip', reason: 'darts: no legal turn plan for remaining=' + botRemaining };
    }

    // Build the move tuples in the AUTHORITATIVE grammar:
    //   move:0,<x>,<y>,<pts>,<base>,<mult>   (first field literal 0, then the LANDING
    //   coordinate in the board frame (centre = (0, 0.344)), pts = full points the
    //   receiver dec_scores, base = sector value, mult = 0 single / 2 double / 3
    //   treble). darts-engine gives number(=base or 25) + mult + points; a bull is
    //   number 25 (base 25) with mult 0(=25)/2(=50).
    //
    // CORRECTNESS INVARIANT (the whole point of the 2026-07-07 fix): the (x,y) we
    // emit is placed INSIDE the exact region that yields (pts, mult) - correct wedge
    // sector AND correct ring band - via engine.wedgeCenterXY, with only a small
    // in-region polar jitter (radial <= 0.008, angular <= 5 deg) that provably can't
    // cross a boundary. We then RE-SCORE the coordinate with engine.scoreFromXY and,
    // if it ever disagrees with the intended score (it never should), fall back to
    // the exact region centre. So the visible dart and the awarded score are always
    // self-consistent and every dart lands on the board.
    let rem = botRemaining;
    const moveEvents = [];
    let dartIdx = 0;
    for (const d of plan.darts) {
        rem -= d.points;
        // wire mult: singles = 0 (dart_board.gd returns [25,25,0] for outer bull
        // and multiplier 0 for singles), doubles = 2, trebles = 3. The bull's
        // wedge-mult convention in darts-engine (1=25, 2=50) maps to wire base 25
        // with wire mult 0 (25) or 2 (50).
        let wireBase;
        let wireMult;
        if (d.number === 25) {
            wireBase = 25;
            wireMult = d.mult === 2 ? 2 : 0; // 50 -> [50,25,2]; 25 -> [25,25,0]
        } else {
            wireBase = d.number;
            wireMult = d.mult === 1 ? 0 : d.mult; // single -> 0, double -> 2, treble -> 3
        }
        // Deterministic in-region jitter in [-1, 1] per dart (so repeated same-wedge
        // darts don't perfectly overlap in the receiver's animation). Cosmetic; the
        // engine scales it to the fixed in-region caps so it never leaves the region.
        const jr = (((dartIdx * 7) % 5) - 2) / 2;  // -1, -0.5, 0, 0.5, 1
        const ja = (((dartIdx * 3) % 5) - 2) / 2;
        dartIdx++;
        let xy = engine.wedgeCenterXY(d.number, d.mult, { jr, ja });
        // Self-validating guard: re-score the coordinate the way GamePigeon will.
        // If the jittered point somehow doesn't reproduce the intended score, drop
        // the jitter and use the exact region centre (which is proven to round-trip).
        let check = engine.scoreFromXY(xy.x, xy.y);
        if (check.points !== d.points || check.wireMult !== wireMult) {
            xy = engine.wedgeCenterXY(d.number, d.mult);
            check = engine.scoreFromXY(xy.x, xy.y);
            if (check.points !== d.points || check.wireMult !== wireMult) {
                // Should be impossible (centres are verified 62/62). Fail safe rather
                // than emit a coordinate that disagrees with the score.
                return {
                    action: 'skip',
                    reason: 'darts: coord/score mismatch for ' + d.number + 'x' + d.mult +
                        ' -> (' + xy.x.toFixed(4) + ',' + xy.y.toFixed(4) + ') scored ' +
                        check.points + '/' + check.wireMult,
                };
            }
        }
        moveEvents.push(
            'move:0,' +
            xy.x.toFixed(6) + ',' + xy.y.toFixed(6) + ',' +
            d.points + ',' + wireBase + ',' + wireMult
        );
    }
    const dartsThrown = plan.darts.length;
    const botAfter = rem;

    // Post-turn state for BOTH players (opponent's remaining is unchanged this turn).
    const postP1 = player === 1 ? botAfter : oppRemaining;
    const postP2 = player === 2 ? botAfter : oppRemaining;

    // Fresh self-contained replay for THIS turn: pre-state | Bot's darts | post-state.
    // (darts.gd:send_replay rebuilds a 2-state replay per turn; it does NOT append
    // to the prior replay - updateSession overwrites the `replay` field.)
    const newReplay =
        'state:' + preP1 + ',' + preP2 + '|' +
        moveEvents.join('|') + '|' +
        'state:' + postP1 + ',' + postP2;

    const updates: PlayStateRead = {
        sender: (ctx as PlayContextRead).botUuid,
        ['player' + player]: (ctx as PlayContextRead).botUuid,
        ['avatar' + player]: (ctx as PlayContextRead).botAvatar,
        replay: newReplay,
    };
    // If Bot checked out (remaining hit exactly 0), Bot wins.
    let botWon = null;
    if (botAfter === 0) {
        updates.winner = (ctx as PlayContextRead).botUuid + '|1';
        botWon = true;
    }

    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };
    if (newState.player2 !== (ctx as PlayContextRead).botUuid && !newState.player1) newState.player1 = (ctx as PlayContextRead).botUuid;

    // INVITE -> GAMEPLAY rewrite. A darts invite (DartsGame.kt getNewGameData) has
    // start/caption/game_name + version=5 + style2, no replay. The on-device
    // gameplay generation (darts.gd:103 debug sample) drops start/caption/game_name
    // and stamps version=0. style1/style2 stay. NOTE: darts gameplay cards carry NO
    // inner caption (subtitle is UI-only), so we never set one.
    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        delete newState.start;      // invite-only
        delete newState.caption;    // "Let's play Darts!" - gameplay carries none
        delete newState.game_name;  // invite-only
        delete newState.player;     // invite-only bare slot claim
        newState.version = '0';     // gameplay generation (invite: 5)
        newState.num = '2';         // second card in the session (invite: 1)
        if (newState.style1 == null) newState.style1 = '0'; // gameplay sample carries both styles
        if (newState.style2 == null) newState.style2 = '0';
    } else {
        // Subsequent turn (not the invite): advance num so each card in the
        // session carries a fresh incrementing number, matching real GamePigeon,
        // and stamp player = the slot that just moved (Bot's), so the card is not
        // mislabelled with the opponent's stale slot inherited from the inbound card.
        newState.num = (state as PlayStateRead).num ? String(Number((state as PlayStateRead).num) + 1) : '2';
        newState.player = String(player);
    }

    const replySummary =
        'darts reply: slot=' + player + ' vs opp=' + opponent +
        ' mode=' + (solveResult as DartsSolveRead).startScore +
        ' preScore=' + botRemaining + '->' + botAfter +
        ' darts=' + dartsThrown +
        ' replay=' + newReplay +
        ' version=' + newState.version +
        (newState.winner ? ' winner=' + newState.winner : ' (your-move)');
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_DARTS_SEND!=1 | ' + replySummary,
        newState,
        botScore: botRemaining - botAfter, // points scored this turn
        botWords: dartsThrown,               // "darts thrown" (reused field for logs)
        mode,
        targetN: null,
        fullScore: botRemaining,             // remaining before the turn
        fullWords: botAfter,                 // remaining after the turn
        finishes: botAfter === 0,
        botWon,
        player,
        opponent,
    };
}

export const dartsPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    parseReplay,
    looksLikeDarts,
    factorToAggression,
};

