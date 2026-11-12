// games/cipher-types.ts
// Raw seed/text/map/mode inputs retain the original builtin coercions and failures.
// These erased read views add no guards, decoding defaults or crypto claims.
export interface CipherTextRead { length: number; [index: number]: unknown; slice(start: number, end?: number): unknown }
export interface CipherModeRead { gridSize: number; invalidPositions: Iterable<readonly [number, number]> }
export type CipherMapRead = Record<PropertyKey, unknown>;
export type BigIntOperand = bigint | boolean | number | string;
