// games/pool-types.ts
// Consumed contracts for pool geometry, replay cards, and the handwritten WASM ABI.
// Generated Emscripten glue and the compiled physics asset remain their own boundary.
export interface Point { x: number; y: number }
export interface Ball extends Point {
    n: number;
    f3?: number; f4?: number; r1?: number; r2?: number; r3?: number;
    onTable?: boolean; pocketed?: boolean; vx?: number; vy?: number;
}
export interface BallEntry extends Ball {
    f3: number; f4: number; r1: number; r2: number; r3: number; raw: string[];
}
export interface Shot { d: number; x: number; y: number; p: number; s?: number }
export interface RealBall extends Point { n: number; rot?: number; density?: number }
export interface RealPostBall extends Point { n: number; rot: number }
export interface PoolWasmBallRecord extends RealPostBall {
    sunkOrder: number;
    numberHit: number;
    holeX: number;
    holeY: number;
}
export interface SimulationResult {
    postBalls: RealPostBall[];
    potted: { n: number; order: number; pocket: Point }[];
    scratch: boolean;
    cue: ({ x: number; y: number; potted: false } | { x: null; y: null; potted: true });
    firstHit: number | null;
    cueSunk: boolean;
    frames: number;
}
export interface PoolWasmModule {
    HEAPF32: Float32Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    _simulateShot(input: number, count: number, direction: number, spinX: number,
        spinY: number, power: number, suit: number, first: number, output: number): number;
}
export type CreatePoolWasmModule = () => Promise<PoolWasmModule>;
export interface ApproximateShot { cueN?: number; d: number; power?: number }
export interface ApproximateSimulation {
    balls: Ball[]; pocketedThisShot: number[]; cueScratched: boolean; firstContact: number | null;
}
export interface FairPlay {
    factorToSkill(factor: number): number;
    mulberry32(seed: number): () => number;
    wildness(skill: number): number;
    chance(skill: number, maximum: number, random: () => number): boolean;
    bipolar(random: () => number): number;
    hashSeed(...parts: number[]): number;
}
export type Suit = 'solids' | 'stripes';
export interface PoolState { [field: string]: string | undefined }
export interface PlayerIdentity { botUuid?: string | null; botAvatar?: string | null }
export interface GameplayIdentity extends PlayerIdentity { player: number }
export interface LegalOptions { stripes?: number; botSuit?: Suit | null }
export interface SelectOptions { factor?: number; lock?: number; inStripes?: number; shotIndex?: number }
export interface RunOptions extends SelectOptions { player?: number; opponent?: number; botSuit?: Suit | null }
export interface Replay {
    d: number | null; x: number | null; y: number | null; p: number | null; s: number | null;
    pre: BallEntry[]; post: BallEntry[]; stripes: number | null; move: number | null;
    ballInHand: number | null; win: number | null;
}
export type SolveContext = { kind: 'finished' } | { kind: 'break'; seed: string | undefined }
    | { kind: 'shot'; parsed: Replay };
export interface ReplayOptions {
    pre: Ball[]; post: Ball[]; stripes: number; ballInHand?: number; win?: boolean;
}
export interface RunReplayOptions extends ReplayOptions { segments: Shot[] }
export interface SingleReplayOptions extends ReplayOptions, Shot {}
export interface Candidate {
    target: number; d: number; kind: string; pocket: Point | null; cut: number;
}
export interface ResolvedShot {
    target: number; d: number; p: number; pocket: Point | null; cut: number;
    real: SimulationResult; cueMargin: number; potted: number[]; isPot: boolean;
    kind?: string; tp?: number; claimObjects?: number; confidence?: number; robustness?: number;
    score?: number; endDist?: number;
}
export interface PotShot extends ResolvedShot {
    tp: number; claimObjects: number; confidence: number; robustness: number;
}
export interface NearMissShot extends ResolvedShot { tp: number; endDist: number }
export interface RunSegment extends Shot {
    s: number; kind: string; target: number; pocket: Point | null; cut: number;
    cueMargin: number; firstContact: number | null; isPot: boolean; claim: number[]; endDist?: number;
}
export interface Skipped { skip: string }
export type Selection = Skipped | { kind: string; shot: ResolvedShot; candidates: number; skip?: never };
export interface PlannedRun {
    segments: RunSegment[]; finalPost: Ball[]; outStripes: number; botSuit: Suit | null;
    win: boolean; claim: number[]; firstContact: number | null; cueMargin: number; kinds: string[];
    skip?: never;
}
