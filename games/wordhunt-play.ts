// games/wordhunt-play.ts
import type { WordContextRead, WordDecision, WordSolveRead, WordAdaptiveRead, WordListRead } from './word-play-types.ts';
import type { PlayStateRead } from './play-types.ts';
import { rubberBand as rb } from './rubber-band.ts';
// =============================================================================
// Word Hunt auto-play decision logic (pure, no I/O)
// =============================================================================
//
// Given a decoded inbound GamePigeon Word Hunt state map and a precomputed
// solve result, decide what Bot should do next:
//   - ignore : not a Word Hunt card
//   - play   : it's Bot's turn; returns the new state map to re-encode + send
//              a HANDICAPPED move (rubber-banded per opponent)
//   - result : the game is already finished; the watcher just records W/L for
//              the rubber-band and logs it. NO text is ever sent.
//
// This is a faithful port of OpenPigeon's WordHuntActivity.endGame() slot logic
// (github.com/OpenBubbles/openpigeon, wordhunt branch). No timers, no network,
// no DB - the watcher (watcher.ts) supplies the decoded state, the
// full solve result, and the per-user rubber-band state, and performs all the
// actual sending + persistence.
//
// State map slot model (from real captured cards):
//   fresh invite   -> v47 markers, opp slot claimed, NO scores (Bot plays the
//                     FREE slot immediately - instant hand-back, no winner,
//                     rebuilt as a true v0 gameplay card)
//   opp played     -> opp slot has a score, no winner          (Bot plays the
//                     free slot, sets winner)
//   finished       -> winner="<uuid>|<flag>"                   (record only)
//
// `winner` flag semantics (from getSubtitle): the flag is relative to the SENDER
// of the card. "-1" => sender lost, "1" => sender won, "0" => draw. When Bot
// sends a card, state.sender = botUuid, so the caption is written from Bot's
// point of view.
//
// RUBBER-BAND HANDICAP: Bot always SOLVES the full board internally, then trims
// what it SUBMITS to hit a PROPORTIONAL SCORE TARGET: `ref * factor * jitter`,
// capped to this board. ref is BOARD-RELATIVE: because Bot solves the whole
// board it knows solve.score (the max achievable on this seed), so ref is a
// FRACTION of that total - the opponent's score when it's visible, else (Bot
// opening a fresh invite with no opponent score) HUMAN_FIND_FRACTION of findable.
// A rich seed therefore yields a high target and a barren seed a low one
// automatically; the old flat default sandbagged Bot on rich boards and overshot
// on barren ones.
// factor is the handicap multiplier, and jitter is a deterministic -10%..+10%
// wobble. From that target Bot builds a NATURAL HUMAN PORTFOLIO of words (mostly
// short/medium with a few long, a plausible count ~10-30), NOT the three monster
// words the old biggest-first picker produced. ADAPTIVE (default) self-tunes the
// factor toward ~50% wins; fixed difficulties use a fixed multiplier. The hard
// logic (word portfolio + reference) is imported from games/rubber-band.ts so
// there is ONE source of truth; only the trivial difficulty/jitter mirror below
// stays local to this verified path. See decideMove().
// =============================================================================

const GAME_ID = 'hunt';

// Minimum words Bot will ever submit.
const MIN_WORDS = 3;

// Adaptive self-tuning knobs (score-multiplier space). Only ADAPTIVE_MIN/MAX are
// used locally (the inline handicapFactor clamp); ADAPTIVE_START seeds legacy
// records. ADAPTIVE_STEP and the stepper live in the shared module.
const ADAPTIVE_MIN = 0.80;     // floor: even eased all the way down Bot stays a real opponent, never dog-ass (mirror rubber-band)
const ADAPTIVE_MAX = 1.30;     // ceiling: Bot never pushes above this multiplier
const ADAPTIVE_START = 1.00;   // seed factor for a fresh/unknown adaptive record: a fair start (mirror rubber-band)
const DEFAULT_USER_SCORE = 4000; // legacy fallback only (Word Hunt now targets a fraction of solve.score)
const WORD_DIFFICULTY_FACTOR: Record<PropertyKey, unknown> = { chill: 0.82, match: 1.00, sweat: 1.10 };

