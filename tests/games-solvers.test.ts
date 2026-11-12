// tests/games-solvers.test.ts
// Solvers on fixed boards with a tiny hand-made dictionary, so the results are
// exact and do not depend on the machine's word list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDictionary, solve, scoreFor } from '../games/wordhunt-engine.ts';
import { solveBoard } from '../games/watcher.ts';
import { anagramsSolver } from '../games/anagrams-solver.ts';
import { dartsEngine } from '../games/darts-engine.ts';
import { dotsEngine } from '../games/dots-engine.ts';

const dict = parseDictionary(['cat', 'cats', 'act', 'scat', 'tac', 'dog', 'at', 'Cast', "it's", 'taco'].join('\n'));

test('parseDictionary keeps lowercase [a-z] words of 3+ letters only', () => {
    assert.deepEqual([...dict.words].sort(), ['act', 'cast', 'cat', 'cats', 'dog', 'scat', 'tac', 'taco']);
});

test('word hunt finds only words with an adjacent, non-reusing path', () => {
    // C A T S
    // X X X X
    // X X X X
    // X X X X
    const board = 'catsxxxxxxxxxxxx'.split('');
    const found = solve(board, dict);
    // "tac" walks the row backwards; "cast", "act" and "scat" need cells that are not adjacent.
    assert.deepEqual(found.map((w) => w.word), ['cats', 'cat', 'tac']);
    assert.deepEqual(found[0].path, [0, 1, 2, 3]);
    assert.equal(found[0].score, scoreFor(4));
});

test('word hunt walks diagonals', () => {
    // C X X X
    // X A X X
    // X X T X
    // X X X X
    const board = 'cxxxxaxxxxtxxxxx'.split('');
    assert.deepEqual(solve(board, dict).map((w) => w.word), ['cat', 'tac']);
});

test('solveBoard scores a 4x4 board and refuses other sizes', () => {
    const out = solveBoard('CATSXXXXXXXXXXXX', dict);
    assert.deepEqual(out, { score: 400 + 100 + 100, wordCount: 3, sortedWords: ['CATS', 'CAT', 'TAC'] });
    assert.throws(() => solveBoard('CATS', dict), /unsupported board size 4/);
});

test('anagrams finds every rack-spellable word, highest score first', () => {
    const out = anagramsSolver.solveRack('TACSXYZ', dict);
    assert.deepEqual(out.sortedWords, ['CAST', 'CATS', 'SCAT', 'ACT', 'CAT', 'TAC']);
    assert.equal(out.score, 3 * 400 + 3 * 100);
    // letter multiplicity is respected: one T only
    assert.equal(anagramsSolver.spellableFrom('tat', anagramsSolver.letterCounts('tac')), false);
});

test('darts checkout finishes on a double', () => {
    assert.deepEqual(dartsEngine.bestCheckout(40, 3), [dartsEngine.target(20, 2)]);
    const two = dartsEngine.bestCheckout(100, 3);
    assert.equal(two?.length, 2);
    assert.equal(two!.reduce((s, t) => s + t.points, 0), 100);
    assert.ok(dartsEngine.isDouble(two![1]));
    assert.equal(dartsEngine.bestCheckout(1, 3), null); // 1 can never be finished
});

test('darts board scores the bullseye as 50', () => {
    const c = dartsEngine.DART_BOARD_CENTER;
    assert.equal(dartsEngine.scoreFromXY(c.x, c.y).points, 50);
});

test('dots and boxes takes a box that is one edge from complete', () => {
    const board = dotsEngine.newBoard(3);
    const sides = dotsEngine.boxEdges(0, 0);
    for (const e of sides.slice(0, 3)) dotsEngine.drawEdge(board, e, 2);
    assert.equal(dotsEngine.edgeCompletes(board, sides[3]), 1);
    const pick = dotsEngine.pickEdge(board, 1, { rng: () => 0.5 });
    assert.equal(pick?.edge, sides[3]);
    assert.deepEqual(dotsEngine.drawEdge(board, sides[3], 1), [[0, 0]]);
});
