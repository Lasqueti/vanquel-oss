// games/archery-play.ts
import type { PlayStateRead, PlayContextRead, PlayAdaptiveRead, ArcherySolveRead, GameDecision } from './play-types.ts';
import { archeryEngine as engine } from './archery-engine.ts';
import { rubberBand as rb } from './rubber-band.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// Archery auto-play (game=archery) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'archery'
//   displayName : 'Archery'
//   solve(state, deps) -> parsed context | null (skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// AUTHORITATIVE wire grammar (from archery/archery.gd:export_replay + parse_replay
// + _set_game_data + play_replay, `wordhunt` branch, CONFIRMED byte-for-byte against
// The tester's real captured 3-set game - chat.db ROWID 33212-33215, 2026-07-08):
//   replay = "state:<set>,<p1>,<p2>,<p1sets>,<p2sets>|move:1,<x>,<y>,<z>|...|state:<set>,<p1'>,<p2'>,<p1sets'>,<p2sets'>"
//   - Each card is ONE turn (3 arrows): the FIRST state: is the PRE state (before
//     the turn), the LAST is the POST state (after). It is NOT an accumulating log -
//     the full multi-set state lives in the 5-tuple, exactly like darts' 2-state.
//   - state 5-tuple: <set>=current set index (best-of-3), <p1>/<p2>=the CURRENT
//     SET's running score for each player, <p1sets>/<p2sets>=total SETS WON so far.
//   - move: FIRST field is a literal 1 (NOT the player), then x,y (target-plane
//     coords) and z (per-set target depth: set1 -14.397592 / set2 -20.397592 /
//     set3 -26.397592). Three floats after the 1.
//   Real sample (the tester, num3, set-1 completion): state:1,0,0,0,0|move:1,...|state:1,0,30,0,1
//   `seed` (a signed int) drives the deterministic wind; the receiver ANIMATES the
//   arrows from x,y,z and RE-SCORES each one (target.calc_score) - so the emitted
//   coordinate is the source of truth (engine.scoreFromXY reproduces it exactly).
//
// ------------------------- MULTI-SET STATE (Bug-2 fix) -----------------------
// Archery is best-of-3 SETS. Each set is exactly TWO turns (3 arrows per player).
// The player who moves FIRST after the invite shoots first in EVERY set; the other
// player is the set COMPLETER. When a set completes, the completer's card carries
// the INCREMENTED set-win count (post_sets != pre_sets); the opponent's device then
// advances set_num + resets the per-set scores to 0-0 locally. So Bot must:
//   Case A - the inbound card ENDED a set (pre/post sets or set-index differ):
//            the opponent just completed a set. Bot OPENS the NEXT set FRESH
//            (set+1, scores 0-0, carry the set wins) as the first shooter.
//   Case B - the inbound card was MID-SET (sets + set-index unchanged): the
//            opponent shot first this set. Bot is the second shooter -> it
//            COMPLETES the set: add its arrows, decide the set winner, bump the
//            set-win count (tie -> both, per archery.gd), and resolve the match
//            winner via archery.gd check_winner (2-0 clinch after round >=2, else a
//            round-3 comparison).
// The OLD code froze set_num=1 and never touched the sets/scores, so on the tester's real
// num4 it replied `state:1,0,30,0,1|...|state:1,21,30,0,1` - echoing set 1 and
// The tester's stale 30 into a game his device had already advanced to set 2. That is the
// "sets reset" bug; carrying + transitioning the accumulated 5-tuple fixes it, and it
// also RESTORES the win/loss feedback loop (games now conclude with a real `winner`,
// so the shared rubber-band factor can climb off the frozen 0.87 and converge ~50%).
//
// ============================ VERIFICATION STATUS ============================
// Built from OpenPigeon SOURCE (archery/archery.gd + target.gd, `wordhunt` branch)
// and CONFIRMED against the tester's real captured 3-set game (chat.db 33212-33215): the
// invite->reply rewrite, the state 5-tuple, the per-set z depths, and the set-end
// signature all match the capture. FAIL-SAFE: solve() returns null (=> skip) on a
// malformed card. Env-gated (GP_ARCHERY_SEND) for the tester's supervised live test.
// ============================================================================

