// games/wordbites-solver.ts
import type { WordPiece, WordRead, WordCollection, DictionaryRead } from './strength-types.ts';
// =============================================================================
// Word Bites solver (pure, no I/O)  - APPROACH 2 (placement-aware / geometry)
// =============================================================================
//
// GamePigeon Word Bites packs the board into the `level` field: a `&`-joined
// list of pieces, each piece "orientation|row|col|LETTERS":
//   orientation 0 = single-letter tile, 1 = horizontal 2-letter block,
//                   2 = vertical 2-letter block
//   row, col     = anchor cell on the grid
//   LETTERS      = the letter(s) on that piece (1 for single, 2 for a block)
//
// Word Bites is "Scrabble with movable multi-letter blocks": you drag pieces to
// spell ONE word at a time, along a ROW (horizontal, read left->right) or a
// COLUMN (vertical, read top->bottom).
//
// -------- PLACEMENT RULES (this is what APPROACH 1 got wrong) --------
// A word is a sequence of pieces laid end-to-end along the chosen line. The
// contribution of a piece depends on whether it is ALIGNED with the word or CROSS
// to it:
//   HORIZONTAL word:
//     * horizontal block (orient 1) = ALIGNED -> both letters, IN ORDER, adjacent
//     * vertical block   (orient 2) = CROSS   -> exactly ONE letter (either of its
//                                                two - you slide it so the wanted
//                                                letter sits on the word's row)
//     * single           (orient 0) = ONE letter
//   VERTICAL word:
//     * vertical block   (orient 2) = ALIGNED -> both letters, IN ORDER, adjacent
//     * horizontal block (orient 1) = CROSS   -> exactly ONE letter (either)
//     * single           (orient 0) = ONE letter
// Each piece is used AT MOST ONCE per word. A word is PLACEABLE iff its letter
// sequence can be segmented into consecutive chunks where every 2-letter chunk is
// an unused aligned block matching those two letters in order, and every 1-letter
// chunk is an unused single OR one letter of an unused cross block. We require a
// word to be placeable in AT LEAST ONE orientation; otherwise it is REJECTED (the
// old multiset check would happily "spell" ABDITORY even though its only T is
// locked inside the horizontal block CT with no preceding C - unplaceable).
//
// This is the SAFE subset: an aligned block always contributes its 2 letters (we
// do not let it contribute a lone letter with its partner hanging past the word
// edge), so we never claim a word is placeable when it is not. It can reject a
// few edge-trick words, but that direction is safe - GamePigeon will not reject a
// submission of words we CAN place.
//
// Scoring [STILL INFERRED - unverified]: no confirmed Word Bites points table has
// ever been captured. We keep a conservative length curve as a placeholder;
// because scoring is unverified, wordbites-play STILL gates sending behind
// GP_WORDBITES_SEND (default OFF). Fixing placement does NOT arm the game.
// =============================================================================

const WORDBITES_MIN_LEN = 3;
// INFERRED placeholder scoring (length-based, Word-Hunt-ish). NOT confirmed.
const WORDBITES_SCORES: Record<number, number> = { 3: 100, 4: 400, 5: 800, 6: 1400, 7: 1800 };
function scoreForWord(word: unknown) {
    const len = String(word).length;
    if (len < WORDBITES_MIN_LEN) return 0;
    if (len >= 8) return 2200;
    return WORDBITES_SCORES[len] || 0;
}

// -----------------------------------------------------------------------------
// parseLevel(levelStr) -> { pieces: [{ orient, row, col, letters }], ok: bool }
// Fail-safe: returns ok=false if ANY piece is malformed.
// -----------------------------------------------------------------------------
function parseLevel(levelStr: unknown) {
    if (typeof levelStr !== 'string' || levelStr.length === 0) {
        return { pieces: [], ok: false };
    }
    const rawPieces = levelStr.split('&');
    const pieces: WordPiece[] = [];
    for (let raw of rawPieces) {
        raw = raw.trim();
        if (raw.length === 0) continue;
        const parts = raw.split('|');
        if (parts.length !== 4) return { pieces: [], ok: false };
        const orient = Number(parts[0]);
        const row = Number(parts[1]);
        const col = Number(parts[2]);
        const letters = String(parts[3]).toUpperCase();
        if (!Number.isFinite(orient) || orient < 0 || orient > 2) return { pieces: [], ok: false };
        if (!Number.isFinite(row) || !Number.isFinite(col)) return { pieces: [], ok: false };
        if (!/^[A-Z]+$/.test(letters)) return { pieces: [], ok: false };
        // single tile => 1 letter; a 2-letter block (orient 1 or 2) => 2 letters
        const expected = orient === 0 ? 1 : 2;
        if (letters.length !== expected) return { pieces: [], ok: false };
        pieces.push({ orient, row, col, letters });
    }
    if (pieces.length === 0) return { pieces: [], ok: false };
    return { pieces, ok: true };
}

// -----------------------------------------------------------------------------
// letterBag(pieces) -> { counts, totalLetters } - the multiset of all letters
// across all pieces (each block contributes both letters).
// -----------------------------------------------------------------------------
function letterBag(pieces: WordPiece[]) {
    const counts: Record<string, number> = Object.create(null);
    let total = 0;
    for (const p of pieces) {
        for (const ch of p.letters.toLowerCase()) {
            counts[ch] = (counts[ch] || 0) + 1;
            total++;
        }
    }
    return { counts, totalLetters: total };
}

