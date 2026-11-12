// tests/games-cipher.test.ts
// The GamePigeon payload cipher: a length-keyed shuffle over a drand48 stream,
// wrapped in a "data:?ver=52&data=..." envelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cipher } from '../games/cipher.ts';

test('encrypt then decrypt returns the original for many lengths', () => {
    for (const text of ['', 'a', 'ab', 'hello world', '?game=hunt&letters=ABCDEFGHIJKLMNOP&id=S1', 'x'.repeat(2000)]) {
        assert.equal(cipher.decrypt(cipher.encrypt(text)), text);
    }
});

test('encrypt is a deterministic permutation keyed on length', () => {
    const text = 'the quick brown fox';
    const once = cipher.encrypt(text);
    assert.equal(once, cipher.encrypt(text));
    assert.notEqual(once, text);
    assert.deepEqual([...String(once)].sort(), [...text].sort());
});

test('drand48 matches the reference 48-bit LCG stream', () => {
    // srand(0) then two draws, computed from the POSIX definition
    // (a = 0x5DEECE66D, c = 0xB, seed = (s << 16) | 0x330E).
    const rand = new cipher.Rand48(0);
    rand.srand(0);
    let x = 0x330En;
    const expected: number[] = [];
    for (let i = 0; i < 2; i++) {
        x = (x * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
        expected.push(Number(x) / 2 ** 48);
    }
    assert.deepEqual([rand.drand(), rand.drand()], expected);
});

test('envelope round trip keeps every field, including spaces and symbols', () => {
    const state = { game: 'hunt', id: 'S1', caption: 'Your Move.', letters: 'ABCDEFGHIJKLMNOP', winner: 'X|1', note: 'a b&c=d*e' };
    const url = cipher.buildEnvelope(state) as string;
    assert.match(url, /^data:\?ver=52&data=/);
    assert.deepEqual(cipher.parseEnvelope(url), state);
});

test('decrypt refuses an oversized ciphertext instead of hanging', () => {
    assert.throws(() => cipher.decrypt('x'.repeat(cipher.MAX_CIPHER_LENGTH + 1)), /too long/);
});

test('parseEnvelope rejects an envelope with no data', () => {
    assert.throws(() => cipher.parseEnvelope('data:?ver=52'), /no data=/);
});
