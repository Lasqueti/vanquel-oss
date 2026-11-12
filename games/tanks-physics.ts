// games/tanks-physics.ts
import type { TankShot, TankAim, TankSolution } from './target-engine-types.ts';
// =============================================================================
// Tanks physics (game=tanks) - projectile sim + aim solver
// =============================================================================
//
// Pure logic, no I/O. Consumed by games/tanks-play.ts.
//
// Tanks is an AIM+POWER physics game: the reply carries a (rotation, power) that
// the RECIPIENT's client RE-SIMULATES to determine the hit. So a "handed-back
// outcome" is NOT enough - Bot must submit an aim+power that, re-simulated against
// the SAME terrain + wind, lands on the opponent tank. This module ports the
// Frida-measured iOS constants from the multi-game plan and searches for a hitting
// (rotation, power).
//
// FRIDA-MEASURED CONSTANTS (from docs/gamepigeon-multigame-plan.md §3.9, measured
// directly off iOS GamePigeon):
//   SHOT_FIXED_DT          = 1/60      integration step (s)
//   SHOT_GRAVITY_UNITS     = -200.8    px/s^2 (downward)
//   SHOT_SPEED_SLOPE_01    = 340.0047  v0 = SLOPE*power_01 + INTERCEPT
//   SHOT_SPEED_INTERCEPT   = 60.0029
//   SHOT_WIND_AX_PER_UNIT  = 11.9367   ax = wind * this
//   SHOT_MUZZLE_OFFSET_UNITS = 20.0
//   SHOT_BULLET_RADIUS     = 1.0
//   SHOT_TANK_HALF_W       = 11.5
//   SHOT_TANK_HALF_H       = 6.0
//
// WIRE (from docs §3.9): replay="board:height,0&wind,<w>&tank1x,<x>&tank1rot,<deg>&
//   tank1power,<0..1>&tank1hp,<n>&tank2x,<x>&tank2rot,<deg>&tank2power,<0..1>&
//   tank2hp,<n>|shoot:<player>". The move = set MY tankNrot + tankNpower + shoot:N.
//
// ============================ VERIFICATION STATUS ============================
// The physics constants are as-published by OpenPigeon's Frida measurement, but the
// EXACT board grammar (terrain height model, the `height` field's meaning, tank y
// from terrain, rotation convention/zero-direction, whether rotation is 0..180 or
// signed, wind sign) is UNCONFIRMED against a real Tanks capture - the dbs have
// none. FAIL-SAFE: solve() returns null (=> skip) unless the board parses into two
// tanks with x + power + rotation + hp. SEND IS OBSERVE-GATED (GP_TANKS_SEND) and
// STAYS OFF until a real capture confirms the grammar AND a self-test shows a
// solved shot actually lands (the recipient re-sim is the risk). See tanks-play.ts.
// =============================================================================

const SHOT_FIXED_DT = 1 / 60;
const SHOT_GRAVITY_UNITS = -200.8;
const SHOT_SPEED_SLOPE_01 = 340.0047;
const SHOT_SPEED_INTERCEPT = 60.0029;
const SHOT_WIND_AX_PER_UNIT = 11.9367;
const SHOT_MUZZLE_OFFSET_UNITS = 20.0;
const SHOT_BULLET_RADIUS = 1.0;
const SHOT_TANK_HALF_W = 11.5;
const SHOT_TANK_HALF_H = 6.0;

const DEG = Math.PI / 180;

// v0 from the 0..1 power slider.
function muzzleSpeed(power01: number) {
    return SHOT_SPEED_SLOPE_01 * power01 + SHOT_SPEED_INTERCEPT;
}

