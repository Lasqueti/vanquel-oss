// games/cipher.ts
import type { CipherTextRead, CipherModeRead, CipherMapRead, BigIntOperand } from './cipher-types.ts';
// =============================================================================
// GamePigeon cipher + envelope (ported from OpenBubbles/OpenPigeon)
// =============================================================================
//
// This module decodes and encodes the payload GamePigeon packs into its iMessage
// app-card ("balloon") so Bot can later READ a live game board and WRITE a move.
//
// It is a faithful JavaScript port of OpenPigeon's Kotlin implementation
// (github.com/OpenBubbles/openpigeon, `wordhunt` branch):
//   - Cryption.kt              -> Rand48 / encrypt / decrypt below
//   - Game.kt                  -> encodeQuery / buildEnvelope (buildGameMessage)
//   - GameSession.kt           -> parseEnvelope (handleNewMessage)
//   - wordhunt/WordHuntGame*   -> scores, grid mapping, mode table
//
// The GamePigeon "cipher" (Cryption) is NOT real crypto. It is a deterministic
// character shuffle keyed ONLY on the input string's LENGTH, driven by a port of
// glibc's srand48/drand48 PRNG. Because the seed depends solely on length,
// encrypt() and decrypt() are exact inverses of each other for any string.
//
// The full game state travels as a `data:` URI inside the balloon's URL:
//   url = "data:?ver=52&data=" + encrypt( encodeQuery(stateMap).replace('+','%20') )
//
// VERIFIED against a REAL GamePigeon card (2026-07-04): a live 8-Ball app-card was
// pulled from the Mac's chat.db (balloon_bundle_id EWFNLB79LQ:...gamepigeon.ext) and
// parseEnvelope() decoded its URL cleanly into a full game-state map
// ({game:pool, game_name:"8 Ball", caption, id, sender, seed, player, avatar2, ...}).
// The cipher + envelope are correct on real wire bytes. Still unverified for the
// Word Hunt board field names specifically (need a real Word Hunt capture), and the
// SEND side (emitting a balloon) remains the open problem. See the research doc at
// docs/gamepigeon-real-integration-research.md.
//
// Nothing here is wired into the app. New file, no side effects, no deploy.
// =============================================================================

// -----------------------------------------------------------------------------
// Identity / routing constants (confirmed from OpenPigeon source + our chat.db)
// -----------------------------------------------------------------------------
// The balloon bundle id ("bid") that iMessage uses to route the card to Apple's
// real GamePigeon extension. Format:
//   com.apple.messages.MSMessageExtensionBalloonPlugin:<TEAM_ID>:<EXT_BUNDLE_ID>
const TEAM_ID = 'EWFNLB79LQ';
const EXT_BUNDLE_ID = 'com.gamerdelights.gamepigeon.ext';
const BALLOON_BID =
    'com.apple.messages.MSMessageExtensionBalloonPlugin:' + TEAM_ID + ':' + EXT_BUNDLE_ID;
// GamePigeon's App Store id (adam-id).
const ADAM_ID = '1124197642';

// Envelope version stamps. These are the constants OpenPigeon captured from real
// GamePigeon traffic and hardcodes. `ENVELOPE_VER` is the outer `ver=` on the
// data: URI; the rest are inner state-map defaults GamePigeon writes on a new game.
const ENVELOPE_VER = '52';
const INNER_TVER = '5';
const INNER_IOS = '18.3.2';
const INNER_BUILD = 'HeO3hkh1UZH8IaVCaV';

// The `data:` URI prefix the whole envelope is wrapped in.
const ENVELOPE_PREFIX = 'data:?ver=' + ENVELOPE_VER + '&data=';

// -----------------------------------------------------------------------------
// Word Hunt constants (ported from wordhunt/WordHuntGameState.kt + WordHuntGame*)
// -----------------------------------------------------------------------------
// Word Hunt dictionary id and game identifiers.
const WORD_HUNT_GAME = 'hunt';
const WORD_HUNT_DISPLAY_NAME = 'Word Hunt';
const WORD_HUNT_VERSION = '47';
const WORD_HUNT_LANG = 'gp_en2';
const WORD_HUNT_DURATION_SECONDS = 80;
const WORD_HUNT_MIN_WORD_LENGTH = 3;

