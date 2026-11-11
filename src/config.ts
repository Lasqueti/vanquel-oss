// src/config.ts
// Environment loading and typed accessors. Every setting lives in `.env`
// (copy `.env.example`). Nothing here has a secret default.

import { existsSync } from 'node:fs';

export function loadEnvFile(path = '.env'): void {
    if (existsSync(path)) process.loadEnvFile(path);
}

export function env(name: string, fallback = ''): string {
    const value = process.env[name];
    return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function requireEnv(name: string): string {
    const value = env(name);
    if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    return value;
}

export function envInt(name: string, fallback: number): number {
    const value = Number.parseInt(env(name), 10);
    return Number.isFinite(value) ? value : fallback;
}

export function envBool(name: string, fallback = false): boolean {
    const value = env(name).toLowerCase();
    if (!value) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value);
}

// "a=http://x,b=http://y" -> { a: 'http://x', b: 'http://y' }
export function envMap(name: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of env(name).split(',')) {
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    return out;
}
