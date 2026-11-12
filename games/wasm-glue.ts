// games/wasm-glue.ts
// Loads the Emscripten glue for the Pool and Mini Golf physics engines. Those
// engines are compiled from third-party source and are NOT shipped in this
// repo (see games/README.md, "Pool and Mini Golf"). Install them as
// <GAMES_WASM_DIR>/golf-glue.cjs + golf.wasm and pool-glue.cjs + pool.wasm
// (default data/games/wasm). Without them both games decline politely.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

export type WasmEngine = 'golf' | 'pool';

export function wasmDir(): string {
    return resolve(process.env.GAMES_WASM_DIR || 'data/games/wasm');
}

export function wasmAvailable(name: WasmEngine): boolean {
    return existsSync(join(wasmDir(), `${name}-glue.cjs`)) && existsSync(join(wasmDir(), `${name}.wasm`));
}

// Returns the glue's module factory. The glue finds its .wasm next to itself.
export function wasmGlue<T = unknown>(name: WasmEngine): () => Promise<T> {
    return async () => {
        if (!wasmAvailable(name)) throw new Error(`${name} engine not installed in ${wasmDir()}`);
        const create = createRequire(import.meta.url)(join(wasmDir(), `${name}-glue.cjs`)) as () => Promise<T>;
        return create();
    };
}