// Scoring by word length. calculatePoints(): 3->100, 4->400, 5->800, 6->1400,
// 7->1800, 8 or more -> 2200. Index the array by word length; anything >= 8
// falls through to LONG_WORD_SCORE.
const WORD_HUNT_SCORES: CipherMapRead = { 3: 100, 4: 400, 5: 800, 6: 1400, 7: 1800 };
const WORD_HUNT_LONG_WORD_SCORE = 2200; // 8+ letters

// Board shapes. `mode` on the state map selects the grid geometry. `gridSize` is
// the side length; `invalidPositions` are voided [row, col] cells (circle / X
// boards). Ported byte-for-byte from WordHuntActivity.GameMode.
const WORD_HUNT_MODES: CipherMapRead = {
    1: { gridSize: 4, invalidPositions: [] },
    2: {
        gridSize: 5,
        invalidPositions: [[0, 0], [0, 4], [2, 2], [4, 0], [4, 4]],
    },
    3: {
        gridSize: 5,
        invalidPositions: [[0, 2], [2, 0], [2, 4], [4, 2]],
    },
    4: { gridSize: 5, invalidPositions: [] },
};

// Scrabble-frequency letter bag Word Hunt fills a board from (E x12, A/I x9, ...).
// Kept here so a future move-writer can generate a board the same way GamePigeon
// does; the solver does not need it.
const WORD_HUNT_LETTER_FREQUENCIES: CipherMapRead = {
    E: 12, A: 9, I: 9, O: 8, N: 6, R: 6, T: 6, L: 4, S: 4, U: 4, D: 4, G: 3,
    B: 2, C: 2, M: 2, P: 2, F: 2, H: 2, V: 2, W: 2, Y: 2, K: 1, J: 1, X: 1,
    Q: 1, Z: 1,
};

// =============================================================================
// drand48 - glibc srand48/drand48 LCG port (Cryption.Rand48 in Kotlin)
// =============================================================================
// n = (25214903917 * n + 11) mod 2^48. BigInt is required: the multiply overflows
// JS's 2^53 safe-integer range for large n, so a plain Number LCG would diverge
// from glibc after the first few draws.
const MULTIPLIER = 25214903917n;
const INCREMENT = 11n;
const MODULUS = 1n << 48n; // 2^48
const MASK = MODULUS - 1n; // 2^48 - 1

class Rand48 {
    declare _n: unknown;

    constructor(seed: unknown) {
        this._n = BigInt(((seed || 0) as BigIntOperand)) & MASK;
    }

    // Direct 48-bit seed set (Rand48.seed()).
    seed(seed: unknown) {
        this._n = BigInt((seed as BigIntOperand)) & MASK;
    }

    // srand48-style seed: n = (seed << 16) + 0x330e.  Cryption seeds with
    // srand(len * 0xef), i.e. this is the length-keyed entry point.
    srand(seed: unknown) {
        this._n = ((BigInt((seed as BigIntOperand)) << 16n) + 0x330en) & MASK;
    }

    // Advance the LCG one step and return the new 48-bit state.
    next() {
        this._n = (MULTIPLIER * (this._n as bigint) + INCREMENT) & MASK;
        return this._n;
    }

    // drand48: uniform double in [0, 1).
    drand() {
        return Number(this.next()) / Number(MODULUS);
    }
}

// Build a Rand48 seeded per Cryption's length rule: srand(len * 0xef).
// Exposed as `drand48(len)` so callers can inspect / reuse the exact PRNG stream
// the cipher rides on.
function drand48(len: unknown) {
    const rand = new Rand48(0);
    rand.srand((len as number) * 0xef);
    return rand;
}

// =============================================================================
// encrypt / decrypt - length-keyed character shuffle (Cryption.encrypt/decrypt)
// =============================================================================

// encrypt(): pull characters OUT of a shrinking pool at floor(drand()*remaining).
// Faithful port of Cryption.encrypt.
function encrypt(string: unknown) {
    const rand = drand48((string as CipherTextRead).length);
    let result = '';
    let remaining = string;
    for (let i = 0; i < (string as CipherTextRead).length; i++) {
        const idx = Math.floor(rand.drand() * (remaining as CipherTextRead).length);
        result += (remaining as CipherTextRead)[idx];
        remaining = ((remaining as CipherTextRead).slice(0, idx) as string) + ((remaining as CipherTextRead).slice(idx + 1) as string);
    }
    return result;
}

