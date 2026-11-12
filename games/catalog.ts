// games/catalog.ts
// One reviewed public capability list for GamePigeon routing, onboarding, and
// unsupported-game fallbacks. Keep staged/observe-only games out of this list.
const LIVE_GAME_NAMES = Object.freeze([
    'Word Hunt',
    'Anagrams',
    'Darts',
    'Archery',
    'Mini Golf',
    'Filler',
    '8 Ball',
    'Word Bites',
    'Basketball',
    'Cup Pong',
    'Dots',
]);

// What Bot suggests when it cannot play the game they sent: games seen finishing
// in real play. Anagrams used to be the suggestion and had never finished one
// (games review, 2026-10-03).
const SUGGESTED_GAME_NAMES = Object.freeze(['Darts', 'Mini Golf', 'Archery']);

export const catalog = { LIVE_GAME_NAMES, SUGGESTED_GAME_NAMES };