const GAME_ID = 'archery';
const DISPLAY_NAME = 'Archery';

// Env gate (mirrors wordbites GP_WORDBITES_SEND). Staged 2026-07-07 for the tester's
// supervised live test.
const ENABLE_SEND = process.env.GP_ARCHERY_SEND === '1';

// --- Adaptive-mode tuning (beatable ~half even while the factor is frozen) ----
// The tester has MANY unfinished archery matches, so the shared self-tuner (which only
// runs on a CONCLUDED match) rarely moves archery's factor - it sat frozen at 0.964
// for its whole life. Two knobs make Bot genuinely beatable ~half REGARDLESS of the
// frozen factor by MIRRORING the opponent's demonstrated strength (aim the shot group
// at whatever ring the tester is actually shooting):
//   MIRROR_WEIGHT_LIVE - how hard this turn's accuracy tracks the opponent's LIVE
//     in-match set score (the score he actually just shot, read off the inbound
//     card). 0.75 => tightly match his real current level so the match is a coin
//     flip regardless of the frozen factor.
//   MIRROR_WEIGHT_PRIOR - how hard it tracks the COLD-START prior (his stored
//     demonstrated skill, used only for set 1 before he has shot this match). Lower
//     (0.45) so a lagging or fluke-driven stored stat can't dominate - the FACTOR
//     (the per-opponent self-tuned level) carries the rest, so a weak opponent whose
//     factor has eased to the floor still gets an eased set-1 opener.
//   TURN_WOBBLE - symmetric per-turn accuracy jitter (fraction) so Bot's 3-arrow
//     total STRADDLES the opponent's: he wins real sets ~half the time instead of the
//     scores landing in endless draws. Deterministic (from the per-card RNG).
//   STRONG_PA_LO / STRONG_PA_HI - the strong-opponent ramp: `strong` runs 0 -> 1 as
//     the opponent's demonstrated per-ARROW score climbs 8 -> 10 (set 24 -> 30). Below
//     24 the ramp is 0 and the whole strong-end path is code-path-identical to the
//     mid/weak tuning. At the strong end the ramp (a) raises the mirror weight to 1 so
//     the frozen-factor base can't drag the target below a demonstrated 30, (b) fades
//     the wobble and the catch-up EASE to 0 - vs someone who never drops a set there
//     is nothing above 30 to straddle, so both were pure score giveaways (maxPush
//     stays: Bot still digs in when behind).
//   STRONG_PA_UPLIFT - small per-arrow uplift (x strong) compensating the CONCAVE
//     score->accuracy map: mirroring a demonstrated 29 at literally 29 produces far
//     fewer 30-sets than a real 29-mean shooter throws, so Bot would still lose the
//     bullseye trade.
//   TOP_PER_ARROW - hard per-arrow ceiling on the mirror target (E[set] 29.79, P(30)
//     ~0.7): Bot stays a strong human, never a guaranteed-30 robot.
// All apply ONLY in adaptive mode; a fixed difficulty (chill/match/sweat/max) plays
// its level literally (max => flawless bullseyes).
const MIRROR_WEIGHT_LIVE = 0.75;
const MIRROR_WEIGHT_PRIOR = 0.45;
const TURN_WOBBLE = 0.08;
const STRONG_PA_LO = 8;
const STRONG_PA_HI = 10;
const STRONG_PA_UPLIFT = 0.15;
const TOP_PER_ARROW = 9.93;

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

