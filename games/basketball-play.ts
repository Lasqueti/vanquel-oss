// games/basketball-play.ts
import type { PlayStateRead, PlayContextRead, PlayAdaptiveRead, GameDecision } from './play-types.ts';
import { basketballEngine as engine } from './basketball-engine.ts';
import { rubberBand as rb } from './rubber-band.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// Basketball auto-play (game=basketball) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'basketball'
//   displayName : 'Basketball'
//   solve(state, deps) -> parsed context | null (null => skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// Basketball is SOLO-SCORE (each player shoots one independent round into their
// own hoop, then made-basket counts are compared), so Bot's whole "move" is an
// entire round of shots. TURN DETECTION IS BY SENDER, never by slot ownership: Bot
// ignores only the ECHO of its own outbound card (sender === botUuid); on any other
// inbound card it owns the empty slot / the finish. Three states are handled:
//   (A) Bot OPENS a bare invite  (no opponent replay, scores 0/0): Bot fills its
//       slot's score + replay, sets NO winner, and hands back - the opponent then
//       shoots and Bot finalizes. On a bare invite the inviter is player2 (invite
//       carries player='2' + player2=<inviter>, no player1), so the RECIPIENT (Bot)
//       owns the empty slot 1 and opens it.
//   (B) Bot CLOSES  (opponent shot first, Bot owns NO slot yet: their replay +
//       score present, Bot's slot empty): Bot fills its slot's score + replay AND
//       sets `winner` to finish the game in one card.
//   (C) Bot FINALIZES  (Bot already OPENED, so it owns a slot; the opponent has now
//       shot the other slot and handed back with NO winner): Bot sends ONE closing
//       card that only sets `winner` from the two authoritative scores - it does NOT
//       re-shoot. This is the real 3-card flow (invite -> Bot opens -> opponent
//       closes -> Bot finalizes). The old code gated this turn on slot ownership and
//       returned `ignore`, so a real the tester-first game stalled on "waiting on
//       opponent's move" forever - see buildFinalize + the darts-play.ts:203 note.
//
// ============================ VERIFICATION STATUS ============================
// Wire format CONFIRMED against the tester's real capture (a test line session
// yCcNUqH9435HGN93, sms.db ROWID 100 invite + 102 played, 2026-07-08):
//   - Invite (num=1, version=5): start/caption/game_name + player='2' + player2 +
//     avatar2 + seed + seed2 + round + mode + score1=0 + score2=0 + skip_score1/2.
//   - Played (num=2, version=0): drops start/caption/game_name, flips version->0,
//     adds the mover's replayN + scoreN, keeps `player`=<mover slot>, and the
//     WAITING slot has NO playerN (only a leftover/placeholder avatarN) + scoreN=0.
//   - OUTCOME ENCODING VERIFIED: replay2 held 46 shots, exactly 18 with made=1, and
//     score2="18". The per-shot verdict is baked in AND the total is authoritative.
// The recipient TRUSTS the sent score/made flags (outcome-encoded, tractable),
// same class as darts. See basketball-engine.ts for the shot grammar + the
// hoop-geometry caveat. FAIL-SAFE: solve() returns null (=> watcher skips) on a
// malformed card; a corrupt shot log is rejected by engine.parseReplay.
// Env-gated (GP_BASKETBALL_SEND) until the tester's supervised live test.
//
// CAVEAT (report + header): the exact hoop-movement mapping from seed/seed2 ->
// hoop position over time is NOT modelled (no on-device source), so if the
// recipient RE-ADJUDICATES each shot from geometry instead of trusting the
// `made`/`score` fields (the confirmed encoding), a cosmetic make/miss animation
// desync is possible. The score itself is always authoritative + self-consistent.
// The Bot-OPENS hand-back (drop the opponent's slot claim so their client lets
// them shoot) mirrors the PROVEN anagrams/word-hunt first-mover fix but is not
// itself capture-verified for basketball (no recipient-opens card was captured).
// ============================================================================

const GAME_ID = 'basketball';
const DISPLAY_NAME = 'Basketball';