function spellableFrom(word: WordRead, counts: Record<string, number>) {
    const need: Record<string, number> = Object.create(null);
    for (let i = 0; i < word.length; i++) {
        const ch = word[i];
        need[ch] = (need[ch] || 0) + 1;
        if (need[ch] > (counts[ch] || 0)) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// splitPieces(pieces) -> { alignedBlocks, crossBlocks, singles } for a given word
// direction. For a HORIZONTAL word, aligned = orient 1 (horizontal), cross =
// orient 2 (vertical). For a VERTICAL word, aligned = orient 2, cross = orient 1.
// Singles (orient 0) are direction-independent. Letters are upper-cased.
// -----------------------------------------------------------------------------
function piecesForDirection(pieces: WordPiece[], direction: unknown) {
    const alignedOrient = direction === 'H' ? 1 : 2;
    const crossOrient = direction === 'H' ? 2 : 1;
    const alignedBlocks = [];
    const crossLetters = []; // each cross block offers EITHER of its two letters
    const singles = [];
    for (const p of pieces) {
        const L = p.letters.toUpperCase();
        if (p.orient === 0) singles.push(L);
        else if (p.orient === alignedOrient) alignedBlocks.push(L);
        else if (p.orient === crossOrient) crossLetters.push([L[0], L[1]]);
    }
    return { alignedBlocks, crossLetters, singles };
}

// -----------------------------------------------------------------------------
// canPlaceInDirection(word, pieces, direction) - can `word` be tiled along this
// direction using each piece at most once? Recursive segmentation with a used[]
// mask. A 2-letter aligned block matches word[i..i+1] in order; a 1-letter step
// consumes a single OR one letter of a cross block. Memo-free (words are short,
// pieces few - 16 letters / ~11 pieces on a real board).
// -----------------------------------------------------------------------------
function canPlaceInDirection(word: WordRead, pieces: WordPiece[], direction: unknown) {
    const { alignedBlocks, crossLetters, singles } = piecesForDirection(pieces, direction);
    const usedAligned: boolean[] = new Array(alignedBlocks.length).fill(false);
    const usedCross: boolean[] = new Array(crossLetters.length).fill(false);
    const usedSingle: boolean[] = new Array(singles.length).fill(false);

    function rec(i: number): boolean {
        if (i >= word.length) return true;
        const a = word[i];
        // Option 1: a 2-letter aligned block covering word[i..i+1] in order.
        if (i + 1 < word.length) {
            const pair = a + word[i + 1];
            for (let k = 0; k < alignedBlocks.length; k++) {
                if (!usedAligned[k] && alignedBlocks[k] === pair) {
                    usedAligned[k] = true;
                    if (rec(i + 2)) return true;
                    usedAligned[k] = false;
                }
            }
        }
        // Option 2: a single tile for word[i].
        for (let k = 0; k < singles.length; k++) {
            if (!usedSingle[k] && singles[k] === a) {
                usedSingle[k] = true;
                if (rec(i + 1)) return true;
                usedSingle[k] = false;
            }
        }
        // Option 3: one letter of a cross block for word[i] (either of its two).
        for (let k = 0; k < crossLetters.length; k++) {
            if (!usedCross[k] && (crossLetters[k][0] === a || crossLetters[k][1] === a)) {
                usedCross[k] = true;
                if (rec(i + 1)) return true;
                usedCross[k] = false;
            }
        }
        return false;
    }
    return rec(0);
}

// -----------------------------------------------------------------------------
// canPlaceWord(word, pieces) - placeable in EITHER a horizontal or vertical line.
// -----------------------------------------------------------------------------
function canPlaceWord(word: unknown, pieces: WordPiece[]) {
    const W = String(word).toUpperCase();
    return canPlaceInDirection(W, pieces, 'H') || canPlaceInDirection(W, pieces, 'V');
}

// -----------------------------------------------------------------------------
// solveLevel(levelStr, dict) -> { score, wordCount, sortedWords, ok, pieceCount }
// ok=false => malformed level; the play module treats that as SKIP.
// -----------------------------------------------------------------------------
function solveLevel(levelStr: unknown, dict: unknown) {
    const parsed = parseLevel(levelStr);
    if (!parsed.ok) {
        return { score: 0, wordCount: 0, sortedWords: [], ok: false, pieceCount: 0 };
    }
    const bag = letterBag(parsed.pieces);
    const wordsSet = (dict && (dict as DictionaryRead).words) ? (dict as DictionaryRead).words : dict;
    const found: WordRead[] = [];
    if (wordsSet && typeof (wordsSet as WordCollection).forEach === 'function') {
        (wordsSet as WordCollection).forEach(function (w) {
            if (w.length < WORDBITES_MIN_LEN) return;
            if (w.length > bag.totalLetters) return;
            // Fast reject on the raw letter multiset FIRST (cheap), then the exact
            // placement/geometry check (Approach 2) so we never keep a word that
            // cannot actually be laid out with the available pieces.
            if (!spellableFrom(w, bag.counts)) return;
            if (!canPlaceWord(w, parsed.pieces)) return;
            found.push(w);
        });
    }
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
    return {
        score,
        wordCount: sortedWords.length,
        sortedWords,
        ok: true,
        pieceCount: parsed.pieces.length,
    };
}

export const wordbitesSolver = {
    parseLevel,
    letterBag,
    solveLevel,
    scoreForWord,
    spellableFrom,
    canPlaceWord,
    canPlaceInDirection,
    piecesForDirection,
    WORDBITES_SCORES,
    WORDBITES_MIN_LEN,
};

