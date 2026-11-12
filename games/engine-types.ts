// games/engine-types.ts
// Engine inputs are in-process numeric game state. Wire strings remain unknown
// until each engine's existing parsing/coercion; generated physics crosses the
// explicit WASM ABI below. No validation or randomness is added here.
export interface Point2 { x: number; y: number }
export interface Point3 extends Point2 { z: number }
export type Random = () => number;
export interface BeerTurnOptions {
    mode: unknown; skill: number; rng: Random; randomPositions?: Point3[];
    rackTarget: number[]; redemption?: unknown;
}
export interface BeerTurnResult { throws: BeerThrow[]; target: unknown; made: number; cleared: boolean; overtime?: boolean; ownReset?: number[]; lostRedemption?: boolean }
export interface BeerThrow { traj: string; cup: number | null }
export interface BeerBuildReplay { startRack1: number[]; startRack2: number[]; endRack1: number[]; endRack2: number[]; throws: BeerThrow[] }
export interface BeerParsedMove { frames: Point3[]; cup: number | null; made: number; len: number }
export interface DartTarget { number: number; mult: number; points: number }
export interface DartOptions { aggression?: number; seed?: number; gameId?: number }
export interface DartJitter { jr?: unknown; ja?: unknown }
export interface FillOptions { depth?: number; blunderProb?: number; rng?: Random; finishGreedy?: unknown }
export interface FillChild { c: number; nb: number[]; g: number }
export interface FillChoice { color: number; v: number; gain: number }
export interface GolfStroke { dist: number; rotation: number }
export interface GolfMap {
    seed: number; mode: string; holeIndex: number; mapNum: number; key: string;
    rows: number; cols: number; tileSize: number; mapSize: unknown;
    grid: number[][]; walls: unknown; banks: unknown; slopes: unknown;
    obstacles: (Point2 & { kind: number; scale?: number })[];
    hole: Point2; ballStart1: Point2; ballStart2: Point2; tee: Point2;
}
export interface GolfWasm {
    HEAPF32: Float32Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    _golfGenerateMap(seed: number, hole: number, mode: number, output: number, capacity: number): number;
    _golfSimulateShot(x: number, y: number, vx: number, vy: number, output: number, capacity: number): number;
}
export interface GolfOptions { maxStrokes?: number }
export interface GolfPlan { sunk: boolean; strokes: GolfStroke[]; robustness: number }
export interface GolfFrontier { pos: Point2; path: GolfStroke[]; dcup?: number }
export interface GolfSink extends GolfStroke { rob: number; sc: number; frames?: number; pos?: Point2; sunk?: boolean }
export interface GolfReach extends GolfStroke { pos: Point2; sunk: boolean }