// Hard ceiling on the ciphertext decrypt() will process. decrypt() rebuilds the
// output one character at a time with two slices per character, so it is O(n^2):
// an oversized inbound value is a CPU HANG, not merely a slow decode. Measured on
// the real function: 160k chars = 2.3s, 320k = 15s, 640k = 61s, and it keeps
// quadrupling per doubling. The watcher's poll loop is serialized, so one such
// card stalls game handling on EVERY line for as long as it spins. Real cards
// carry ~1-2KB here, so 64KB is ~30x headroom and cannot reject a genuine card.
const MAX_CIPHER_LENGTH = 64 * 1024;

// decrypt(): inverts encrypt by replaying the same draws and inserting characters
// back at their original offsets. Faithful port of Cryption.decrypt.
function decrypt(string: unknown) {
    const len = String(string).length;
    if (len > MAX_CIPHER_LENGTH) {
        throw new Error('decrypt: ciphertext too long (' + len + ' > ' + MAX_CIPHER_LENGTH + ')');
    }
    const rand = drand48((string as CipherTextRead).length);

    const offsets = [];
    let modifier = 0;
    for (let i = 0; i < (string as CipherTextRead).length; i++) {
        offsets.push(Math.floor(rand.drand() * (modifier + (string as CipherTextRead).length)));
        modifier--;
    }

    let output = '';
    const reversed = offsets.slice().reverse();
    for (let i = 0; i < reversed.length; i++) {
        const offset = reversed[i];
        const index = (string as CipherTextRead).length - i - 1;
        output = output.slice(0, offset) + (string as CipherTextRead)[index] + output.slice(offset);
    }
    return output;
}

// =============================================================================
// encodeQuery / decodeQuery - the flat ?k=v&k=v state map
// =============================================================================
// GamePigeon (via Java's URLEncoder) form-encodes each key and value and joins
// them with '&', prefixed with '?'. Java form-encoding turns spaces into '+'
// (not '%20') and encodes '*' but leaves '-', '_', '.' alone. We mirror that so
// the string is byte-identical to what GamePigeon produces before the cipher runs.

// Form-encode a single component the way java.net.URLEncoder does:
//   space -> '+', and encodeURIComponent's leftover safe chars !'()*  are
//   percent-encoded (URLEncoder does not treat them as safe), except '*' which
//   URLEncoder leaves alone.
function formEncode(component: unknown) {
    return encodeURIComponent(String(component))
        .replace(/%20/g, '+')
        .replace(/[!'()]/g, function (c) {
            return '%' + c.charCodeAt(0).toString(16).toUpperCase();
        })
        .replace(/\*/g, '*'); // URLEncoder leaves '*' unescaped
}

// Decode a single form component: '+' is a space, then percent-decode.
function formDecode(component: unknown) {
    return decodeURIComponent(String(component).replace(/\+/g, ' '));
}

// encodeQuery(map) -> "?k=v&k=v" with each key/value form-encoded.
function encodeQuery(mapObj: unknown) {
    const parts = [];
    for (const key of Object.keys((mapObj as object))) {
        parts.push(formEncode(key) + '=' + formEncode((mapObj as CipherMapRead)[key]));
    }
    return '?' + parts.join('&');
}

// decodeQuery("?k=v&k=v" or "k=v&k=v") -> { k: v, ... }. Later duplicate keys
// win, matching Android's Uri.getQueryParameter single-value semantics closely
// enough for GamePigeon's flat maps (which don't repeat keys).
function decodeQuery(str: unknown) {
    let s = String(str);
    if (s.startsWith('?')) s = s.slice(1);
    const out: CipherMapRead = {};
    if (s.length === 0) return out;
    for (const pair of s.split('&')) {
        if (pair.length === 0) continue;
        const eq = pair.indexOf('=');
        if (eq === -1) {
            out[formDecode(pair)] = '';
        } else {
            out[formDecode(pair.slice(0, eq))] = formDecode(pair.slice(eq + 1));
        }
    }
    return out;
}

// =============================================================================
// buildEnvelope / parseEnvelope - the "data:?ver=52&data=<cipher>" wrapper
// =============================================================================
// buildEnvelope mirrors Game.buildGameMessage's url construction:
//   inner = encodeQuery(stateMap).replace('+','%20')   // spaces as %20 pre-cipher
//   data  = encodeQuery({ ver: "52", data: encrypt(inner) })
//   url   = "data:" + data
// parseEnvelope mirrors GameSession.handleNewMessage: pull `data`, decrypt, parse.

