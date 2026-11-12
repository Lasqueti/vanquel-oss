// games/wordhunt-engine.ts
// Word Hunt solver engine. Pure functions only: no I/O, no timers. The caller
// supplies a dictionary as { words: Set } (see parseDictionary); this module
// never bundles a word list.
//
// Board model: a 4x4 grid stored as a flat 16-char array, row-major
// (index = row * 4 + col). Adjacency is Chebyshev (8 neighbors, king moves).
// A word's path is a list of distinct cell indices where consecutive cells are
// adjacent and no cell is reused.
//
// Ported from production's browser/Node UMD engine. Only the parts the games
// watcher uses are kept (the browser demo's board generator and opponent word
// picker were dropped).

export interface Dictionary {
    words: Set<string>;
}

export interface SolvedWord {
    word: string;
    score: number;
    path: number[];
}

interface TrieNode {
    children: Record<string, TrieNode>;
    word: string | null;
}

// ---- scoring ----------------------------------------------------------------
// Word Hunt (GamePigeon-style) length-based scoring.
export const SCORES: Record<number, number> = { 3: 100, 4: 400, 5: 800, 6: 1400, 7: 1800, 8: 2200 };

export function scoreFor(length: number): number {
    const len = length | 0;
    if (len < 3) return 0;
    if (len >= 8) return 2200;
    return SCORES[len];
}

// ---- dictionary parsing -----------------------------------------------------
// One word per line. Lowercase, keep only pure [a-z]+ tokens length >= 3.
export function parseDictionary(text: unknown): Dictionary {
    const words = new Set<string>();
    if (typeof text !== 'string') return { words };
    for (const line of text.split(/\r?\n/)) {
        const w = line.trim().toLowerCase();
        if (w.length >= 3 && /^[a-z]+$/.test(w)) words.add(w);
    }
    return { words };
}

// ---- adjacency (precomputed for a 4x4 grid) ---------------------------------
// ADJ[i] = list of the (up to 8) cell indices Chebyshev-adjacent to i.
const GRID = 4;
const CELLS = GRID * GRID;
export const ADJ: number[][] = (() => {
    const adj: number[][] = [];
    for (let i = 0; i < CELLS; i++) {
        const r = (i / GRID) | 0;
        const c = i % GRID;
        const list: number[] = [];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = r + dr;
                const nc = c + dc;
                if (nr >= 0 && nr < GRID && nc >= 0 && nc < GRID) list.push(nr * GRID + nc);
            }
        }
        adj.push(list);
    }
    return adj;
})();

// ---- board-filtered trie ----------------------------------------------------
// A compact trie is built from ONLY the dictionary words that are spellable
// from the board's letter multiset (each board letter counted). This shrinks
// the search space dramatically before the DFS ever runs.
function boardLetterCounts(board: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const ch of board) counts[ch] = (counts[ch] || 0) + 1;
    return counts;
}

// Can `word` be spelled from the available letter multiset? (necessary, not
// sufficient: path adjacency is still enforced later by the DFS.)
function spellableFromCounts(word: string, counts: Record<string, number>): boolean {
    const need: Record<string, number> = {};
    for (const ch of word) {
        need[ch] = (need[ch] || 0) + 1;
        if (need[ch] > (counts[ch] || 0)) return false;
    }
    return true;
}

export function buildTrie(dict: unknown, board: string[]): TrieNode {
    const counts = boardLetterCounts(board);
    const root: TrieNode = { children: {}, word: null };
    const wordsSet = (dict && (dict as Dictionary).words) ? (dict as Dictionary).words : dict;
    if (!wordsSet || typeof (wordsSet as Set<string>).forEach !== 'function') return root;

    (wordsSet as Set<string>).forEach((word) => {
        if (word.length < 3) return;
        if (!spellableFromCounts(word, counts)) return;
        let node = root;
        for (const ch of word) {
            let next = node.children[ch];
            if (!next) {
                next = { children: {}, word: null };
                node.children[ch] = next;
            }
            node = next;
        }
        node.word = word;
    });
    return root;
}

// ---- solver -----------------------------------------------------------------
// DFS from every cell, walking the board-filtered trie in lockstep. A 16-bit
// integer `visited` bitmask tracks used cells (bit i set => cell i used).
// One path is kept per unique word (the first found). Results sorted by
// score desc, then alphabetically for stable ordering.
export function solve(board: string[], dict: unknown): SolvedWord[] {
    if (!Array.isArray(board) || board.length !== CELLS) {
        throw new Error('solve: board must be a 16-element array');
    }
    const root = buildTrie(dict, board);
    const found: Record<string, number[]> = Object.create(null); // word -> path (first path wins)

    function dfs(cell: number, node: TrieNode, visited: number, path: number[]): void {
        const child = node.children[board[cell]];
        if (!child) return;

        const nextVisited = visited | (1 << cell);
        path.push(cell);

        if (child.word && !(child.word in found)) found[child.word] = path.slice();

        for (const nb of ADJ[cell]) {
            if (nextVisited & (1 << nb)) continue; // already used
            // prune: only descend if the trie has an edge for that letter
            if (child.children[board[nb]]) dfs(nb, child, nextVisited, path);
        }

        path.pop();
    }

    for (let start = 0; start < CELLS; start++) {
        if (root.children[board[start]]) dfs(start, root, 0, []);
    }

    const results: SolvedWord[] = [];
    for (const word in found) results.push({ word, score: scoreFor(word.length), path: found[word] });
    results.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.word < b.word) return -1;
        if (a.word > b.word) return 1;
        return 0;
    });
    return results;
}
