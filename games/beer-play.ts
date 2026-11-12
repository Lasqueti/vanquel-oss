// games/beer-play.ts
import type { ExtraContextRead, ExtraDecision, BeerSolveRead } from './play-extra-types.ts';
import type { PlayStateRead, PlayAdaptiveRead } from './play-types.ts';
import { beerEngine as engine } from './beer-engine.ts';
import { rubberBand as rb } from './rubber-band.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// Cup Pong auto-play (game=beer) - NATIVE board:/move: gameplay, no I/O
// =============================================================================
//
// Cup Pong is a VOLLEY: the two players ALTERNATE throwing, each turn sinking a few
// of the opponent's cups, racing to clear all 10. Bot answers EVERY turn.
//
// THE FIX (native wire). Bot now emits the SAME shared `replay` string a genuine
// GamePigeon client emits - board:<rack1>&<rack2> snapshots + move:<flight><cup?>
// throw segments (see beer-engine.ts for the byte-proven format). The old approach
// shipped a per-slot `replay1` + a trusted `score1`; the tester's authentic client
// DISCARDS foreign per-slot logs, so his board reset to all-standing every turn and
// he never saw Bot's throws. With the native format his client PARSES Bot's
// board, TWEENS Bot's throw arc, REMOVES the cups Bot's digits name, and hands the
// turn back on the correctly-reduced rack - so cups persist, Bot's moves render,
// and the race actually progresses.
//
// WHOSE TURN - Bot's uuid stays in its slot for the WHOLE game, so slot ownership
// can't tell whose turn it is. Only the SENDER can: Bot ignores a card iff
// sender === botUuid (an echo of its own outbound card); every other card is
// The tester's throw to answer.
//
// BOARD IS THE SOURCE OF TRUTH. Bot reads the current rack from the LAST board: of
// the inbound `replay` (or a full 10&10 rack on a fresh invite), throws honestly at
// the opponent's rack (per-ball make chance = the shared fair-play skill, ~50%),
// removes the sunk cups (with the 6/3 re-rack), and re-emits start-board + its
// throws + end-board. score1/score2 are derived from the board so they always agree.
//
// WINNER. A real client only writes `winner` when it LOSES (`<uuid>|-1`, after a
// failed redemption). Clearing the opponent's rack is NOT a win - the opponent gets
// a redemption throw. So Bot hands back (no winner) when it clears, and only writes
// winner=bot|-1 if it loses its OWN redemption. Bot's WINS are recorded when
// The tester's client sends winner=<opponent>|-1 (the watcher's inbound 'result' path).
//
// FAIL-SAFE: solve() returns null on a malformed card (=> the watcher skips).
// Env-gated (GP_BEER_SEND) for the tester's supervised live test.
// =============================================================================

const GAME_ID = 'beer';
const DISPLAY_NAME = 'Cup Pong';

// Env gate (mirrors GP_DARTS_SEND / GP_POOL_SEND). Until '1', decideMove's play path
// returns action:'skip' (decode+solve+build still round-trip in dry-run, nothing is
// sent). The watcher also reads `enableSend` for its universal graceful-decline gate.
const ENABLE_SEND = process.env.GP_BEER_SEND === '1';

// Cup-pong skill anchors for fair.factorToSkill (see decideMove): adaptive floor
// (factor 0.60) -> 0.26 make chance per throw, ceiling (1.30) -> 0.98.
const BEER_SKILL_ANCHORS = { at0: 0.26, at1: 0.98 };
// Cup Pong awards balls-back after a perfect pair, so an 0.87 per-ball ceiling
// compounds into ~7 makes in one turn. 0.74 still plays hard (about 3 makes/turn)
// but visibly misses and remains beatable.
const BEER_HUMAN_CAP = 0.74;

function clamp(x: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, x));
}

