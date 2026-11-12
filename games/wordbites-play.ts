// games/wordbites-play.ts
import type { WordContextRead, WordDecision, WordDepsRead, WordSolveRead, WordAdaptiveRead, WordListRead, WordFactoryOptions } from './word-play-types.ts';
import type { PlayStateRead } from './play-types.ts';
import { wordbitesSolver as solver } from './wordbites-solver.ts';
import { rubberBand as rb } from './rubber-band.ts';
// =============================================================================
// Word Bites auto-play (game=wordbites) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'wordbites'
//   displayName : 'Word Bites'
//   solve(state, deps) -> { score, wordCount, sortedWords, ... } | null (skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// Word Bites shares the word-game slot/turn/winner model. The board is in the
// `level` field (`&`-joined "orientation|row|col|LETTERS" pieces). The solver is
// now APPROACH 2 - placement-aware geometry (see wordbites-solver.ts): it only
// keeps words that can actually be laid out with the pieces. Rubber-band is the
// SHARED policy in games/rubber-band.ts.
//
// ============================ VERIFICATION STATUS ============================
// Two former blockers are now FIXED:
//   * BLOCKER 1 (placement): the solver used to melt all pieces into a free
//     letter multiset and would "spell" UNPLACEABLE words (e.g. ABDITORY when the
//     only T is locked inside the horizontal block CT). It now runs a real
//     block-geometry tiling check and rejects unplaceable words.
//   * BLOCKER 2 (invite graft): the reply used to be `{...state}` + caption, so a
//     fresh-invite hand-back kept invite markers (start/game_name/bare player/
//     caption) and never flipped version/num. It now does the PROVEN Word
//     Hunt/Anagrams invite->gameplay rewrite (drop markers, version=0, num=2)
//     while KEEPING the invite's lang=en. gp_en2 is WORD-HUNT-ONLY; every Godot
//     word game (anagrams, word bites) tags lang=en and must NOT flip it.
// STILL UNVERIFIED - and the reason this module STILL DEFAULTS TO NOT SENDING:
//   * The SCORING TABLE is INFERRED. No real Word Bites GAMEPLAY card has ever
//     been captured (only the tester's one invite, ROWID 32936), so the points-per-word
//     table is a placeholder. Until a real capture pins it down, arming would send
//     a card whose score field could be wrong.
// decideMove decodes + solves (placement-correct) + encodes a well-formed move so
// the pipeline round-trips in dry-run, but returns action:'skip' unless
// WORDBITES_ENABLE_SEND is true. To arm after a real capture confirms scoring:
// wordbitesPlay({ enableSend: true }) OR set GP_WORDBITES_SEND=1.
// Word Hunt + Anagrams are untouched.
// ============================================================================

const GAME_ID = 'wordbites';
const DISPLAY_NAME = 'Word Bites';
// Default: DO NOT send Word Hunt-style cards until a real capture verifies the
// scoring table + placement handling. Overridable via env or factory option.
const ENABLE_SEND = process.env.GP_WORDBITES_SEND === '1';

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
// looksLikeWordBites(state) - fail-safe field validation.
// -----------------------------------------------------------------------------
function looksLikeWordBites(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    if (typeof (state as PlayStateRead).level !== 'string' || ((state as PlayStateRead).level as { length: unknown }).length === 0) return false;
    // level must parse into well-formed pieces
    return (solver.parseLevel((state as PlayStateRead).level) as WordSolveRead).ok;
}

// -----------------------------------------------------------------------------
// solve(state, deps) - deps = { dict }. Returns solve result or null (=> skip).
// -----------------------------------------------------------------------------
function solve(state: unknown, deps: unknown) {
    if (!looksLikeWordBites(state)) return null;
    const dict = deps && (deps as WordDepsRead).dict;
    if (!dict) return null;
    const result = solver.solveLevel((state as PlayStateRead).level, dict);
    if (!result.ok || result.wordCount === 0) return null;
    return result;
}

