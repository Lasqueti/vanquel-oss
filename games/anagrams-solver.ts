// games/anagrams-solver.ts
import type { DictionaryRead, WordCollection, WordRead } from './strength-types.ts';
// =============================================================================
// Anagrams solver (pure, no I/O)
// =============================================================================
//
// GamePigeon Anagrams gives a flat 7-letter rack (e.g. "ANAGRAM"). A valid word
// is any dictionary word spellable from a SUBSET of the rack, respecting letter
// multiplicity (a multiset / "bag" subset match). Unlike Word Hunt there is NO
// board adjacency - it's Scrabble-style anagramming.
//
// This module only enumerates + scores; the play module (anagrams-play.ts) does
// the move/winner encoding + rubber-band handicap.
//
// Scoring (confirmed from OpenPigeon anagrams/game_screen.gd:_get_word_score):
//   len 3 -> 100, 4 -> 400, 5 -> 1200, 6 -> 2000, 7 -> 3000
// (This is DIFFERENT from Word Hunt's curve. Do not share Word Hunt's scoring.)
// =============================================================================

const ANAGRAM_MIN_LEN = 3;
// Anagrams length -> points. GamePigeon caps the rack at 7 letters, so 7 is the
// top tier; anything longer than 7 can't occur from a 7-letter rack, but we clamp
// defensively.
const ANAGRAM_SCORES: Record<number, number> = { 3: 100, 4: 400, 5: 1200, 6: 2000, 7: 3000 };

function scoreForWord(word: unknown) {
    const len = String(word).length;
    if (len < ANAGRAM_MIN_LEN) return 0;
    if (len >= 7) return 3000;
    return ANAGRAM_SCORES[len] || 0;
}

// Build a letter-count map for a rack/word.
function letterCounts(str: unknown) {
    const counts: Record<string, number> = Object.create(null);
    const s = String(str).toLowerCase();
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        counts[ch] = (counts[ch] || 0) + 1;
    }
    return counts;
}

// Can `word` be spelled from the rack's letter multiset?
function spellableFrom(word: WordRead, rackCounts: Record<string, number>) {
    const need: Record<string, number> = Object.create(null);
    for (let i = 0; i < word.length; i++) {
        const ch = word[i];
        need[ch] = (need[ch] || 0) + 1;
        if (need[ch] > (rackCounts[ch] || 0)) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// solveRack(rack, dict) -> { score, wordCount, sortedWords: [WORD, ...] }
//   rack = the flat letters string (e.g. "ANAGRAM")
//   dict = { words: Set } (from wordhunt-engine.parseDictionary - same shape)
// Returns words UPPERCASED and sorted highest-score-first, then alphabetically,
// so the play module can trim a top-N exactly like Word Hunt.
// -----------------------------------------------------------------------------
function solveRack(rack: unknown, dict: unknown) {
    const rackCounts = letterCounts(rack);
    const wordsSet = (dict && (dict as DictionaryRead).words) ? (dict as DictionaryRead).words : dict;
    const found: WordRead[] = [];
    if (!wordsSet || typeof (wordsSet as WordCollection).forEach !== 'function') {
        return { score: 0, wordCount: 0, sortedWords: [] };
    }
    (wordsSet as WordCollection).forEach(function (w) {
        if (w.length < ANAGRAM_MIN_LEN) return;
        if (w.length > String(rack).length) return; // can't exceed rack size
        if (!spellableFrom(w, rackCounts)) return;
        found.push(w);
    });
    found.sort(function (a, b) {
        const sa = scoreForWord(a);
        const sb = scoreForWord(b);
        if (sb !== sa) return sb - sa;
        if ((a as unknown as string) < (b as unknown as string)) return -1;
        if ((a as unknown as string) > (b as unknown as string)) return 1;
        return 0;
    });
    const sortedWords = found.map((w) => w.toUpperCase());
    const score = sortedWords.reduce<number>((s, w) => s + scoreForWord(w), 0);
    return { score, wordCount: sortedWords.length, sortedWords };
}

export const anagramsSolver = {
    solveRack,
    scoreForWord,
    letterCounts,
    spellableFrom,
    ANAGRAM_SCORES,
    ANAGRAM_MIN_LEN,
};