// Env gate (mirrors GP_DARTS_SEND). Until '1', decideMove's play path returns
// action:'skip' (decode+solve+build still round-trip in dry-run, nothing sent).
const ENABLE_SEND = process.env.GP_BASKETBALL_SEND === '1';

// Assumed opponent made-count when Bot OPENS (no opponent score visible yet). A
// middling GamePigeon Basketball score; the adaptive factor self-tunes future
// games toward ~50% regardless of this seed.
const DEFAULT_MADE = 15;
// Target make rate used to size the attempt count so Bot's log reads like a real
// game (the tester's real card was 18 made / 46 attempts ≈ 0.39).
const TARGET_MAKE_RATE = 0.40;
const MIN_ATTEMPTS = 12;
const MAX_ATTEMPTS = 64;
const MAX_SCORE = 60; // sanity clamp on the made target

function clamp(x: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, x));
}
function numOrNull(v: unknown) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function replayPresent(state: unknown, slot: number) {
    const r = (state as PlayStateRead)['replay' + slot];
    return typeof r === 'string' && r.length > 0;
}

// -----------------------------------------------------------------------------
// getSubtitle(msg, myUuid) - winner flag is relative to the winner uuid; the
// watcher computes botWon from sender + flag. Identical convention to the other
// games (duplicated, tiny, so basketball-play has no cross-game import).
// -----------------------------------------------------------------------------
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
// looksLikeBasketball(state) - fail-safe field validation.
// -----------------------------------------------------------------------------
function looksLikeBasketball(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    // Both invite and gameplay cards carry the shared deterministic seeds that
    // drive the hoop movement; a card missing them is not a well-formed round.
    if ((state as PlayStateRead).seed == null || (state as PlayStateRead).seed2 == null) return false;
    // Any present shot log must parse.
    for (const slot of [1, 2]) {
        const r = (state as PlayStateRead)['replay' + slot];
        if (r != null && String(r).length > 0 && !engine.parseReplay(r).ok) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// solve(state, deps) - no dictionary. Carry the current scoreboard + seeds.
// Returns null to signal the watcher to SKIP a malformed card.
// -----------------------------------------------------------------------------
function solve(state: unknown /*, deps */) {
    if (!looksLikeBasketball(state)) return null;
    return {
        score1: numOrNull((state as PlayStateRead).score1),
        score2: numOrNull((state as PlayStateRead).score2),
        seed: Number((state as PlayStateRead).seed),
        seed2: Number((state as PlayStateRead).seed2),
    };
}

// -----------------------------------------------------------------------------
// buildFinalize(state, ctx, botSlot, oppSlot) - Bot OPENED earlier, the opponent
// has now shot and handed the card back with NO winner. Bot sends ONE closing card
// that only SETS THE WINNER from the two already-authoritative made-basket counts;
// it does NOT re-shoot (its own score + replay are already on the wire, and are left
// as-is). This is the third card in the real 3-card basketball flow (invite ->
// Bot opens -> opponent closes -> Bot finalizes), proven against the tester's captured
// The tester-first game (chat.db ROWID 33183: score1=16 vs score2=30 -> Bot|-1).
// -----------------------------------------------------------------------------
function buildFinalize(state: unknown, ctx: unknown, botSlot: number, oppSlot: number): GameDecision {
    const botScore = numOrNull((state as PlayStateRead)['score' + botSlot]) || 0;
    const oppScore = numOrNull((state as PlayStateRead)['score' + oppSlot]) || 0;
    const flag = botScore > oppScore ? '1' : botScore < oppScore ? '-1' : '0';
    const botWon = flag === '1' ? true : flag === '-1' ? false : null;

    // Keep the whole scoreboard (both scores + the opponent's replay) exactly as sent
    // - the scores are authoritative and must NOT be re-adjudicated. Only stamp the
    // winner + threading fields.
    const newState: PlayStateRead = { ...(state as PlayStateRead) };
    delete newState.start;      // invite-only (defensive; a gameplay card has none)
    delete newState.caption;
    delete newState.game_name;
    newState.sender = (ctx as PlayContextRead).botUuid;
    newState.winner = (ctx as PlayContextRead).botUuid + '|' + flag;
    newState.player = String(botSlot); // Bot's slot is the one closing the game out
    newState.version = '0';
    newState.num = (state as PlayStateRead).num ? String(Number((state as PlayStateRead).num) + 1) : '2';

    const replySummary =
        'basketball FINALIZE: botSlot=' + botSlot + ' vs opp=' + oppSlot +
        ' score=' + botScore + ' vs ' + oppScore +
        ' winner=' + newState.winner + ' num=' + newState.num;
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_BASKETBALL_SEND!=1 | ' + replySummary,
        newState,
        botScore,
        botWords: 0,            // no new attempts on a finalize card
        mode: 'finalize',
        targetN: null,
        fullScore: botScore,
        fullWords: oppScore,
        finishes: true,
        botWon,
        oppScore,
        player: botSlot,
        opponent: oppSlot,
    };
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solveResult)
//   ctx = { botUuid, botAvatar, rbState }
// Returns { action:'ignore'|'result'|'play'|'skip', ... }.
// -----------------------------------------------------------------------------
function decideMove(state: unknown, ctx: unknown, solveResult: unknown): GameDecision {
    if (!looksLikeBasketball(state)) return { action: 'ignore' };
    const rbState = (((ctx && (ctx as PlayContextRead).rbState) || {}) as PlayAdaptiveRead);

    // --- finished game: report result, watcher records W/L, sends nothing ----
    if ((state as PlayStateRead).winner) {
        const parts = String((state as PlayStateRead).winner).split('|');
        const wUuid = parts[0];
        const flag = parts[1];
        let botWon;
        if (flag === '0') {
            botWon = null;
        } else {
            const senderWon = flag === '1';
            const senderIsBot = ((state as PlayStateRead).sender === (ctx as PlayContextRead).botUuid);
            botWon = senderIsBot ? senderWon : !senderWon;
        }
        const s1 = numOrNull((state as PlayStateRead).score1);
        const s2 = numOrNull((state as PlayStateRead).score2);
        let botScore = null;
        let oppScore = null;
        if ((state as PlayStateRead).player1 === (ctx as PlayContextRead).botUuid) { botScore = s1; oppScore = s2; }
        else if ((state as PlayStateRead).player2 === (ctx as PlayContextRead).botUuid) { botScore = s2; oppScore = s1; }
        else { oppScore = s2 != null ? s2 : s1; }
        return { action: 'result', winner: wUuid, flag, botWon, botScore, oppScore };
    }

    if (!solveResult) return { action: 'ignore' };

    // --- Whose turn is it? Turn detection is by SENDER, never by slot ownership.
    // Basketball is a 3-card flow (invite -> opener shoots -> closer shoots -> opener
    // FINALIZES the winner), so after Bot OPENS its uuid legitimately stays in its
    // slot for the rest of the game - "Bot owns a slot" does NOT mean "Bot already
    // took its whole turn." The returning close card still needs Bot to set the
    // winner. (This is the exact trap darts-play.ts:203 warns about; basketball used
    // to gate on slot ownership here and silently swallowed the finalize card, so a
    // real the tester-first game stuck on "waiting on opponent's move" forever.)
    //
    // Bot only ever sees INBOUND cards (the watcher filters is_from_me=0). The one
    // card it must ignore is an ECHO of its own outbound hand-back, which carries
    // sender === botUuid.
    if ((state as PlayStateRead).sender && (state as PlayStateRead).sender === (ctx as PlayContextRead).botUuid) {
        return { action: 'ignore' };
    }

    // Does Bot already own a slot (it OPENED earlier)? If so this is the opponent's
    // returning card:
    //   - opponent has now shot (their replay is present) -> Bot FINALIZES: set the
    //     winner from the two authoritative scores, keep both scores + the opponent's
    //     replay, do NOT re-shoot (Bot's score/replay are already on the wire).
    //   - opponent has NOT shot yet -> nothing to finalize; wait for their card.
    const botSlot =
        (state as PlayStateRead).player1 === (ctx as PlayContextRead).botUuid ? 1 : (state as PlayStateRead).player2 === (ctx as PlayContextRead).botUuid ? 2 : null;
    if (botSlot != null) {
        const oppSlot = botSlot === 1 ? 2 : 1;
        if (!replayPresent(state, oppSlot)) return { action: 'ignore' };
        return buildFinalize(state, ctx, botSlot, oppSlot);
    }

    // Bot has NOT taken a slot yet -> OPEN a bare invite or CLOSE an opponent-shot
    // card. Which slot does the OPPONENT hold, and did they already shoot? A slot has
    // been "shot" iff it carries a replay. Prefer the replay signal, then a slot
    // claim, then the bare-invite default (inviter is player2, so Bot opens slot 1).
    let opponent;
    if (replayPresent(state, 2)) opponent = 2;
    else if (replayPresent(state, 1)) opponent = 1;
    else if ((state as PlayStateRead).player1 && (state as PlayStateRead).player1 !== (ctx as PlayContextRead).botUuid) opponent = 1;
    else if ((state as PlayStateRead).player2 && (state as PlayStateRead).player2 !== (ctx as PlayContextRead).botUuid) opponent = 2;
    else opponent = 2; // bare invite: inviter claimed slot 2 (player='2')
    const player = opponent === 1 ? 2 : 1;

    const oppShot = replayPresent(state, opponent);
    const oppScoreVisible = oppShot ? numOrNull((state as PlayStateRead)['score' + opponent]) : null;

    // --- Target made-basket count (fair-play). Reuse the SHARED adaptive factor
    // (the watcher self-tunes it toward ~50% via updateAdaptiveState) as a
    // proportional-score multiplier, exactly like the word games - Basketball's
    // score scales with the opponent, so the multiplier lever fits it (not the
    // scatter lever darts/archery use). CLOSING references the opponent's real
    // visible score; OPENING references DEFAULT_MADE (the factor still converges
    // future games). fair.factorToSkill is intentionally NOT used for the target:
    // the score-multiplier is what converges here.
    const factor = rb.WORD_DIFFICULTY_FACTOR[rbState.difficulty] != null
        ? rb.WORD_DIFFICULTY_FACTOR[rbState.difficulty]
        : rb.handicapFactor(rbState);
    const gamesPlayed = rbState.gamesPlayed || 0;
    // Deterministic -10%..+10% jitter (same formula as rubber-band.chooseSubmission).
    const jitter = rb.targetJitter(rbState, gamesPlayed, GAME_ID);
    const ref = oppShot && oppScoreVisible != null ? Math.max(0, oppScoreVisible) : DEFAULT_MADE;
    let targetMade = clamp(Math.round(ref * (factor as number) * (jitter as number)), 0, MAX_SCORE);
    // Soft floor: don't hand back a bizarre near-shutout unless the opponent also
    // scored low (never floor above the reference).
    if (ref > 0) targetMade = Math.max(Math.min(2, ref), targetMade);

    // Deterministic RNG for the shot generation (seeded from the session + seeds +
    // slot + target, so the log varies game to game yet is fully reproducible; no
    // Math.random in the decision path). Uses the shared fair-play helpers.
    const rng = fair.mulberry32(
        fair.hashSeed((state as PlayStateRead).id || '', (state as PlayStateRead).seed || '', (state as PlayStateRead).seed2 || '', player, targetMade)
    );

    // Size the attempt count so the make rate reads like a real game.
    let attempts;
    if (targetMade === 0) {
        attempts = 24 + Math.floor(rng() * 8); // 24..31, an all-miss round
    } else {
        attempts = Math.round(targetMade / TARGET_MAKE_RATE) + Math.floor((rng() - 0.5) * 6);
    }
    attempts = clamp(attempts, Math.max(targetMade, MIN_ATTEMPTS), MAX_ATTEMPTS);

    const shot = engine.buildShotLog({ totalAttempts: attempts, madeCount: targetMade, rng });
    const botScore = shot.madeActual; // == count of made flags in shot.replay
    const shotLog = shot.replay;

    const updates: PlayStateRead = {
        sender: (ctx as PlayContextRead).botUuid,
        ['player' + player]: (ctx as PlayContextRead).botUuid,
        ['avatar' + player]: (ctx as PlayContextRead).botAvatar,
        ['score' + player]: String(botScore),
        ['replay' + player]: shotLog,
        ['skip_score' + player]: '0',
        // Basketball KEEPS `player` = the slot that just moved (proven by real
        // card 102: gameplay card still carried player='2' = the mover's slot).
        player: String(player),
    };

    let botWon = null;
    if (oppShot && oppScoreVisible != null) {
        const flag = (botScore as number) > oppScoreVisible ? '1' : (botScore as number) < oppScoreVisible ? '-1' : '0';
        updates.winner = (ctx as PlayContextRead).botUuid + '|' + flag;
        botWon = flag === '1' ? true : flag === '-1' ? false : null;
    }

    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };

    // FIRST-MOVER HAND-BACK (Bot OPENS, opponent has NOT shot). Mirror the real
    // waiting-slot shape (card 102: waiting slot had NO playerN, no replayN, only a
    // leftover avatarN + scoreN=0) and the PROVEN anagrams/word-hunt fix: drop the
    // opponent's slot CLAIM so their GamePigeon lets them shoot their round. Keep
    // their (leftover) avatar and a 0 score. NOTE: not capture-verified for
    // basketball specifically - no recipient-opens card was captured.
    if (!oppShot) {
        delete newState['player' + opponent];
        delete newState['replay' + opponent];
        newState['score' + opponent] = '0';
        if (newState['skip_score' + opponent] == null) newState['skip_score' + opponent] = '0';
    }

    // INVITE -> GAMEPLAY rewrite. A basketball invite (card 100) carries
    // start/caption/game_name + version=5. Gameplay (card 102) drops all three and
    // stamps version=0 + num=2. seed/seed2/round/mode/tver/ios/build inherit
    // unchanged via the spread above (they are metadata / shared game params).
    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        delete newState.start;      // invite-only
        delete newState.caption;    // "Let's play Basketball!" - gameplay carries none
        delete newState.game_name;  // invite-only
        newState.version = '0';     // gameplay generation (invite: 5)
        newState.num = '2';         // second card in the session (invite: 1)
    } else {
        // Subsequent card (closing an opponent's opened round): advance num.
        newState.num = (state as PlayStateRead).num ? String(Number((state as PlayStateRead).num) + 1) : '2';
    }

    const replySummary =
        'basketball reply: slot=' + player + ' vs opp=' + opponent +
        ' ' + (oppShot ? 'CLOSE' : 'OPEN') +
        ' ref=' + ref + ' factor=' + (factor as number).toFixed(2) +
        ' score=' + botScore + '/' + attempts + 'att' +
        ' version=' + newState.version + ' num=' + newState.num +
        (newState.winner ? ' winner=' + newState.winner : ' (your-move)') +
        ' replay=' + shotLog.slice(0, 80) + (shotLog.length > 80 ? '...' : '');
    const mode =
        (oppShot ? 'close' : 'open') +
        ((factor as number) >= 1.25 ? ':ramp-up' : (factor as number) <= 0.7 ? ':ease-up' : ':match') +
        ' f=' + (factor as number).toFixed(2);
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_BASKETBALL_SEND!=1 | ' + replySummary,
        newState,
        botScore,
        botWords: attempts,     // "attempts" (reused field for watcher logs)
        mode,
        targetN: null,
        fullScore: attempts,     // total shots taken
        fullWords: botScore,    // makes (for logs)
        finishes: !!newState.winner,
        botWon,
        oppScore: oppScoreVisible,
        player,
        opponent,
    };
}

export const basketballPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    looksLikeBasketball,
};