// buildEnvelope(stateMap) -> "data:?ver=52&data=<CIPHER>"
function buildEnvelope(stateMap: unknown) {
    const inner = encodeQuery(stateMap).replace(/\+/g, '%20');
    const cipher = encrypt(inner);
    // Outer query. encodeQuery form-encodes the cipher value; the '%' in any
    // %20 inside the cipher is itself encoded, so it survives the round-trip.
    const data = encodeQuery({ ver: ENVELOPE_VER, data: cipher });
    return 'data:' + data;
}

// parseEnvelope("data:?ver=52&data=...") -> stateMap
function parseEnvelope(url: unknown) {
    let s = String(url);
    // Strip the "data:" scheme prefix; tolerate "data://" too.
    if (s.startsWith('data://')) {
        s = s.slice('data://'.length);
    } else if (s.startsWith('data:')) {
        s = s.slice('data:'.length);
    }
    const outer = decodeQuery(s);
    const cipher = outer.data;
    if (cipher == null) {
        throw new Error('parseEnvelope: no data= parameter in envelope');
    }
    const decrypted = decrypt(cipher);
    return decodeQuery(decrypted);
}

// =============================================================================
// Word Hunt helpers - scoring + grid mapping
// =============================================================================

// Points for a found word by length (3->100 ... 8+->2200).
function wordHuntScore(word: unknown): unknown {
    const len = String(word).length;
    if (len < WORD_HUNT_MIN_WORD_LENGTH) return 0;
    if (len >= 8) return WORD_HUNT_LONG_WORD_SCORE;
    return WORD_HUNT_SCORES[len] || 0;
}

// Reconstruct the 4x4 (or 5x5) board from the flat `letters` string using
// GamePigeon's BOTTOM-ROW-FIRST fill (WordHuntActivity.populatedBoard):
//   for i in gridSize-1 downTo 0:  for j in 0 until gridSize:  board[i][j] = pool[k++]
// So letters[0] lands at the bottom-left cell and fills left->right, rows bottom->top.
// `mode` is 1..4 (see WORD_HUNT_MODES); defaults to 1 (4x4).
function lettersToGrid(letters: unknown, mode: unknown) {
    const m = ((WORD_HUNT_MODES[mode as PropertyKey] || WORD_HUNT_MODES[1]) as CipherModeRead);
    const gridSize = m.gridSize;
    const chars = String(letters);
    const board: unknown[] = [];
    for (let i = 0; i < gridSize; i++) {
        board.push(new Array(gridSize).fill(''));
    }
    let poolIndex = 0;
    for (let i = gridSize - 1; i >= 0; i--) {
        for (let j = 0; j < gridSize; j++) {
            (board[i] as unknown[])[j] = chars[poolIndex++] || '';
        }
    }
    // Blank out voided cells for circle / X boards so callers can treat '' as
    // "no tile here".
    for (const [r, c] of m.invalidPositions) {
        if (board[r]) (board[r] as unknown[])[c] = '';
    }
    return board;
}

// =============================================================================
// Exports
// =============================================================================
export const cipher = {
    // PRNG
    Rand48,
    drand48,

    // cipher
    encrypt,
    decrypt,
    MAX_CIPHER_LENGTH,

    // query map
    encodeQuery,
    decodeQuery,

    // envelope
    buildEnvelope,
    parseEnvelope,

    // Word Hunt helpers
    wordHuntScore,
    lettersToGrid,

    // identity constants
    BALLOON_BID,
    TEAM_ID,
    EXT_BUNDLE_ID,
    ADAM_ID,

    // envelope stamps
    ENVELOPE_VER,
    ENVELOPE_PREFIX,
    INNER_TVER,
    INNER_IOS,
    INNER_BUILD,

    // Word Hunt constants
    WORD_HUNT_GAME,
    WORD_HUNT_DISPLAY_NAME,
    WORD_HUNT_VERSION,
    WORD_HUNT_LANG,
    WORD_HUNT_DURATION_SECONDS,
    WORD_HUNT_MIN_WORD_LENGTH,
    WORD_HUNT_SCORES,
    WORD_HUNT_LONG_WORD_SCORE,
    WORD_HUNT_MODES,
    WORD_HUNT_LETTER_FREQUENCIES,
};