// -----------------------------------------------------------------------------
// getSubtitle(msg) - winner flag relative to sender (universal GamePigeon
// convention). Duplicated (tiny) so this module has no cross-game import.
// -----------------------------------------------------------------------------
function getSubtitle(msg: unknown) {
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
// looksLikeBeer(state) - fail-safe field validation. game=beer + numeric seed +
// non-empty mode. A present shared `replay` must parse under the native board/move
// grammar (else the card is malformed / a wire we don't understand -> reject).
// -----------------------------------------------------------------------------
function looksLikeBeer(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    if (!Number.isFinite(Number((state as PlayStateRead).seed))) return false;
    if ((state as PlayStateRead).mode == null || String((state as PlayStateRead).mode).length === 0) return false;
    if ((state as PlayStateRead).replay != null && String((state as PlayStateRead).replay).length > 0) {
        if (!engine.parseReplay(String((state as PlayStateRead).replay)).ok) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// solve(state) - parse the current board (deps unused: no dictionary). Returns
// { seed, startBoard:{rack1,rack2} } or null to skip. A fresh invite (no replay)
// yields a full 10&10 rack.
// -----------------------------------------------------------------------------
function solve(state: unknown /*, deps */) {
    if (!looksLikeBeer(state)) return null;
    let startBoard = null;
    if ((state as PlayStateRead).replay != null && String((state as PlayStateRead).replay).length > 0) {
        startBoard = engine.currentBoard(String((state as PlayStateRead).replay));
    }
    if (!startBoard) {
        startBoard = {
            rack1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            rack2: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        };
    }
    return { seed: Number((state as PlayStateRead).seed), startBoard };
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solveResult)
//   ctx = { botUuid, botAvatar, rbState }
// Returns { action:'ignore'|'result'|'skip'|'play', ... }.
// -----------------------------------------------------------------------------
function decideMove(state: unknown, ctx: unknown, solveResult: unknown): ExtraDecision {
    if (!looksLikeBeer(state)) return { action: 'ignore' };
    const rbState = (((ctx && (ctx as ExtraContextRead).rbState) || {}) as PlayAdaptiveRead);

    // --- finished game: report result, watcher records W/L, sends nothing --------
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
        const b = engine.currentBoard(String((state as PlayStateRead).replay || '')) || { rack1: [], rack2: [] };
        const score1 = clamp(engine.TOTAL_CUPS - b.rack1.length, 0, engine.TOTAL_CUPS);
        const score2 = clamp(engine.TOTAL_CUPS - b.rack2.length, 0, engine.TOTAL_CUPS);
        let botScore = null;
        let oppScore = null;
        if ((state as PlayStateRead).player1 === (ctx as ExtraContextRead).botUuid) { botScore = score1; oppScore = score2; }
        else if ((state as PlayStateRead).player2 === (ctx as ExtraContextRead).botUuid) { botScore = score2; oppScore = score1; }
        else { oppScore = score2 || score1; }
        return { action: 'result', winner: wUuid, flag, botWon, botScore, oppScore };
    }

    if (!solveResult) return { action: 'ignore' };

    // --- echo of Bot's own outbound card -> ignore ---------------------------
    if ((state as PlayStateRead).sender && (state as PlayStateRead).sender === (ctx as ExtraContextRead).botUuid) {
        return { action: 'ignore' };
    }

    // --- whose slot is Bot's? On a bare invite the inviter is player2, so Bot
    // takes slot 1. (Same derivation as darts/archery.) ------------------------
    let player;
    let opponent;
    if ((state as PlayStateRead).player1 === (ctx as ExtraContextRead).botUuid) { player = 1; opponent = 2; }
    else if ((state as PlayStateRead).player2 === (ctx as ExtraContextRead).botUuid) { player = 2; opponent = 1; }
    else if ((state as PlayStateRead).player1 && (state as PlayStateRead).player1 !== (ctx as ExtraContextRead).botUuid) { opponent = 1; player = 2; }
    else if ((state as PlayStateRead).player2 && (state as PlayStateRead).player2 !== (ctx as ExtraContextRead).botUuid) { opponent = 2; player = 1; }
    else { opponent = 2; player = 1; } // bare invite: inviter is player2

    const mode = String((state as PlayStateRead).mode);
    const seed = (solveResult as BeerSolveRead).seed;
    const startBoard = (solveResult as BeerSolveRead).startBoard;

    // rack1 = player-2's cups (player 1 throws at); rack2 = player-1's cups. Bot
    // throws at the OPPONENT's rack and owns the other one.
    const targetRack = (player === 1) ? startBoard.rack1 : startBoard.rack2;
    const ownRack = (player === 1) ? startBoard.rack2 : startBoard.rack1;

    // Random-mode cup positions (only used for mode "h" trajectory aiming).
    const randomPositions = (mode === 'h') ? engine.randomCupPositions(seed) : null;

    // --- fair-play skill: per-ball make chance, shared adaptive map (~50%). ----
    // Cup-pong-calibrated anchors: the darts default (at0=0.08) is far too weak
    // here - the tester's measured make rate is ~53%/throw, and at the default curve an
    // eased Bot (factor ~0.77 -> 0.31/throw) missed ALL FOUR throws in ~1 of 4
    // games. These anchors keep the adaptive floor genuinely weak (0.26/throw),
    // the ceiling near-perfect (0.98), and map today's eased band to a human
    // ~0.42-0.48 so an all-miss game is rare (<10%).
    const factor = rb.handicapFactor(rbState);
    const baseSkill = fair.factorToSkill((factor as number), BEER_SKILL_ANCHORS);
    // Within-game catch-up (same helper darts/golf use, deterministic): ease when
    // Bot is ahead on cups, push when behind, so single games stay close.
    const lead = ownRack.length - targetRack.length; // >0 => Bot ahead in the race
    const skill = fair.clamp(
        fair.applyCatchup(baseSkill, fair.catchupSignal(lead, 5), { maxEase: 0.35, maxPush: 0.30 }),
        0.05, BEER_HUMAN_CAP
    );

    // Deterministic per-turn RNG so re-decoding the same card is idempotent.
    const turnRng = fair.mulberry32(
        fair.hashSeed('beer-turn', (state as PlayStateRead).id || '', seed, (state as PlayStateRead).num != null ? String((state as PlayStateRead).num) : '',
            targetRack.length, ownRack.length)
    );

    // Bot is in REDEMPTION iff its own rack was already cleared.
    const inRedemption = ownRack.length === 0 && targetRack.length > 0;

    // Defensive: nothing to throw at (shouldn't happen in a valid flow) -> ignore.
    if (targetRack.length === 0) return { action: 'ignore' };

    const sim = engine.simulateTurn(({
        rackTarget: targetRack,
        rackOwn: ownRack,
        skill,
        mode,
        rng: turnRng,
        randomPositions,
        redemption: inRedemption,
    } as Parameters<typeof engine.simulateTurn>[0]));

    // --- assemble end board (positional rack1/rack2) --------------------------
    let endTarget = sim.target;      // Bot's throws reduced this (may be [] or re-set)
    let endOwn = ownRack.slice();    // Bot never touches its own rack this turn
    if (sim.overtime && sim.ownReset) endOwn = sim.ownReset.slice(); // overtime resets both

    const endRack1 = (player === 1) ? endTarget : endOwn;
    const endRack2 = (player === 1) ? endOwn : endTarget;

    const nativeReplay = engine.buildReplay({
        startRack1: startBoard.rack1,
        startRack2: startBoard.rack2,
        throws: sim.throws,
        endRack1,
        endRack2,
    } as Parameters<typeof engine.buildReplay>[0]);

    // Scores derived from the board so they always agree with the cups shown.
    const score1 = clamp(engine.TOTAL_CUPS - (endRack1 as {length: number}).length, 0, engine.TOTAL_CUPS);
    const score2 = clamp(engine.TOTAL_CUPS - (endRack2 as {length: number}).length, 0, engine.TOTAL_CUPS);
    const botScoreTotal = (player === 1) ? score1 : score2;
    const oppScoreTotal = (player === 1) ? score2 : score1;
    const opponentPlayed = ownRack.length < engine.TOTAL_CUPS ||
        ((state as PlayStateRead)['score' + opponent] != null && (state as PlayStateRead)['score' + opponent] !== '');

    // --- build the outbound state map -----------------------------------------
    const updates: PlayStateRead = {
        sender: (ctx as ExtraContextRead).botUuid,
        ['player' + player]: (ctx as ExtraContextRead).botUuid,
        ['avatar' + player]: (ctx as ExtraContextRead).botAvatar,
        ['score' + player]: String(botScoreTotal),
        ['skip_score' + player]: (state as PlayStateRead)['skip_score' + player] != null ? String((state as PlayStateRead)['skip_score' + player]) : '0',
        replay: nativeReplay,
    };
    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };

    // Native Cup Pong lives entirely in the shared `replay`. Drop any per-slot
    // animation logs (our old format / a stray field) so nothing foreign lingers.
    delete newState.replay1;
    delete newState.replay2;

    // Ensure Bot's own rack seed exists (invite carries only `seed`). Deterministic
    // so rebuilds match; carried unchanged once present.
    if (newState.seed2 == null || newState.seed2 === '') {
        const s2 = (fair.hashSeed('beer-seed2', (state as PlayStateRead).id || '', seed) % 2000000000);
        newState.seed2 = String(s2);
    }

    // Opponent's score: mirror the board once they've thrown; on a pure opening
    // leave their slot empty (matches the proven turn-1 shape).
    if (opponentPlayed) {
        newState['score' + opponent] = String(oppScoreTotal);
        if (newState['skip_score' + opponent] == null) newState['skip_score' + opponent] = '0';
    }

    // --- winner / hand-back ---------------------------------------------------
    // The receiver ORIENTS the native board from the top-level `player`
    // (`player = int(parsed.player)`, then flipped on their turn). A real client
    // stamps it with the SENDER's own slot (the tester's real card carried player="2"),
    // so Bot must set it to Bot's slot on EVERY card - omitting it makes the peer
    // read int(null)=0 and mis-orient the rack. Keep the opponent's slot claim +
    // avatar too so spectator detection stays correct.
    let botWon = null;
    newState.player = String(player);
    const oppUuid = (state as PlayStateRead)['player' + opponent] ||
        ((state as PlayStateRead).sender && (state as PlayStateRead).sender !== (ctx as ExtraContextRead).botUuid ? (state as PlayStateRead).sender : null);
    if (oppUuid) newState['player' + opponent] = oppUuid;
    if (sim.lostRedemption) {
        // Bot missed its redemption -> Bot loses. Only the loser writes `winner`.
        newState.winner = (ctx as ExtraContextRead).botUuid + '|-1';
        botWon = false;
    }
    // Turn hand-back needs nothing else: Bot SENT the card, so GamePigeon's session
    // layer makes it the tester's turn next (turn is message-sender based, not slot based).
    // If Bot cleared the opponent's rack, the tester's client gives HIM a redemption
    // throw off the empty rack we handed back (no winner from us).

    // --- INVITE -> GAMEPLAY rewrite (confirmed by the real invite 33178 -> Bot
    // gameplay pair: gameplay = invite minus start/caption/game_name/style2,
    // version 5->0, num 1->2). -------------------------------------------------
    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        delete newState.start;      // invite-only
        delete newState.caption;    // "Let's play Cup Pong!" - gameplay carries none
        delete newState.game_name;  // invite-only
        delete newState.style2;     // invite-only (not on the real gameplay card)
        newState.version = '0';     // gameplay generation (invite: 5)
        newState.num = '2';         // second card in the session (invite: 1)
    } else {
        newState.version = '0';
        newState.num = (state as PlayStateRead).num ? String(Number((state as PlayStateRead).num) + 1) : '2';
    }

    // Finishing card gets a subtitle; ongoing turns default to "Your Move."
    if (newState.winner) newState.caption = getSubtitle(newState);

    const skillLabel =
        (skill >= 0.6 ? 'strong' : skill >= 0.35 ? 'even' : 'ease-up') +
        ' skill=' + skill.toFixed(2) + ' +' + sim.made + 'cup' +
        (inRedemption ? ' [redemption]' : '') +
        (sim.cleared ? ' [cleared]' : '') +
        (sim.overtime ? ' [overtime]' : '') +
        (sim.lostRedemption ? ' [lost]' : '');

    const replySummary =
        'beer reply: slot=' + player + ' vs opp=' + opponent +
        ' made+' + sim.made + ' throws=' + sim.throws.length +
        ' target=' + targetRack.length + '->' + (endTarget as {length: number}).length +
        ' score1=' + score1 + ' score2=' + score2 +
        ' version=' + newState.version + ' num=' + newState.num +
        (newState.winner ? ' winner=' + newState.winner : ' (your-move / hand-back)');

    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_BEER_SEND!=1 | ' + replySummary,
        newState,
        botScore: sim.made,                 // cups sunk THIS turn
        botWords: sim.throws.length,        // balls thrown this turn (reused field for logs)
        mode: skillLabel,
        targetN: sim.made,
        fullScore: botScoreTotal,           // Bot's cumulative cups
        fullWords: engine.TOTAL_CUPS,        // rack size
        finishes: !!newState.winner,
        botWon,
        oppScore: opponentPlayed ? oppScoreTotal : null,
        player,
        opponent,
    };
}

export const beerPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    looksLikeBeer,
    BEER_HUMAN_CAP,
};