// parseReplay(replay) -> { preState, postState, moves, ok, empty }
//   state:<set>,<p1>,<p2>,<p1sets>,<p2sets>  (first = pre, last = post)
//   move:1,<x>,<y>,<z>                        (literal 1, then 3 floats)
// Mirrors archery.gd:parse_replay (first state -> pre_state, second -> post_state).
function parseReplay(replay: unknown) {
    if (typeof replay !== 'string' || replay.length === 0) {
        return { preState: null, postState: null, moves: [], ok: true, empty: true };
    }
    let preState: number[] | null = null;
    let postState: number[] | null = null;
    const moves = [];
    for (const ev of replay.split('|')) {
        if (!ev) continue;
        if (ev.startsWith('state:')) {
            const parts = ev.slice('state:'.length).split(',');
            if (parts.length < 5) return { preState, postState, moves, ok: false };
            for (const v of parts) {
                if (!Number.isFinite(Number(v))) return { preState, postState, moves, ok: false };
            }
            const nums = parts.map(Number);
            if (preState == null) preState = nums;
            else postState = nums;
        } else if (ev.startsWith('move:')) {
            const parts = ev.slice('move:'.length).split(',');
            if (parts.length < 4) return { preState, postState, moves, ok: false };
            for (const v of parts) {
                if (!Number.isFinite(Number(v))) return { preState, postState, moves, ok: false };
            }
            moves.push(parts.map(Number));
        }
    }
    return { preState, postState, moves, ok: true, empty: false };
}

function looksLikeArchery(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    if ((state as PlayStateRead).replay != null && typeof (state as PlayStateRead).replay === 'string' && ((state as PlayStateRead).replay as string).length > 0) {
        if (!parseReplay((state as PlayStateRead).replay).ok) return false;
    }
    return true;
}

// solve - no dictionary. Carry the seed (deterministic wind/angle) + BOTH the inbound
// pre/post 5-tuples (needed to detect a set boundary in decideMove) plus the latest
// set/score/sets values (from the post-state, else the fresh-invite defaults of set 1,
// 0-0, 0-0 sets).
function solve(state: unknown /*, deps */) {
    if (!looksLikeArchery(state)) return null;
    const seed = Number((state as PlayStateRead).seed);
    let setNum = 1;
    let p1 = 0;
    let p2 = 0;
    let p1sets = 0;
    let p2sets = 0;
    let pre = null;
    let post = null;
    if ((state as PlayStateRead).replay && typeof (state as PlayStateRead).replay === 'string' && ((state as PlayStateRead).replay as string).length > 0) {
        const parsed = parseReplay((state as PlayStateRead).replay);
        if (!parsed.ok) return null;
        pre = parsed.preState;
        post = parsed.postState;
        const latest = parsed.postState || parsed.preState;
        if (latest) {
            setNum = latest[0];
            p1 = latest[1];
            p2 = latest[2];
            p1sets = latest[3];
            p2sets = latest[4];
        }
    }
    return {
        seed: Number.isFinite(seed) ? seed : 0,
        setNum, p1, p2, p1sets, p2sets,
        pre, post,
    };
}

// factorToAccuracy - map the shared rubber-band factor to aim accuracy [0,1].
// CONTINUOUS across the whole adaptive band via the shared fair-play helper. factor
// 0.60 -> accuracy 0.08 (centred scatter sigma ~0.39 => mean ~ring 5, arrows spanning
// ~3-8 so a weak opponent wins ~half) and 1.30 -> accuracy 1.0 (sigma 0 => flawless
// dead-centre bullseyes). Under the centred-scatter engine this is MONOTONIC and the
// centre is reachable across the whole band (the old outward-annulus model made the
// gold unreachable until near-perfect - that was the "never 9-10" bug). This is only
// the BASE level; decideMove blends it with an opponent MIRROR + per-turn wobble so
// Bot is beatable ~half even while the factor is frozen by unfinished matches.
function factorToAccuracy(factor: number) {
    return fair.factorToSkill(factor);
}

// resolveMatchWinner(completedRound, botSets, oppSets, botUuid)
//   -> { winnerField, botWon } | null (match not over)
// Mirrors archery.gd:check_winner: a 2-0 early clinch is only checked after round
// >= 2; otherwise no result until round 3 completes, then a straight set-win compare
// (equal => draw). winnerField is "<botUuid>|<flag>" (flag 1 = Bot/sender won,
// -1 = Bot lost, 0 = draw) - Bot is the sender of the card it stamps this onto.
function resolveMatchWinner(completedRound: number, botSets: number, oppSets: number, botUuid: unknown) {
    if (completedRound >= 2) {
        if (botSets === 2 && oppSets === 0) return { winnerField: botUuid + '|1', botWon: true };
        if (oppSets === 2 && botSets === 0) return { winnerField: botUuid + '|-1', botWon: false };
    }
    if (completedRound < 3) return null;
    if (botSets === oppSets) return { winnerField: botUuid + '|0', botWon: null };
    if (botSets > oppSets) return { winnerField: botUuid + '|1', botWon: true };
    return { winnerField: botUuid + '|-1', botWon: false };
}

