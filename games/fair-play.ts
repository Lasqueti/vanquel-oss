// games/fair-play.ts
import type { GameRandom, GameHash, SkillOptions, CatchupOptions } from './strength-types.ts';
import { rubberBand as rb } from './rubber-band.ts';
// =============================================================================
// Shared fair-play difficulty map for GamePigeon games (pure, no I/O)
// =============================================================================
//
// ONE PLACE that turns the shared rubber-band handicap `factor` into a per-game
// SKILL / MISS level, so every game - present and future (connect4, tanks, ...) -
// gets the same self-tuning "beatable ~half the time" behaviour by calling one
// helper instead of hand-rolling a difficulty ladder (the ladders were exactly
// what made darts/archery unbeatable: they SATURATED, so no number of Bot wins
// could ever weaken the play).
//
// The two failure modes this module is built to prevent:
//   1. SATURATION - a discrete ladder where the adaptive floor maps to the same
//      strength as several bands above it, so easing "runs out of room" while
//      Bot is still superhuman. factorToSkill() is CONTINUOUS across the whole
//      adaptive band, so the floor genuinely reaches weak play.
//   2. NO MISS MODEL - an aim/skill game that only changes WHICH target it picks
//      but never actually ERRS, so it is flawless at every difficulty. wildness()
//      + the scatter samplers give a game a real, deterministic error magnitude
//      that GROWS as skill drops; the game applies it and RE-SCORES the actual
//      landing honestly (never fakes a number).
//
// This module deliberately does NOT own any policy of its own beyond the map:
//   - It never records results (that's the watcher + rubber-band.updateAdaptiveState).
//   - It never decides a move (that's each game's engine).
//   - It reads rubber-band's band constants read-only so the anchors stay in sync;
//     it changes NOTHING about rubber-band's shared behaviour.
// =============================================================================

// Read-only view of the adaptive band so the skill anchors track rubber-band's
// clamp. We only READ these constants; rubber-band's behaviour is untouched.
const BAND_MIN = rb.ADAPTIVE_MIN != null ? rb.ADAPTIVE_MIN : 0.60; // factor floor
const BAND_MAX = rb.ADAPTIVE_MAX != null ? rb.ADAPTIVE_MAX : 1.30; // factor ceiling
const BAND_START = rb.ADAPTIVE_START != null ? rb.ADAPTIVE_START : 0.90;

function clamp(x: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, x));
}

// -----------------------------------------------------------------------------
// SKILL_CAP - the hard ceiling on what factorToSkill can return, i.e. the
// STRONGEST Bot ever plays in any aim/skill game. 1.0 meant literally flawless
// (zero scatter: every archery arrow a bullseye, every golf hole optimal, darts
// never misses a checkout) - superhuman scores that read as robotic and killed
// the competition ("try your hardest" should be a strong HUMAN, not an aimbot).
// 0.87 is tuned so the top end still errs visibly but rarely:
//   archery: ~72% bullseyes (set avg ~29/30 with real ring-9s, not a wall of Xs)
//   minigolf: ~+0.78 strokes/hole over optimal (mostly 2s, some aces, some 3s)
//   darts/pool: 13% of max scatter - hits most checkouts/pots, misses some
// Applies to EVERY factorToSkill consumer centrally (including games that pass
// an explicit at1:1.0), so no per-game edit is needed and the adaptive ceiling
// (factor ~1.30) also tops out at strong-human instead of flawless. The mid-band
// adaptive ~50% behaviour is unchanged (the cap only binds above factor ~1.20).
// -----------------------------------------------------------------------------
const SKILL_CAP = 0.87;