// -----------------------------------------------------------------------------
// simulate({ x0, y0, rotDeg, power01, wind, targetX, targetY, maxSteps }) ->
//   { hit, landingX, landingY, minDist }
// Integrate the projectile from the muzzle until it passes/reaches the target x or
// falls below it, returning whether it came within the tank hitbox of the target.
// Rotation convention (ASSUMED, capture must confirm): rotDeg is the barrel angle
// measured CCW from the +x axis; a shot to the RIGHT uses ~0..90, to the LEFT
// ~90..180. Wind adds a constant horizontal acceleration (ax = wind * PER_UNIT).
// -----------------------------------------------------------------------------
function simulate(params: TankShot) {
    const {
        x0, y0, rotDeg, power01, wind,
        targetX, targetY,
        maxSteps = 3000,
    } = params;
    const v0 = muzzleSpeed(power01);
    const rad = rotDeg * DEG;
    let x = x0;
    let y = y0;
    let vx = v0 * Math.cos(rad);
    let vy = v0 * Math.sin(rad);
    const ax = wind * SHOT_WIND_AX_PER_UNIT;
    const ay = SHOT_GRAVITY_UNITS;
    let minDist = Infinity;
    let landingX = x;
    let landingY = y;
    for (let i = 0; i < maxSteps; i++) {
        vx += ax * SHOT_FIXED_DT;
        vy += ay * SHOT_FIXED_DT;
        x += vx * SHOT_FIXED_DT;
        y += vy * SHOT_FIXED_DT;
        landingX = x;
        landingY = y;
        const dx = x - targetX;
        const dy = y - targetY;
        const dist = Math.hypot(dx, dy);
        if (dist < minDist) minDist = dist;
        // hitbox check (tank half-extents + bullet radius)
        if (Math.abs(dx) <= SHOT_TANK_HALF_W + SHOT_BULLET_RADIUS &&
            Math.abs(dy) <= SHOT_TANK_HALF_H + SHOT_BULLET_RADIUS) {
            return { hit: true, landingX: x, landingY: y, minDist: dist };
        }
        // stop if it has fallen well below the target and is moving down
        if (y < targetY - 400 && vy < 0) break;
    }
    return { hit: false, landingX, landingY, minDist };
}

// -----------------------------------------------------------------------------
// solveAim({ x0, y0, targetX, targetY, wind, powerRange, rotRange, rng }) ->
//   { rotDeg, power01, minDist, hit } | null
// Grid-search over (rotation, power) for a shot that hits, refining around the best
// candidate. Cheap: the sim is a few thousand tiny steps and the grid is coarse
// then locally refined. Returns the best found even if no exact hit (caller decides
// whether to send). Direction (aim toward the target) is chosen from targetX sign.
// -----------------------------------------------------------------------------
function solveAim(params: TankAim) {
    const {
        x0, y0, targetX, targetY, wind,
        powerRange = [0.15, 1.0],
        rng = Math.random,
    } = params;
    const aimRight = targetX >= x0;
    // rotation search band: right shots ~5..85, left shots ~95..175
    const rotLo = aimRight ? 5 : 95;
    const rotHi = aimRight ? 85 : 175;

    let best: TankSolution | null = null;
    // coarse grid
    for (let p = powerRange[0]; p <= powerRange[1] + 1e-9; p += 0.05) {
        for (let r = rotLo; r <= rotHi; r += 2) {
            const res = simulate({ x0, y0, rotDeg: r, power01: p, wind, targetX, targetY });
            if (!best || res.minDist < best.minDist) {
                best = { rotDeg: r, power01: p, minDist: res.minDist, hit: res.hit };
                if (res.hit) break;
            }
        }
        if (best && best.hit) break;
    }
    if (!best) return null;
    // local refine around the best candidate
    if (!best.hit) {
        for (let dp = -0.04; dp <= 0.04 + 1e-9; dp += 0.01) {
            for (let dr = -2; dr <= 2; dr += 0.5) {
                const p = Math.min(powerRange[1], Math.max(powerRange[0], best.power01 + dp));
                const r: number = best.rotDeg + dr;
                const res = simulate({ x0, y0, rotDeg: r, power01: p, wind, targetX, targetY });
                if (res.minDist < best.minDist) {
                    best = { rotDeg: r, power01: p, minDist: res.minDist, hit: res.hit };
                }
            }
        }
    }
    // ease-up: optional jitter is applied by the caller (tanks-play) via noise on
    // the returned aim, so this function always returns the best hit it can find.
    void rng;
    return best;
}

export const tanksPhysics = {
    // constants (exported for tests / verification)
    SHOT_FIXED_DT,
    SHOT_GRAVITY_UNITS,
    SHOT_SPEED_SLOPE_01,
    SHOT_SPEED_INTERCEPT,
    SHOT_WIND_AX_PER_UNIT,
    SHOT_MUZZLE_OFFSET_UNITS,
    SHOT_BULLET_RADIUS,
    SHOT_TANK_HALF_W,
    SHOT_TANK_HALF_H,
    muzzleSpeed,
    simulate,
    solveAim,
};

