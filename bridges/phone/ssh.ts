// bridges/phone/ssh.ts
// Files to and from a line's phone over SSH: the tweak sends files that are
// already ON the phone, so the bridge copies them there first, and an inbound
// photo SMServer will not serve (rootless phones answer 404 for every
// Attachments/ path) is pulled back the same way.
//
// Key-based login only (BatchMode): a missing key fails fast instead of
// waiting on a password prompt. Remote paths go through the phone's shell, so
// they are always quoted, and the names this bridge makes are plain.

import { spawn } from 'node:child_process';

export interface RunResult {
    code: number;
    stdout: Buffer;
    stderr: string;
}

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const runProcess: Runner = (command, args, timeoutMs) => new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err.slice(0, 500) }));
});

// POSIX shell quoting for the remote half of a path.
export function shellQuote(value: string): string {
    if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// The extension of a path if it is plain letters and digits, else the
// fallback. It becomes part of a file name on the phone.
export function safeSuffix(path: string, fallback: string): string {
    const match = /\.[A-Za-z0-9]{1,10}$/.exec(path);
    return match ? match[0] : fallback;
}

export interface PhoneShellConfig {
    target: string;
    key?: string;
    run?: Runner;
}

export function createPhoneShell(config: PhoneShellConfig) {
    const run = config.run ?? runProcess;
    const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=accept-new', ...(config.key ? ['-i', config.key] : [])];

    async function check(label: string, promise: Promise<RunResult>): Promise<RunResult> {
        const result = await promise;
        if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
        return result;
    }

    return {
        copyTo: (local: string, remote: string) => check('scp to phone', run('scp', ['-O', '-q', ...options, local, `${config.target}:${shellQuote(remote)}`], 60_000)),
        copyFrom: (remote: string, local: string) => check('scp from phone', run('scp', ['-O', '-q', ...options, `${config.target}:${shellQuote(remote)}`, local], 60_000)),
        exec: (command: string, timeoutMs = 20_000) => check('ssh', run('ssh', [...options, config.target, command], timeoutMs)),
    };
}

export type PhoneShell = ReturnType<typeof createPhoneShell>;