function decideMove(state: unknown, ctx: unknown, solveResult: unknown): GameDecision {
    if (!looksLikeArchery(state)) return { action: 'ignore' };
    const rbState = (((ctx && (ctx as PlayContextRead).rbState) || {}) as PlayAdaptiveRead);

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
        // Opponent's demonstrated set score (observability only - archery reads just
        // handicapFactor, so this never changes the factor climb; a loss always
        // pushes the factor up regardless). Read the opponent's slot from the post.
        let oppScore = null;
        if (solveResult && (solveResult as ArcherySolveRead).post) {
            const botSlot = (state as PlayStateRead).player1 === (ctx as PlayContextRead).botUuid ? 1
                : (state as PlayStateRead).player2 === (ctx as PlayContextRead).botUuid ? 2 : null;
            if (botSlot) oppScore = (solveResult as ArcherySolveRead).post![botSlot === 1 ? 2 : 1];
        }
        return { action: 'result', winner: wUuid, flag, botWon, oppScore };
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
    else { opponent = 2; player = 1; }

    // --- MULTI-SET STATE MACHINE (Bug-2 fix) --------------------------------
    // Read the inbound pre/post 5-tuples and classify the turn. `basePre` is the
    // 5-tuple Bot's turn STARTS from; `botIsCompleter` decides whether Bot ends
    // the current set (Case B) or opens a fresh one (Case A).
    const post = (solveResult as ArcherySolveRead).post;
    const pre = (solveResult as ArcherySolveRead).pre;
    let setNum;
    let basePre;          // [set, p1, p2, p1sets, p2sets] Bot's turn begins from
    let botIsCompleter;  // true => Bot completes this set; false => Bot opens it
    if (!post) {
        // Bare invite (no replay yet): Bot opens set 1 as the first shooter.
        setNum = 1;
        basePre = [1, 0, 0, 0, 0];
        botIsCompleter = false;
    } else {
        const inSet = post[0];
        const inP1 = post[1];
        const inP2 = post[2];
        const inP1s = post[3];
        const inP2s = post[4];
        const preSet = pre ? pre[0] : inSet;
        const preP1s = pre ? pre[3] : inP1s;
        const preP2s = pre ? pre[4] : inP2s;
        const setEnded = (preP1s !== inP1s) || (preP2s !== inP2s) || (preSet !== inSet);
        if (setEnded) {
            // Opponent just COMPLETED a set -> Bot opens the NEXT set fresh, carrying
            // the accumulated set wins (scores reset to 0-0). If that would be past
            // set 3 the match is over (the `winner` field handles it) -> nothing to do.
            const nextSet = inSet + 1;
            if (nextSet > 3) return { action: 'ignore' };
            setNum = nextSet;
            basePre = [nextSet, 0, 0, inP1s, inP2s];
            botIsCompleter = false;
        } else {
            // Mid-set: the opponent shot first this set -> Bot is the second shooter
            // and COMPLETES the set from the inbound post-state.
            setNum = inSet;
            basePre = [inSet, inP1, inP2, inP1s, inP2s];
            botIsCompleter = true;
        }
    }

    // --- SKILL / ACCURACY for this turn -------------------------------------
    // The per-game factor sets Bot's BASE aim quality. In ADAPTIVE mode Bot ALSO
    // MIRRORS the opponent's demonstrated archery strength so it's genuinely beatable
    // ~half EVEN WHILE the factor is frozen by the tester's many unfinished matches: it
    // aims its shot group at whatever ring the tester is actually shooting (near-flawless
    // vs a bullseye machine, eased vs a weak archer), and a per-turn wobble makes its
    // 3-arrow total STRADDLE his so he wins real sets ~half the time. A FIXED
    // difficulty (chill/match/sweat/max) bypasses the mirror and plays the lever's
    // level literally (max => a strong-human group, capped by fair.SKILL_CAP - not
    // flawless dead-centre bullseyes).
    const ARROWS_PER_TURN = 3; // archery.gd num_shots per set
    const factor = rb.handicapFactor(rbState);
    const baseAccuracy = factorToAccuracy(factor as number);
    const isFixedDifficulty = !!(rbState.difficulty && rbState.difficulty !== 'adaptive');

    // Opponent's demonstrated per-ARROW strength (0..10), strongest signal first:
    //   1. LIVE IN-MATCH set score - the opponent's most recent 3-arrow set total in
    //      THIS match, read straight off the inbound card. This is the robust signal:
    //      it works no matter how stale the stored skill is, and no matter whether any
    //      match ever concludes. Available when Bot COMPLETES a set (the opponent
    //      just shot it) AND when Bot OPENS set 2/3 (the opponent's completion of the
    //      prior set carries their score in the inbound post-state).
    //   2. Cold-start prior (set 1 only, before the opponent has shot this match):
    //      their per-game demonstrated TYPICAL archery skill (scoreStats.avg, a
    //      3-arrow set total). This prior is trusted less than the live signal (a
    //      lower blend weight below), so a stale or fluke-seeded stat can't dominate.
    // All are 3-arrow set totals, so /ARROWS_PER_TURN gives per-arrow.
    let oppLiveSet = null;
    if (botIsCompleter) {
        oppLiveSet = basePre[opponent];              // opponent shot first this set (live)
    } else if (post) {
        oppLiveSet = (solveResult as ArcherySolveRead).post![opponent];     // opponent's just-completed prior set (live)
    }
    const oppSignalIsLive = Number.isFinite(oppLiveSet) && (oppLiveSet as number) > 0;
    let oppPerArrow = null;
    if (oppSignalIsLive) {
        oppPerArrow = (oppLiveSet as number) / ARROWS_PER_TURN;
    } else {
        const ss = rbState.scoreStats && rbState.scoreStats[GAME_ID];
        if (ss && ss.n > 0 && Number.isFinite(ss.avg)) {
            // Track their TYPICAL (avg) set, not a one-off spike: a weak opponent who
            // flukes a single high set must not get a permanently stronger Bot. The
            // live in-match mirror (above) handles a player who is genuinely on form.
            oppPerArrow = ss.avg / ARROWS_PER_TURN;
        }
    }

    // Deterministic per-CARD RNG (round-trip stable): per-card nonce state.id + the
    // uuids + seed + this turn's set/scores/num. Every draw below (turn wobble, the
    // per-arrow 2-D Gaussian scatter) comes from it, so a re-processed inbound card
    // reproduces the identical move - the stability the wire needs.
    const gameNonce = fair.hashSeed(
        (state as PlayStateRead).id || '', (state as PlayStateRead).player1 || '', (state as PlayStateRead).player2 || '', String((solveResult as ArcherySolveRead).seed || ''));
    const rng = fair.mulberry32(fair.hashSeed(
        gameNonce, setNum, basePre[1], basePre[2], Number((state as PlayStateRead).num) || 0));

    // Blend the factor's base accuracy with the opponent mirror, then keep the match
    // close and give the tester real wins (adaptive only). `strong` (0..1) ramps in over a
    // demonstrated per-arrow 8..10 (set 24..30) and progressively removes everything
    // that COMPRESSED the mirror at the top end - the frozen-factor base blend, the
    // wobble, and the catch-up ease - so vs a bullseye machine Bot genuinely trades
    // 29s/30s instead of forfeiting from a target it was never allowed to reach.
    // Below a demonstrated 24 strong=0 and this block behaves exactly as before.
    let accuracy = baseAccuracy;
    let strong = 0;
    if (!isFixedDifficulty) {
        if (oppPerArrow != null) {
            strong = fair.clamp((oppPerArrow - STRONG_PA_LO) / (STRONG_PA_HI - STRONG_PA_LO), 0, 1);
            // Concavity uplift + human cap (see STRONG_PA_UPLIFT / TOP_PER_ARROW above).
            const cappedPA = Math.min(oppPerArrow + strong * STRONG_PA_UPLIFT, TOP_PER_ARROW);
            const mirrorAcc = engine.accuracyForExpectedScore(cappedPA);
            // Mirror weight rises to 1 at strong=1: the frozen-factor base (mean ring
            // ~7.8 at the tester's frozen 0.964) must not drag the target below a
            // demonstrated 30 - that base drag was the match-decider vs strong players.
            const wBase = oppSignalIsLive ? MIRROR_WEIGHT_LIVE : MIRROR_WEIGHT_PRIOR;
            const w = wBase + (1 - wBase) * strong;
            accuracy = w * mirrorAcc + (1 - w) * baseAccuracy;
        }
        // Within-match catch-up: ease when Bot leads on SETS, push when behind, so a
        // best-of-3 stays close regardless of the frozen factor (a 1-set gap in a
        // best-of-3 is significant -> scale 2). The EASE side fades with `strong`: a
        // gifted set vs an opponent who never drops one is a gifted match. The PUSH
        // side stays at full strength.
        const botSetsNow = player === 1 ? basePre[3] : basePre[4];
        const oppSetsNow = player === 1 ? basePre[4] : basePre[3];
        const signal = fair.catchupSignal(botSetsNow - oppSetsNow, 2);
        accuracy = fair.applyCatchup(accuracy, signal, { maxEase: 0.30 * (1 - strong), maxPush: 0.30 });
        // Per-turn wobble so Bot's total STRADDLES the opponent's (real wins for him
        // ~half, not endless draws). Symmetric, deterministic, small. Fades with
        // `strong`: score space caps at 30, so vs a 30-shooter the down-leg crushed
        // P(set=30) while the up-leg gained nothing - strictly negative EV. At the
        // strong end variance comes only from the honest aim Gaussian.
        accuracy *= 1 + fair.bipolar(rng) * TURN_WOBBLE * (1 - strong);
    }
    accuracy = fair.clamp(accuracy, 0, 1);

    const mode = (accuracy >= 0.95 ? 'ramp-up:bullseye' : 'ease-up:centred-scatter') +
        ' acc=' + accuracy.toFixed(2) + ' base=' + baseAccuracy.toFixed(2) +
        (oppPerArrow != null ? ' oppPA=' + oppPerArrow.toFixed(1) : '') +
        (strong > 0 ? ' strong=' + strong.toFixed(2) : '') +
        (botIsCompleter ? ' complete-set' : ' open-set') + ' set=' + setNum;

    // Archery turn = THREE arrows. Aim is CENTRED on the bullseye; each arrow lands at
    // centre + a 2-D Gaussian error whose std grows as accuracy drops
    // (engine.aimCentered). So a strong Bot groups tight on 9-10 (centre reachable,
    // frequent bullseyes) and a weak Bot SPRAYS the competitive band - never a
    // stamped outer ring. The ring is RE-SCORED from the EXACT emitted coordinate
    // (engine.scoreFromXY), never faked, so the animated arrow and the awarded ring
    // always agree. At accuracy 1 the scatter is 0, so ramp-up / max is a flawless
    // dead-centre bullseye. Landings are clamped onto the board inside aimCentered, so
    // ring >= 1 (never an off-board MISS).
    const drawZ = engine.SET_DEPTH[setNum] != null ? engine.SET_DEPTH[setNum] : engine.SET_DEPTH[1];
    const moveEvents = [];
    let turnPoints = 0;
    for (let i = 0; i < ARROWS_PER_TURN; i++) {
        const g = engine.gaussianPair(rng);          // 2-D standard-normal scatter
        const aim = engine.aimCentered(accuracy, g.gx, g.gy, setNum);
        const xs = aim.x.toFixed(6);
        const ys = aim.y.toFixed(6);
        const zs = (drawZ as number).toFixed(6);
        turnPoints += engine.scoreFromXY(Number(xs), Number(ys));
        // move:1,<x>,<y>,<z>  - FIRST field is a literal 1 (archery.gd:export_replay
        // writes "move:1," regardless of player), then x,y,z.
        moveEvents.push('move:1,' + xs + ',' + ys + ',' + zs);
    }

    // Build the POST 5-tuple from basePre + Bot's turn.
    const preP1 = basePre[1];
    const preP2 = basePre[2];
    const preP1s = basePre[3];
    const preP2s = basePre[4];
    const botBefore = player === 1 ? preP1 : preP2; // 0 at a set start; guards partial state
    const botAfter = botBefore + turnPoints;
    const oppSetScore = player === 1 ? preP2 : preP1;

    const postP1 = player === 1 ? botAfter : preP1;
    const postP2 = player === 2 ? botAfter : preP2;
    let postP1s = preP1s;
    let postP2s = preP2s;
    let winnerField = null;
    let botWon = null;

    if (botIsCompleter) {
        // Bot's arrows finish the set: decide the set winner and bump the set wins
        // (tie -> BOTH, per archery.gd:_animate_set_bar_and_award_points).
        if (botAfter > oppSetScore) { if (player === 1) postP1s++; else postP2s++; }
        else if (botAfter < oppSetScore) { if (player === 1) postP2s++; else postP1s++; }
        else { postP1s++; postP2s++; }

        const botSets = player === 1 ? postP1s : postP2s;
        const oppSets = player === 1 ? postP2s : postP1s;
        const resolved = resolveMatchWinner(setNum, botSets, oppSets, (ctx as PlayContextRead).botUuid);
        if (resolved) { winnerField = resolved.winnerField; botWon = resolved.botWon; }
    }

    // The wire card is ONE turn: pre 5-tuple | this turn's 3 moves | post 5-tuple.
    // set_num stays constant within the card (archery.gd exports with the completed
    // set's index and only advances set_num LOCALLY afterward); the receiver detects
    // a set boundary from the sets delta and advances/resets on its own device.
    const newReplay =
        'state:' + setNum + ',' + preP1 + ',' + preP2 + ',' + preP1s + ',' + preP2s + '|' +
        moveEvents.join('|') + '|' +
        'state:' + setNum + ',' + postP1 + ',' + postP2 + ',' + postP1s + ',' + postP2s;

    const updates: PlayStateRead = {
        sender: (ctx as PlayContextRead).botUuid,
        ['player' + player]: (ctx as PlayContextRead).botUuid,
        ['avatar' + player]: (ctx as PlayContextRead).botAvatar,
        replay: newReplay,
    };
    if (winnerField) updates.winner = winnerField;
    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };
    if (newState.player2 !== (ctx as PlayContextRead).botUuid && !newState.player1) newState.player1 = (ctx as PlayContextRead).botUuid;

    // INVITE -> GAMEPLAY rewrite. An archery invite (ArcheryGame.kt getNewGameData)
    // has start/caption/game_name + version=5 + seed, no replay. The on-device
    // gameplay generation (archery.gd:127 debug sample) drops start/caption/
    // game_name and stamps version=0; seed stays. No inner caption on gameplay.
    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        delete newState.start;      // invite-only
        delete newState.caption;    // "Let's play Archery!" - gameplay carries none
        delete newState.game_name;  // invite-only
        delete newState.player;     // invite-only bare slot claim
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

    const replySummary =
        'archery reply: slot=' + player + ' vs opp=' + opponent +
        ' set=' + setNum + (botIsCompleter ? ' (complete)' : ' (open)') +
        ' turnPoints=' + turnPoints +
        ' scores=' + postP1 + '/' + postP2 + ' sets=' + postP1s + '/' + postP2s +
        ' arrows=' + ARROWS_PER_TURN +
        ' replay=' + newReplay +
        ' version=' + newState.version +
        (winnerField ? ' winner=' + winnerField : ' (your-move)');
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_ARCHERY_SEND!=1 | ' + replySummary,
        newState,
        botScore: turnPoints,      // points scored this turn (sum of 3 arrows)
        botWords: ARROWS_PER_TURN, // arrows this turn (reused field for logs)
        oppScore: botIsCompleter ? oppSetScore : null, // opp's set score when Bot closes a set
        mode,
        targetN: null,
        fullScore: 30,             // max per 3-arrow turn (3 x 10)
        fullWords: turnPoints,
        botWon,
        player,
        opponent,
    };
}

export const archeryPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    parseReplay,
    looksLikeArchery,
    factorToAccuracy,
    resolveMatchWinner,
};