// -----------------------------------------------------------------------------
// mulberry32(seed) -> rng() in [0,1). Tiny, fast, deterministic PRNG. Same one
// darts-engine uses; shared here so every game seeds misses/decisions the SAME
// reproducible way (testable, no Math.random in the decision path).
// -----------------------------------------------------------------------------
function mulberry32(seed: number) {
    let a = (seed >>> 0) || 1;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// -----------------------------------------------------------------------------
// hashSeed(...args) -> uint32. Fold arbitrary numbers/strings into one 32-bit
// seed (FNV-1a-ish) so a game can derive a deterministic RNG from its own state
// (board seed, hole index, ball layout, opponent remaining, ...). Different
// inputs => different-but-reproducible seed, so the miss/decision varies game to
// game yet is fully deterministic for a given state.
// -----------------------------------------------------------------------------
function hashSeed(...values: Parameters<GameHash>): number;
function hashSeed() {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arguments.length; i++) {
        const s = String(arguments[i]);
        for (let j = 0; j < s.length; j++) {
            h ^= s.charCodeAt(j);
            h = Math.imul(h, 16777619) >>> 0;
        }
        h ^= 0x9e3779b9; // separator between args
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

// -----------------------------------------------------------------------------
// factorToSkill(factor, opts) -> skill in [floor, 1].
// The core map. CONTINUOUS across the adaptive band so easing actually reaches
// genuinely-weak play instead of a saturating ladder.
//
// Default anchors reproduce darts' proven curve exactly:
//   factor 0.60 (adaptive floor) -> skill 0.08   (very weak)
//   factor 0.90 (neutral)        -> skill ~0.47
//   factor 1.00 (match)          -> skill ~0.61
//   factor 1.30 (adaptive ceil)  -> skill 0.87   (SKILL_CAP: strong human)
// Linear between; clamped to [floorClamp, SKILL_CAP]. A FIXED difficulty can
// pass a factor outside the band (chill 0.45, max 3.0) - the clamp handles it:
// chill clamps to the weak floor, max to SKILL_CAP (tough but human, never the
// old flawless-robot skill 1.0 - see SKILL_CAP above).
//
// opts (all optional):
//   minFactor / maxFactor : band endpoints (default rubber-band's 0.60 / 1.30)
//   at0  : skill AT minFactor (default 0.08)   - the weakest adaptive floor
//   at1  : skill AT maxFactor (default 1.00, still capped by SKILL_CAP)
//   floorClamp : hard lower clamp on the result (default 0.02)
// A game that wants a gentler or harsher floor overrides at0 (e.g. a game whose
// "skill 0.08" is still too strong passes a lower at0).
// -----------------------------------------------------------------------------
function factorToSkill(factor: number, opts?: SkillOptions | null) {
    opts = opts || {};
    const loF = opts.minFactor != null ? opts.minFactor : BAND_MIN;
    const hiF = opts.maxFactor != null ? opts.maxFactor : BAND_MAX;
    const at0 = opts.at0 != null ? opts.at0 : 0.08;
    const at1 = opts.at1 != null ? opts.at1 : 1.00;
    const floorClamp = opts.floorClamp != null ? opts.floorClamp : 0.02;
    const f = Number.isFinite(factor) ? factor : BAND_START;
    const span = (hiF - loF) || 1;
    const t = (f - loF) / span;              // 0 at floor, 1 at ceil (can exceed for fixed diff)
    const s = at0 + t * (at1 - at0);
    return clamp(s, floorClamp, Math.min(Math.max(at0, at1), SKILL_CAP));
}

// -----------------------------------------------------------------------------
// wildness(skill) -> 1 - skill, clamped to [0,1]. The error magnitude knob: a
// game scales its own max spread / miss probability by this, so at skill 1 the
// game is flawless (wildness 0 => zero scatter, byte-identical to the old perfect
// engine) and at the floor the game misses the most.
// -----------------------------------------------------------------------------
function wildness(skill: number) {
    return clamp(1 - skill, 0, 1);
}

// -----------------------------------------------------------------------------
// bipolar(rng) -> a symmetric sample in [-1, 1] with a soft bell shape (average
// of two uniforms => triangular), so scatter clusters near 0 (small misses common,
// big sprays rare) like a real human. Deterministic given rng.
// -----------------------------------------------------------------------------
function bipolar(rng: GameRandom) {
    return (rng() + rng()) - 1; // triangular on [-1,1], peak at 0
}

// -----------------------------------------------------------------------------
// scatter(skill, maxSpread, rng) -> a signed error in [-maxSpread, +maxSpread]
// scaled by wildness. A game ADDS this to its aim quantity (a radius, an angle,
// a power) and then RE-SCORES the actual landing honestly. At skill 1 it returns
// 0 (perfect). Deterministic given rng.
// -----------------------------------------------------------------------------
function scatter(skill: number, maxSpread: number, rng: GameRandom) {
    return bipolar(rng) * wildness(skill) * maxSpread;
}

// -----------------------------------------------------------------------------
// extraCount(skill, maxExtra, rng) -> an integer 0..maxExtra that GROWS as skill
// drops (mean = wildness * maxExtra), for count-based weakening (e.g. extra golf
// strokes). Deterministic given rng; at skill 1 returns 0.
// -----------------------------------------------------------------------------
function extraCount(skill: number, maxExtra: number, rng: GameRandom) {
    const mean = wildness(skill) * maxExtra;
    // fractional part decided by rng so the count is continuous in aggregate.
    const base = Math.floor(mean);
    const frac = mean - base;
    const bump = rng() < frac ? 1 : 0;
    return clamp(base + bump, 0, maxExtra);
}

// -----------------------------------------------------------------------------
// chance(skill, maxProb, rng) -> boolean true with probability wildness*maxProb.
// The generic "does Bot flub this?" gate (miss a pot, play safe instead of
// potting, ...). At skill 1 the probability is 0 (never flubs). Deterministic.
// -----------------------------------------------------------------------------
function chance(skill: number, maxProb: number, rng: GameRandom) {
    return rng() < wildness(skill) * maxProb;
}

// -----------------------------------------------------------------------------
// catchupSignal(lead, scale) -> a normalized read of the CURRENT game's margin in
// [-1, 1], for WITHIN-GAME catch-up. `lead` is Bot's advantage in the game's own
// unit RIGHT NOW (opp remaining - bot remaining in a darts race, bot boxes - opp
// boxes in dots, opp strokes - bot strokes in golf, ...); `scale` normalizes it to
// the game's blowout size. Positive => Bot is WINNING (a game should genuinely ease
// its remaining rounds/turns to keep it close); negative => Bot is LOSING (push).
//
// Each game translates the signal into its own honest weakening knob (more strokes,
// lower aggression, more blunders) - never a faked score. `applyCatchup` below is the
// standard translation into a multiplier for a "strength" knob.
// -----------------------------------------------------------------------------
function catchupSignal(lead: number, scale: number) {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const l = Number.isFinite(lead) ? lead : 0;
    return clamp(l / s, -1, 1);
}

// applyCatchup(strength, signal, opts) -> strength scaled to keep a mid-game blowout
// close. signal>0 (Bot winning) eases (multiplier < 1, weaker); signal<0 (losing)
// pushes (multiplier > 1, stronger). Bounded so it nudges, never throws the game or
// makes the easing obvious.
function applyCatchup(strength: number, signal: number, opts?: CatchupOptions | null) {
    opts = opts || {};
    const maxEase = opts.maxEase != null ? opts.maxEase : 0.40; // ≤40% weaker when way ahead
    const maxPush = opts.maxPush != null ? opts.maxPush : 0.30; // ≤30% stronger when way behind
    const s = clamp(Number.isFinite(signal) ? signal : 0, -1, 1);
    const mult = s >= 0 ? (1 - s * maxEase) : (1 - s * maxPush); // s<0 -> >1
    return strength * mult;
}

export const fairPlay = {
    mulberry32,
    hashSeed,
    factorToSkill,
    wildness,
    bipolar,
    scatter,
    extraCount,
    chance,
    catchupSignal,
    applyCatchup,
    clamp,
    BAND_MIN,
    BAND_MAX,
    BAND_START,
    SKILL_CAP,
};