// -----------------------------------------------------------------------------
// Factory: allows enabling sends explicitly after verification.
//   wordbitesPlay                       -> object with ENABLE_SEND from env
//   wordbitesPlay({enableSend:true})    -> armed instance
// The default export is the module object itself (registry-compatible).
// -----------------------------------------------------------------------------
function makeModule(opts?: unknown) {
    const enableSend = (opts && typeof (opts as WordFactoryOptions).enableSend === 'boolean') ? (opts as WordFactoryOptions).enableSend : ENABLE_SEND;

    function decideMove(state: unknown, ctx: unknown, solveResult: unknown): WordDecision {
        if (!looksLikeWordBites(state)) return { action: 'ignore' };
        const rbState = (((ctx && (ctx as WordContextRead).rbState) || {}) as WordAdaptiveRead);

        // --- finished game: report result (watcher records W/L, sends nothing) --
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

        // --- Whose turn is it? Derive Bot's slot from SLOT OWNERSHIP (same fix
        // Word Hunt + Anagrams shipped), NOT the old `(!state.score2)?2:1` guess
        // that clobbered the opponent's slot-2 score. If Bot already owns a slot
        // on this non-finished card it already moved -> IGNORE. Otherwise Bot
        // takes the slot the opponent does NOT occupy; a bare invite's inviter is
        // player2, so Bot takes slot 1.
        if ((state as PlayStateRead).player1 === (ctx as WordContextRead).botUuid || (state as PlayStateRead).player2 === (ctx as WordContextRead).botUuid) {
            return { action: 'ignore' };
        }
        let opponent;
        if ((state as PlayStateRead).player1 && (state as PlayStateRead).player1 !== (ctx as WordContextRead).botUuid) opponent = 1;
        else if ((state as PlayStateRead).player2 && (state as PlayStateRead).player2 !== (ctx as WordContextRead).botUuid) opponent = 2;
        else if ((state as PlayStateRead).score1 != null && (state as PlayStateRead).score1 !== '') opponent = 1;
        else if ((state as PlayStateRead).score2 != null && (state as PlayStateRead).score2 !== '') opponent = 2;
        else opponent = 2; // bare invite: inviter is player2
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

        // FIRST-MOVER HAND-BACK FIX (2026-07-07): same fix Anagrams shipped after
        // the reported "user locked at 0" bug. When Bot moves first (fresh invite,
        // opponent has NOT scored), the opponent's slot MUST be left UNCLAIMED so
        // their GamePigeon lets them play their round. A real first-mover card
        // (chat.db ROWID 32886) slots the MOVER and leaves the other slot with NO
        // `playerN`; keeping the invite's `player<opponent>` = the user's uuid made
        // the user's client finalize them at 0 (ROWID 32941). Drop the opponent's
        // slot claim on a your-move hand-back; keep it (+ set winner) when they have
        // already scored (the finishing move).
        if (oppScoreVisible == null) {
            delete newState['player' + opponent];
            delete newState['score' + opponent];
            delete newState['words' + opponent];
            delete newState['words_list' + opponent];
            delete newState.player;
        }

        // INVITE -> GAMEPLAY rewrite (Blocker 2). The old code did `{...state}` +
        // caption only, so a fresh-invite reply kept the invite-only markers
        // (start/game_name/bare player/caption) and never flipped version/num
        // - a hybrid card GamePigeon rejects. Mirror the PROVEN Word Hunt/Anagrams
        // hand-back: drop every invite marker and stamp the Godot gameplay
        // generation (version=0, num=2) while KEEPING the invite's lang=en. Word
        // Bites is a Godot game like Anagrams, so it tags lang=en; gp_en2 is
        // WORD-HUNT-ONLY, and stamping it made the receiver load an empty dictionary
        // and reject every valid word "not in vocabulary" (the 2026-07-08 fix, same
        // pattern confirmed on Anagrams' real card). Scoring is still unverified
        // against a real Word Bites gameplay capture, so sending stays gated OFF.
        const wasInvite =
            ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
        if (wasInvite) {
            delete newState.start;      // invite-only
            delete newState.caption;    // "Let's play Word Bites!" - gameplay carries none
            delete newState.game_name;  // invite-only
            delete newState.player;     // invite-only bare slot claim
            newState.version = '0';     // gameplay generation (invite: 5)
            // KEEP the invite's lang = 'en'. Word Bites (like every Godot word game)
            // tags 'en' on the wire: OpenPigeon's WordBites Kotlin does put("lang","en")
            // and Game.kt does NOT flip it; gp_en2 is WORD-HUNT-ONLY. Sending gp_en2
            // made the receiver's client load an empty dictionary, so EVERY valid word
            // the human typed was rejected "not in vocabulary" while Bot's directly-
            // written score still counted (same bug fixed on Anagrams' real card, 2026-07-08).
            newState.lang = 'en';       // gameplay dictionary tag (invite: en) - unchanged
            newState.num = '2';         // second card in the session (invite: 1)
        } else {
            newState.caption = getSubtitle(newState, (ctx as WordContextRead).botUuid);
        }

        // FAIL-SAFE: the SCORING table is still INFERRED (no real Word Bites
        // gameplay capture has ever pinned it down). Placement is now correct
        // (Approach 2 geometry), but scoring is not - so this STILL gates OFF.
        // Encode a valid move so the pipeline round-trips in dry-run; the watcher
        // SKIPs the real send unless GP_WORDBITES_SEND=1.
        const replySummary =
            'wordbites reply: slot=' + player + ' vs opp=' + opponent +
            ' score=' + botScore + ' words=' + botWords +
            ' version=' + newState.version + ' lang=' + newState.lang + ' num=' + newState.num +
            (newState.winner ? ' winner=' + newState.winner : ' (your-move)') +
            ' words_list=' + (updates['words_list' + player] || '');
        const action = enableSend ? 'play' : 'skip';
        return {
            action,
            reason: enableSend ? undefined
                : 'GP_WORDBITES_SEND!=1 (scoring table still INFERRED - placement now geometry-correct) | ' + replySummary,
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

    return {
        game: GAME_ID,
        displayName: DISPLAY_NAME,
        enableSend,
        solve,
        decideMove,
        getSubtitle,
        looksLikeWordBites,
    };
}

// Export the default (env-driven) module object, and allow calling as a factory.
const defaultModule = makeModule();
export const wordbitesPlay = Object.assign(
    function (opts: unknown) { return makeModule(opts); },
    defaultModule
);