// Per-opponent difficulty override. Word Hunt keeps its own decideMove (the LIVE,
// verified turn/slot/winner path), but the HARD handicap logic - the word
// portfolio and the demonstrated-skill reference - is IMPORTED from
// games/rubber-band.ts (rb.pickHumanPortfolio / rb.referenceScore) so there
// is ONE source of truth. Only the trivial DIFFICULTY_FACTOR map + inline
// handicapFactor + jitter formula are mirrored here; KEEP those in sync with the
// shared module. The self-tuning updateAdaptiveState is NOT duplicated here; it
// lives ONCE in rubber-band.ts and the watcher calls it.
//   'adaptive'/unset -> the self-tuning score target (seeded from legacy records).
//   'chill'|'match'|'sweat' -> fixed score multiplier (flows through handicapFactor).
//   'max' -> submit the ENTIRE solve, bypassing the trim (flawless).
const DIFFICULTY_FACTOR: Record<PropertyKey, unknown> = {
    chill: 0.45, // clearly under the user
    match: 1.00, // roughly even
    sweat: 1.30, // wins but doesn't obliterate
    max: 3.00,   // effectively "as good as possible"
};

function clamp(x: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, x));
}

// Seed an adaptive factor from a legacy on-disk record (pre-adaptive fields) so
// nothing needs migrating. MIRRORS seedFromLegacy in games/rubber-band.ts.
function seedFromLegacy(s: unknown) {
    const state = s || {};
    if ((state as WordAdaptiveRead).lastBotResult === 'W') return 0.80;
    if ((state as WordAdaptiveRead).lastBotResult === 'L') return 1.10;
    return ADAPTIVE_START;
}

// -----------------------------------------------------------------------------
// getSubtitle(msg, myUuid) - the caption shown under the card.
// Faithful port of OpenPigeon getSubtitle(). Computed from the SENDER's POV:
// when Bot sends, msg.sender === myUuid, so "I won!"/"You Won!" read correctly
// for the recipient's screen vs Bot's.
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
// handicapFactor(rbState) -> score multiplier.
// A fixed difficulty (chill/match/sweat/max) overrides the adaptive tuning; an
// unset or 'adaptive' difficulty uses the self-tuned factor (seeded from a legacy
// record on first read), clamped to the adaptive band. MIRRORS the shared module.
// -----------------------------------------------------------------------------
function handicapFactor(rbState: unknown): unknown {
    const state = rbState || {};
    const diff = (state as WordAdaptiveRead).difficulty;
    if (diff && diff !== 'adaptive' && DIFFICULTY_FACTOR[(diff as PropertyKey)] != null) {
        return DIFFICULTY_FACTOR[(diff as PropertyKey)];                  // fixed difficulty overrides the tuning
    }
    const gamesPlayed = (state as WordAdaptiveRead).gamesPlayed || 0;
    if (gamesPlayed === 0) return ADAPTIVE_START;        // first game: a fair start (mirror rubber-band; was 1.30, Bot came out strong)
    return clamp(
        ((state as WordAdaptiveRead).adaptiveFactor != null ? (state as WordAdaptiveRead).adaptiveFactor : seedFromLegacy(state)) as number,
        ADAPTIVE_MIN,
        ADAPTIVE_MAX
    );
}

// -----------------------------------------------------------------------------
// pickTopByScore(sortedWords, targetScore) -> { words, score }
// LEGACY greedy selector, kept only for the module's exported surface. The live
// decision path now uses rb.pickHumanPortfolio (natural human mix). Walk the
// score-sorted words high -> low, take each that fits under target, pad to
// MIN_WORDS. (The even-older version force-took the biggest MIN_WORDS first,
// which is what produced the 3-monster-word look this fix removed.)
// -----------------------------------------------------------------------------
function pickTopByScore(sortedWords: unknown, targetScore: number) {
    const words: unknown[] = [];
    let score = 0;
    for (let i = 0; i < (sortedWords as unknown[]).length; i++) {
        const w = (sortedWords as unknown[])[i];
        const ws = scoreForWord(w);
        if (score + ws <= targetScore) {
            words.push(w);
            score += ws;
        }
    }
    if (words.length < MIN_WORDS) {
        const chosen = new Set(words);
        for (let i = (sortedWords as unknown[]).length - 1; i >= 0 && words.length < MIN_WORDS; i--) {
            const w = (sortedWords as unknown[])[i];
            if (!chosen.has(w)) {
                chosen.add(w);
                words.push(w);
                score += scoreForWord(w);
            }
        }
    }
    return { words, score };
}

