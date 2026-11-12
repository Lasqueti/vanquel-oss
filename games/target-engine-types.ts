// games/target-engine-types.ts
// Pure target-game state and the generated local golf WASM ABI. Replay inputs
// stay unknown until the existing parser/coercion. No validation is added.
export type TargetRandom = () => number;
export interface DotsBoard { size: number; edges: Set<string>; owner: Record<string, number>; edgeOwner: Record<string, number> }
export interface DotsOptions { doubleCross?: unknown; rng?: TargetRandom; blunderProb?: number }
export interface BasketballOptions { totalAttempts: number; madeCount: number; rng: TargetRandom }
export interface BasketballShot { t: number; x: number; c: number; made: number }
export interface TankShot { x0: number; y0: number; rotDeg: number; power01: number; wind: number; targetX: number; targetY: number; maxSteps?: number }
export interface TankAim { x0: number; y0: number; targetX: number; targetY: number; wind: number; powerRange?: number[]; rng?: TargetRandom }
export interface TankSolution { rotDeg: number; power01: number; minDist: number; hit: boolean }
export interface GolfStartView { x?: unknown; y?: unknown }
export interface LocalGolfWasm {
    HEAPF32: Float32Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    _golfGenerateMap(seed: number, hole: number, mode: number, output: number, capacity: number): number;
    _golfSimulateShot(x: unknown, y: unknown, vx: number, vy: number, output: number, capacity: number): number;
}
