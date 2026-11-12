// games/anagrams-play.ts
import type { WordContextRead, WordDecision, WordDepsRead, WordSolveRead, WordAdaptiveRead, WordListRead } from './word-play-types.ts';
import type { PlayStateRead } from './play-types.ts';
import { anagramsSolver as solver } from './anagrams-solver.ts';
import { rubberBand as rb } from './rubber-band.ts';
// =============================================================================
// Anagrams auto-play (game=anagrams) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'anagrams'
//   displayName : 'Anagrams'
//   solve(state, deps) -> { score, wordCount, sortedWords } | null (null = skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// Anagrams shares Word Hunt's slot/turn/winner model exactly (first mover fills
// slot 2, replier fills slot 1, winner set when both slots present). The only
// differences from Word Hunt are (a) the solver is a multiset rack solve, not a
// board DFS, and (b) the scoring table (100/400/1200/2000/3000). The rubber-band
// handicap is the SHARED policy in games/rubber-band.ts.
//
// ============================ VERIFICATION STATUS ============================
// Built from OpenPigeon SOURCE (anagrams/AnagramsGame.kt + anagrams/anagrams.gd +
// anagrams/game_screen.gd, `wordhunt` branch), now CONFIRMED against a REAL captured
// Anagrams card (the tester's a test line CSNEIT session, 2026-07-08): the gameplay lang stays
// "en" - the earlier gp_en2 assumption was wrong and broke word validation.
// FAIL-SAFE: solve() returns null (=> watcher skips, sends nothing) if the decoded
// state does not look like a well-formed Anagrams card. Word Hunt is untouched.
//
// AUTHORITATIVE FIELD MODEL (from AnagramsGame.kt + anagrams.gd debug_state):
//   - version : INVITE = "5" (getVersion), GAMEPLAY = "0"  (anagrams.gd sends
//               version=0 like the other Godot games - mirrors the real hunt
//               47->0 flip captured on-device).
//   - lang    : "en" on BOTH invite AND gameplay. AnagramsGame.kt sets
//               put("lang","en") and Game.kt does NOT flip it. gp_en2 is
//               WORD-HUNT-ONLY; anagrams does NOT share Word Hunt's tag. Sending
//               gp_en2 makes the receiver's client load an empty dictionary and
//               reject every valid rack word (the 2026-07-08 "not in vocabulary" bug).
//   - mode    : "6 Letters" | "7 Letters" (NOT a bare 6/7). Rack is 6 OR 7 chars.
//   - wire    : score1/2, words1/2, words_list1/2 (pipe-joined), winner - SAME
//               word-game model as Word Hunt (anagrams.gd:send_game).
//   - scoring : 100/400/1200/2000/3000 (game_screen.gd:_get_word_score) - already
//               in anagrams-solver.ts.
// The invite->gameplay rewrite below drops start/caption/game_name/player and sets
// version=0 while KEEPING lang=en (Word Hunt flips to gp_en2; anagrams must NOT).
// ============================================================================

const GAME_ID = 'anagrams';
const DISPLAY_NAME = 'Anagrams';
// GamePigeon Anagrams rack is 6 OR 7 letters (AnagramsGame.mode = "6 Letters" /
// "7 Letters"). Accept exactly that band; reject obviously-wrong cards.
const MIN_RACK = 6;
const MAX_RACK = 7;

// Env gate (mirrors wordbites GP_WORDBITES_SEND). Until '1', decideMove's play
// path returns action:'skip' (decode+solve+encode still round-trip in dry-run,
// but nothing is sent). Staged 2026-07-07 for the tester's supervised live test.
const ENABLE_SEND = process.env.GP_ANAGRAMS_SEND === '1';

// -----------------------------------------------------------------------------
// getSubtitle(msg, myUuid) - identical convention to Word Hunt (winner flag rel.
// to sender). Duplicated here (tiny) so anagrams-play has no cross-game import.
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
// looksLikeAnagrams(state) - fail-safe field validation. Returns true only if
// the decoded card matches the expected Anagrams shape.
// -----------------------------------------------------------------------------
function looksLikeAnagrams(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    const rack = (state as PlayStateRead).letters;
    if (typeof rack !== 'string' || rack.length < MIN_RACK || rack.length > MAX_RACK) return false;
    // rack must be pure letters
    if (!/^[A-Za-z]+$/.test(rack)) return false;
    return true;
}