// -----------------------------------------------------------------------------
// resolveFinishedScores(state, botUuid) -> { botScore, oppScore } for a
// finished card, using whichever slot is Bot's. Shared by the finished path.
// -----------------------------------------------------------------------------
function resolveFinishedScores(state: unknown, botUuid: unknown) {
    const s1 = (state as PlayStateRead).score1 != null && (state as PlayStateRead).score1 !== '' ? Number((state as PlayStateRead).score1) : null;
    const s2 = (state as PlayStateRead).score2 != null && (state as PlayStateRead).score2 !== '' ? Number((state as PlayStateRead).score2) : null;
    if ((state as PlayStateRead).player1 === botUuid) return { botScore: s1, oppScore: s2 };
    if ((state as PlayStateRead).player2 === botUuid) return { botScore: s2, oppScore: s1 };
    // Bot isn't recorded as a player on this finished card (historical game we
    // never joined). Best-effort: opponent = whichever score exists.
    return { botScore: null, oppScore: s2 != null ? s2 : s1 };
}

// -----------------------------------------------------------------------------
// GamePigeon length-based scoring: 3->100, 4->400, 5->800, 6->1400, 7->1800,
// 8+->2200. Used to total the handicapped word set.
// -----------------------------------------------------------------------------
const WORD_SCORES: Record<number, number> = { 3: 100, 4: 400, 5: 800, 6: 1400, 7: 1800 };
function scoreForWord(word: unknown) {
    const len = String(word).length;
    if (len < 3) return 0;
    if (len >= 8) return 2200;
    return WORD_SCORES[len] || 0;
}
function sumWordScores(words: unknown) {
    let total = 0;
    for (const w of (words as Iterable<unknown>)) total += scoreForWord(w);
    return total;
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solve)
//   state = decoded inbound state map (strings)
//   ctx   = { botUuid, botAvatar, rbState } - rbState is the per-opponent
//           rubber-band record { gamesPlayed, userLastWords, lastBotResult }
//   solve = { score, wordCount, sortedWords: [word, ...] }  (FULL solve, sorted
//           highest-score-first; decideMove trims what Bot actually submits)
// Returns one of:
//   { action: 'ignore' }
//   { action: 'play',   newState, botScore, botWords, mode, targetN,
//                        fullScore, fullWords }
//   { action: 'result', winner, flag, botWon, botScore, oppScore }  (NO text)
// -----------------------------------------------------------------------------
function decideMove(state: unknown, ctx: unknown, solve: unknown): WordDecision {
    if (!state || (state as PlayStateRead).game !== 'hunt') return { action: 'ignore' };
    const rbState = (((ctx && (ctx as WordContextRead).rbState) || {}) as WordAdaptiveRead);

    // --- game already finished: record W/L for the rubber-band, send nothing --
    if ((state as PlayStateRead).winner) {
        const parts = String((state as PlayStateRead).winner).split('|');
        const wUuid = parts[0];
        const flag = parts[1];
        let botWon;
        if (flag === '0') {
            botWon = null; // draw
        } else {
            // flag is relative to the card's sender: '1' => sender won, '-1' => sender lost.
            const senderWon = flag === '1';
            const senderIsBot = ((state as PlayStateRead).sender === (ctx as WordContextRead).botUuid);
            // Bot won iff (Bot is sender AND sender won) OR (Bot not sender AND sender lost)
            botWon = senderIsBot ? senderWon : !senderWon;
        }
        const { botScore, oppScore } = resolveFinishedScores(state, (ctx as WordContextRead).botUuid);
        return {
            action: 'result',
            winner: wUuid,
            flag: flag,
            botWon: botWon,
            botScore: botScore,
            oppScore: oppScore,
        };
    }

    // --- Whose turn is it? Derive Bot's slot from SLOT OWNERSHIP, not a fixed
    // assumption. In real captured cards the opponent can occupy EITHER slot
    // (observed: the inviter is player2, e.g. The tester=player2 score2=7800). The old
    // `player = (!state.score2) ? 2 : 1` clobbered the opponent's slot 2 on an
    // invite that had no score yet AND made Bot play the same board twice (once
    // wrongly as p2, once correctly as p1) - the Issue A double-send. Rules:
    //   1. If Bot already owns a slot on this card, Bot already moved -> IGNORE
    //      (this is the opponent's / an echoed card, not a fresh turn).
    //   2. Bot takes the slot the OPPONENT does NOT occupy.
    //   3. A card with a VISIBLE opponent score -> answer it (play + set winner).
    //   4. A FRESH INVITE (v47 markers, no scores) -> play it IMMEDIATELY and hand
    //      back ONE clean "Your Move." card, REBUILT as a true v0 gameplay card
    //      (see the invite-rebuild block below). The instant hand-back.
    //
    // HISTORY (2026-07-07): the first fast hand-back grafted Bot's move onto the
    // v47 INVITE shell (kept `start`, `game_name`, bare `player`, version=47,
    // lang=en) - a hybrid real GamePigeon never generates, so its extension
    // refused the card and Messages showed "update GamePigeon". Real captures
    // (a test line sms.db) show invite and gameplay cards are DIFFERENT generations:
    //   invite (rowid 53): version=47 lang=en     num=1 + start/game_name/player/caption
    //   played (rowid 55): version=0  lang=gp_en2 num=2, NONE of those markers
    // The rebuild below emits the rowid-55 generation - the same inner shape as
    // Bot's long-proven scored replies (which open and play fine on-device).
    const botInP1 = (state as PlayStateRead).player1 === (ctx as WordContextRead).botUuid;
    const botInP2 = (state as PlayStateRead).player2 === (ctx as WordContextRead).botUuid;
    if (botInP1 || botInP2) {
        // Bot already has a slot on this (non-finished) card. It already played
        // this game; do not play again. (A finished card would have hit the
        // winner branch above; this guards the mid-game echo / duplicate.)
        return { action: 'ignore' };
    }

    // The opponent occupies whichever slot their uuid is in; if neither slot names
    // them yet (a bare invite), fall back to the slot that carries a score.
    let opponent;
    if ((state as PlayStateRead).player1 && (state as PlayStateRead).player1 !== (ctx as WordContextRead).botUuid) opponent = 1;
    else if ((state as PlayStateRead).player2 && (state as PlayStateRead).player2 !== (ctx as WordContextRead).botUuid) opponent = 2;
    else if ((state as PlayStateRead).score1 != null && (state as PlayStateRead).score1 !== '') opponent = 1;
    else if ((state as PlayStateRead).score2 != null && (state as PlayStateRead).score2 !== '') opponent = 2;
    else {
        // No opponent slot and no score anywhere - nothing to respond to yet.
        return { action: 'ignore' };
    }
    const player = opponent === 1 ? 2 : 1;

    // Board letters - used both for the dedup guard below and returned to the
    // watcher so it can stamp rbState.lastPlayedBoard.
    const boardId = (state as PlayStateRead).letters || (state as PlayStateRead).level || null;

    // The opponent's SCORE in THIS game (visible => Bot answers it and finishes
    // the game with a winner).
    const oppScoreRaw = (state as PlayStateRead)['score' + opponent];
    const oppScoreVisible =
        oppScoreRaw != null && oppScoreRaw !== '' ? Number(oppScoreRaw) : null;

    // FRESH INVITE = the v47 "Let's play Word Hunt!" generation. Its markers
    // (`start`, `game_name`) never appear on gameplay cards (real captures rowids
    // 38/53/58/62/74 vs 50/55/59/63/75). Bot plays an unscored card ONLY when it
    // is a real invite; an unscored NON-invite card is some other mid-game state
    // we don't recognize - wait rather than guess.
    const isFreshInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '47';
    if (oppScoreVisible == null && !isFreshInvite) {
        return { action: 'ignore' };
    }

    // Dedup guard: once Bot has played a board, an echoed card for the SAME board
    // where Bot is not slotted (a duplicate delivery of the opponent's move) must
    // not trigger a second play. `lastPlayedBoard` is stamped by the watcher after
    // every play; match on the board letters.
    if (boardId && rbState.lastPlayedBoard && rbState.lastPlayedBoard === boardId) {
        return { action: 'ignore' };
    }

    const fullSorted = (solve as WordSolveRead).sortedWords || [];

    // Handicap selection:
    //   MAX difficulty -> submit the ENTIRE solve, no trim (flawless)
    //   otherwise      -> proportional SCORE TARGET: ref * factor * jitter, where
    //                     ref is the opponent's score this game (if visible) else
    //                     their tracked average else a default. Bot submits its
    //                     top words in score order up to that target.
    let chosen: unknown;
    let mode;
    let targetN = null;
    if (rbState.difficulty === 'max') {
        chosen = (fullSorted as unknown[]).slice();
        mode = 'max:full-solve';
        targetN = (chosen as WordListRead).length;
    } else {
        const factor = WORD_DIFFICULTY_FACTOR[(rbState.difficulty as PropertyKey)] != null
            ? WORD_DIFFICULTY_FACTOR[(rbState.difficulty as PropertyKey)]
            : handicapFactor(rbState);
        const gamesPlayed = rbState.gamesPlayed || 0;
        // BOARD-RELATIVE reference: Bot solved the whole board, so solve.score is
        // the max achievable on THIS seed. The target is a FRACTION of that total
        // (rich board -> high, barren board -> low, automatically), tracking the
        // opponent's score when it's visible. On a fresh invite (no opponent score
        // anywhere) this replaces the old flat default, which sandbagged Bot on
        // rich boards and overshot on barren ones.
        const boardFindable = (solve as WordSolveRead).score;
        const ref = rb.referenceScore(rbState, ({
            gameId: 'hunt',
            oppScoreVisible,
            defaultUserScore: DEFAULT_USER_SCORE,
            boardFindable,
        } as Parameters<typeof rb.referenceScore>[1]));
        // Deterministic -10%..+10% jitter. 5 is coprime with 21 so (gamesPlayed*5)%21
        // spans the full residue set (the old *7 only yielded {0,7,14}).
        const jitter = rb.targetJitter(rbState, gamesPlayed, GAME_ID);
        // Cap the target to this board (never above ~85% of findable, never above
        // findable) so Bot never looks like it solved the whole board.
        const target = rb.boardCappedTarget((ref as number) * (factor as number) * (jitter as number), (boardFindable as number));
        // Natural human portfolio (many short/medium + a few long) summing to the
        // target, not biggest-first-to-target. Deterministic per board/state.
        const seed = rb.hashSeed(gamesPlayed, Math.round((target as number)), (fullSorted as unknown[]).length, (fullSorted as unknown[])[0] || '');
        chosen = rb.pickHumanPortfolio((fullSorted as unknown[]), target as number, scoreForWord, seed).words;
        mode = oppScoreVisible == null ? 'score-target:invite-hand-back' : 'score-target';
    }

    const botScore = sumWordScores(chosen);
    const botWords = (chosen as WordListRead).length;

    const updates: PlayStateRead = {
        sender: (ctx as WordContextRead).botUuid,
        ['player' + player]: (ctx as WordContextRead).botUuid,
        ['avatar' + player]: (ctx as WordContextRead).botAvatar,
        ['score' + player]: String(botScore),
        ['words' + player]: String(botWords),
        ['words_list' + player]: (chosen as WordListRead).join('|'),
    };

    if (oppScoreVisible != null) {
        updates.winner =
            (ctx as WordContextRead).botUuid + '|' + ((botScore as number) < oppScoreVisible ? '-1' : (botScore as number) > oppScoreVisible ? '1' : '0');
    }

    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };
    if (newState.player2 !== (ctx as WordContextRead).botUuid && !newState.player1) {
        newState.player1 = (ctx as WordContextRead).botUuid;
    }

    if (oppScoreVisible == null) {
        // FRESH-INVITE REBUILD: convert the v47 invite shell into the TRUE v0
        // gameplay generation before it goes back out (modeled key-for-key on the
        // real captured first-move card, a test line rowid 55). The previous fast
        // hand-back skipped this and GamePigeon refused the hybrid ("update
        // GamePigeon"). Drop every invite-only marker; stamp the gameplay
        // generation. NO winner and NO inner caption on a first-move card (the
        // outer breadcrumb still says "Your Move." - runPlay's fallback).
        delete newState.start;      // invite-only
        delete newState.game_name;  // invite-only
        delete newState.player;     // invite-only bare slot claim
        delete newState.caption;    // "Let's play Word Hunt!" - v0 cards carry none
        newState.version = '0';     // gameplay generation (invite: 47)
        newState.lang = 'gp_en2';   // gameplay dictionary tag (invite: en)
        newState.num = '2';         // second card in the session (invite: 1)
    } else {
        newState.caption = getSubtitle(newState, (ctx as WordContextRead).botUuid);
    }

    return {
        action: 'play',
        newState,
        botScore,
        botWords,
        mode,
        targetN,
        fullScore: (solve as WordSolveRead).score,
        fullWords: (solve as WordSolveRead).wordCount,
        // The slots decideMove actually chose (Bot's slot + the opponent's), so the
        // watcher records the rubber-band against the SAME slots instead of
        // recomputing them from a fixed assumption (which drifted after the
        // slot-ownership fix). See gamepigeon-watcher runPlay.
        player,
        opponent,
        // The board Bot just played. The watcher stamps rbState.lastPlayedBoard
        // with this so the opponent's echoed scored card for the same board is
        // deduped (see the lastPlayedBoard guard above).
        boardId,
    };
}

export const wordhuntPlay = {
    decideMove,
    getSubtitle,
    handicapFactor,
    pickTopByScore,
    scoreForWord,
    sumWordScores,
};

