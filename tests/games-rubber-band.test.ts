// tests/games-rubber-band.test.ts
// The rubber band (adaptive difficulty) and the per-opponent difficulty store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rubberBand as rb } from '../games/rubber-band.ts';
import { fairPlay } from '../games/fair-play.ts';
import { createDifficultyStore, parseArg, phoneKeys, resolveLevel } from '../games/difficulty.ts';

test('a first game starts fair, then the factor follows results', () => {
    assert.equal(rb.handicapFactor({ gamesPlayed: 0 }), rb.ADAPTIVE_START);
    const afterWin = rb.updateAdaptiveState({}, { botWon: true, oppScore: 3000, gameId: 'hunt' });
    assert.ok(afterWin.adaptiveFactor < rb.ADAPTIVE_START, 'the bot eases off after it wins');
    const afterLoss = rb.updateAdaptiveState({}, { botWon: false, oppScore: 3000, gameId: 'hunt' });
    assert.ok(afterLoss.adaptiveFactor > rb.ADAPTIVE_START, 'the bot pushes after it loses');
});

test('a win then a loss returns to the same factor (no drift)', () => {
    const won = rb.updateAdaptiveState({}, { botWon: true, oppScore: 100, gameId: 'darts' });
    const back = rb.updateAdaptiveState(won, { botWon: false, oppScore: 100, gameId: 'darts' });
    assert.ok(Math.abs((back.adaptiveFactors.darts as number) - rb.ADAPTIVE_START) < 1e-9);
});

test('the factor stays inside its band however long a streak runs', () => {
    let state: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) state = { ...state, ...rb.updateAdaptiveState(state, { botWon: true, oppScore: 100, gameId: 'darts' }) };
    assert.equal(rb.resolveGameFactor(state, 'darts'), rb.ADAPTIVE_MIN);
    for (let i = 0; i < 50; i++) state = { ...state, ...rb.updateAdaptiveState(state, { botWon: false, oppScore: 100, gameId: 'darts' }) };
    assert.equal(rb.resolveGameFactor(state, 'darts'), rb.ADAPTIVE_MAX);
});

test('each game tunes on its own', () => {
    const state = rb.updateAdaptiveState({}, { botWon: false, oppScore: 100, gameId: 'darts' });
    assert.ok((rb.resolveGameFactor(state, 'darts') as number) > rb.ADAPTIVE_START);
    assert.equal(rb.resolveGameFactor(state, 'hunt'), rb.ADAPTIVE_START);
});

test('an abandoned word game does not count as a bot win', () => {
    const state = rb.updateAdaptiveState({}, { botWon: true, oppScore: 0, gameId: 'hunt' });
    assert.equal(state.adaptiveFactor, rb.ADAPTIVE_START);
    assert.deepEqual(state.recentResults, ['D']);
});

test('a fixed level overrides the adaptive factor', () => {
    assert.equal(rb.handicapFactor({ difficulty: 'chill', gamesPlayed: 5, adaptiveFactor: 1.2 }), 0.45);
    assert.equal(rb.handicapFactor({ difficulty: 'sweat', gamesPlayed: 5, adaptiveFactor: 0.9 }), 1.3);
});

test('a word submission is trimmed toward a human-looking target', () => {
    // A big board: 5 long words, 10 six-letter, 30 four-letter, 40 three-letter.
    const sortedWords = [8, 6, 4, 3].flatMap((len, i) => Array.from({ length: [5, 10, 30, 40][i] }, (_, n) => 'W'.repeat(len - 2) + String(n).padStart(2, '0')));
    const score = (w: unknown) => ({ 3: 100, 4: 400, 5: 800, 6: 1400, 7: 1800 } as Record<number, number>)[String(w).length] ?? 2200;
    const full = sortedWords.reduce((s, w) => s + score(w), 0);
    const pick = rb.chooseSubmission({ rbState: { gamesPlayed: 3, adaptiveFactor: 1 }, sortedWords, oppScoreVisible: 1500, scoreForWord: score, gameId: 'hunt' });
    assert.equal(pick.mode, 'score-target');
    assert.ok((pick.score as number) < full, 'never the whole board on adaptive');
    const max = rb.chooseSubmission({ rbState: { difficulty: 'max' }, sortedWords, scoreForWord: score });
    assert.equal(max.score, full);
});

test('fair-play skill rises with the factor and stays below a perfect aim', () => {
    const low = fairPlay.factorToSkill(rb.ADAPTIVE_MIN) as number;
    const high = fairPlay.factorToSkill(rb.ADAPTIVE_MAX) as number;
    assert.ok(low < high);
    assert.ok(high <= fairPlay.SKILL_CAP);
});

test('difficulty settings parse with or without a game name', () => {
    assert.deepEqual(parseArg('darts harder'), { game: 'darts', setting: 'harder' });
    assert.deepEqual(parseArg('mini golf chill'), { game: 'golf', setting: 'chill' });
    assert.deepEqual(parseArg('easier'), { game: null, setting: 'easier' });
    assert.deepEqual(resolveLevel('max', null), { level: 'sweat' });
    assert.deepEqual(resolveLevel('harder', 'chill'), { level: 'match' });
    assert.equal(resolveLevel('nonsense', null), null);
    assert.deepEqual(phoneKeys('+1 5550100001').sort(), ['15550100001', '5550100001']);
});

test('the difficulty store: per-game wins, a global setting sweeps, max releases after two wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'games-diff-'));
    try {
        const store = createDifficultyStore(dir);
        const who = '+15550100001';
        store.applyDifficulty(who, 'chill');
        store.applyDifficulty(who, 'darts harder');
        assert.equal(store.getDifficulty(who, 'darts'), 'match');
        assert.equal(store.getDifficulty(who, 'hunt'), 'chill');
        store.applyDifficulty(who, 'max');
        assert.equal(store.getDifficulty(who, 'darts'), 'sweat', 'a global setting cleared the darts override');
        assert.equal(store.recordFixedDifficultyResult(who, 'darts', true).reset, false);
        const release = store.recordFixedDifficultyResult(who, 'darts', true);
        assert.equal(release.reset, true);
        assert.equal(release.reason, 'max_wins');
        assert.equal(store.getDifficulty(who), 'adaptive');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