// -----------------------------------------------------------------------------
// solve(state, deps) - deps = { dict }. Returns the full rack solve, or null to
// signal the watcher to SKIP this card (fail-safe).
// -----------------------------------------------------------------------------
function solve(state: unknown, deps: unknown) {
    if (!looksLikeAnagrams(state)) return null;
    const dict = deps && (deps as WordDepsRead).dict;
    if (!dict) return null;
    const result = solver.solveRack((state as PlayStateRead).letters, dict);
    // If we found nothing spellable, something is off with the rack/dict - skip
    // rather than submit an empty move.
    if (!result || result.wordCount === 0) return null;
    return result;
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solveResult) - same shape as wordhunt-play.decideMove.
//   ctx = { botUuid, botAvatar, rbState }
// Returns { action:'ignore' | 'result' | 'play', ... }.
// -----------------------------------------------------------------------------
function decideMove(state: unknown, ctx: unknown, solveResult: unknown): WordDecision {
    if (!looksLikeAnagrams(state)) return { action: 'ignore' };
    const rbState = (((ctx && (ctx as WordContextRead).rbState) || {}) as WordAdaptiveRead);

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
            const senderIsBot = ((state as PlayStateRead).sender === (ctx as WordContextRead).botUuid);
            botWon = senderIsBot ? senderWon : !senderWon;
        }
        const s1 = (state as PlayStateRead).score1 != null && (state as PlayStateRead).score1 !== '' ? Number((state as PlayStateRead).score1) : null;
        const s2 = (state as PlayStateRead).score2 != null && (state as PlayStateRead).score2 !== '' ? Number((state as PlayStateRead).score2) : null;
        let botScore = null;
        let oppScore = null;
        if ((state as PlayStateRead).player1 === (ctx as WordContextRead).botUuid) { botScore = s1; oppScore = s2; }
        else if ((state as PlayStateRead).player2 === (ctx as WordContextRead).botUuid) { botScore = s2; oppScore = s1; }
        else { oppScore = s2 != null ? s2 : s1; }
        return { action: 'result', winner: wUuid, flag, botWon, botScore, oppScore };
    }

    if (!solveResult) return { action: 'ignore' };

    // --- Whose turn is it? Derive Bot's slot from SLOT OWNERSHIP, not a fixed
    // assumption (same fix Word Hunt shipped). If Bot already owns a slot on this
    // non-finished card it already moved -> IGNORE. Otherwise Bot takes the slot
    // the opponent does NOT occupy; on a bare invite the inviter is player2, so
    // Bot takes slot 1.
    if ((state as PlayStateRead).player1 === (ctx as WordContextRead).botUuid || (state as PlayStateRead).player2 === (ctx as WordContextRead).botUuid) {
        return { action: 'ignore' };
    }
    let opponent;
    if ((state as PlayStateRead).player1 && (state as PlayStateRead).player1 !== (ctx as WordContextRead).botUuid) opponent = 1;
    else if ((state as PlayStateRead).player2 && (state as PlayStateRead).player2 !== (ctx as WordContextRead).botUuid) opponent = 2;
    else if ((state as PlayStateRead).score1 != null && (state as PlayStateRead).score1 !== '') opponent = 1;
    else if ((state as PlayStateRead).score2 != null && (state as PlayStateRead).score2 !== '') opponent = 2;
    else opponent = 2; // bare invite: inviter is player2 (Game.kt getNewGameData)
    const player = opponent === 1 ? 2 : 1;

    const oppWordsRaw = (state as PlayStateRead)['words' + opponent];
    const userWordsThisGame =
        oppWordsRaw != null && oppWordsRaw !== '' ? Number(oppWordsRaw) : null;
    const oppScoreRaw = (state as PlayStateRead)['score' + opponent];
    const oppScoreVisible =
        oppScoreRaw != null && oppScoreRaw !== '' ? Number(oppScoreRaw) : null;

    const sub = rb.chooseSubmission(({
        rbState,
        sortedWords: (solveResult as WordSolveRead).sortedWords,
        wordCount: (solveResult as WordSolveRead).wordCount,
        oppScoreVisible,
        userWordsThisGame,
        scoreForWord: solver.scoreForWord,
        gameId: GAME_ID,
    } as Parameters<typeof rb.chooseSubmission>[0]));

    const botScore = sub.score;
    const botWords = (sub.words as WordListRead).length;

    const updates: PlayStateRead = {
        sender: (ctx as WordContextRead).botUuid,
        ['player' + player]: (ctx as WordContextRead).botUuid,
        ['avatar' + player]: (ctx as WordContextRead).botAvatar,
        ['score' + player]: String(botScore),
        ['words' + player]: String(botWords),
        ['words_list' + player]: (sub.words as WordListRead).join('|'),
    };

    if (oppScoreVisible != null) {
        updates.winner =
            (ctx as WordContextRead).botUuid + '|' + ((botScore as number) < oppScoreVisible ? '-1' : (botScore as number) > oppScoreVisible ? '1' : '0');
    }

    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };
    if (newState.player2 !== (ctx as WordContextRead).botUuid && !newState.player1) {
        newState.player1 = (ctx as WordContextRead).botUuid;
    }

    // FIRST-MOVER HAND-BACK FIX (2026-07-07): when Bot moves first (fresh invite,
    // opponent has NOT scored yet), the opponent's slot MUST be left UNCLAIMED so
    // their GamePigeon lets them play their round. The real first-mover card proves
    // this: a genuine "I moved, your turn" card (chat.db ROWID 32886, Word Hunt)
    // slots the MOVER with player+score and leaves the OTHER slot with NO `playerN`
    // (only a leftover avatar). The old code KEPT the invite's `player<opponent>`
    // = the user's uuid in the empty slot, so the user's client saw itself already
    // slotted-but-scoreless on a num=2 card where player1 had scored and FINALIZED
    // it at 0 (chat.db ROWID 32941: score2=0, winner=user|-1 - the reported bug).
    // Mirror the real first-mover card: drop the opponent's slot claim entirely.
    // When the opponent HAS already scored (oppScoreVisible != null) this is the
    // finishing move, their slot is real, and we KEEP it + set the winner above.
    if (oppScoreVisible == null) {
        delete newState['player' + opponent];
        delete newState['score' + opponent];
        delete newState['words' + opponent];
        delete newState['words_list' + opponent];
        // `player` (the bare invite slot claim) is also dropped in the invite
        // rewrite below; a non-invite fresh card gets it cleared here too so the
        // hand-back never carries a stale bare slot claim.
        delete newState.player;
    }

    // Was the inbound a FRESH INVITE? (v5 "Let's play Anagrams!" generation.) Its
    // markers never appear on gameplay cards.
    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        // INVITE -> GAMEPLAY rewrite (AUTHORITATIVE, from AnagramsGame.kt +
        // anagrams.gd version=0; lang stays 'en', NO en->gp_en2 flip). Drop every
        // invite-only marker, stamp the gameplay generation. A first-move card
        // carries no inner caption (Your Move. is the outer breadcrumb).
        delete newState.start;      // invite-only
        delete newState.caption;    // "Let's play Anagrams!" - gameplay carries none
        delete newState.game_name;  // invite-only
        delete newState.player;     // invite-only bare slot claim
        newState.version = '0';     // gameplay generation (invite: 5)
        // KEEP the invite's lang = 'en'. Real Anagrams (like every Godot word game)
        // tags 'en'; gp_en2 is WORD-HUNT-ONLY. Sending gp_en2 made the receiver's
        // client load an empty dictionary, so EVERY valid rack word ("ten", "net")
        // was rejected "not in vocabulary" while Bot's directly-written score still
        // counted (2026-07-08 fix, confirmed on the tester's real CSNEIT card).
        newState.lang = 'en';       // gameplay dictionary tag (invite: en) - unchanged
        newState.num = '2';         // second card in the session (invite: 1)
    } else {
        newState.caption = getSubtitle(newState, (ctx as WordContextRead).botUuid);
    }

    // FAIL-SAFE env gate. Until GP_ANAGRAMS_SEND=1, encode a valid move so the
    // pipeline round-trips in dry-run, but tell the watcher to SKIP the real send.
    // The reason string embeds the full built-reply summary for observe-mode logs.
    const replySummary =
        'anagrams reply: slot=' + player + ' vs opp=' + opponent +
        ' score=' + botScore + ' words=' + botWords +
        ' rack=' + ((state as PlayStateRead).letters || '?') +
        ' version=' + newState.version + ' lang=' + newState.lang +
        ' num=' + newState.num +
        (newState.winner ? ' winner=' + newState.winner : ' (your-move)') +
        ' words_list=' + (updates['words_list' + player] || '');
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_ANAGRAMS_SEND!=1 | ' + replySummary,
        newState,
        botScore,
        botWords,
        mode: sub.mode,
        targetN: sub.targetN,
        fullScore: (solveResult as WordSolveRead).score,
        fullWords: (solveResult as WordSolveRead).wordCount,
        player,
        opponent,
    };
}

export const anagramsPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    looksLikeAnagrams,
};

