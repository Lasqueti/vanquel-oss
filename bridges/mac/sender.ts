// bridges/mac/sender.ts
// Outbound for the Mac line, one send at a time. Two ways to drive Messages:
//
//   imsg        the open-source `imsg` CLI (github.com/steipete/imsg). The
//               production system ran a pinned, patched build of it. Check
//               `imsg send --help` on your version: this uses --to / --text.
//   applescript osascript telling Messages.app to send. No extra install,
//               but slower, and macOS asks for Automation permission once.
//
// Arguments go through argv, never through a shell or a script string, so a
// message cannot inject commands.

import { spawn } from 'node:child_process';

export type SendVia = 'imsg' | 'applescript';

export interface SenderOptions {
    via: SendVia;
    imsgPath: string;
    timeoutMs: number;
    run?: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stderr: string }>;
}

const APPLESCRIPT = [
    'on run argv',
    '  set targetHandle to item 1 of argv',
    '  set messageText to item 2 of argv',
    '  tell application "Messages"',
    '    set targetService to 1st account whose service type = iMessage',
    '    send messageText to participant targetHandle of targetService',
    '  end tell',
    'end run',
];

// The imsg CLI reads any argument starting with "-" as an option.
export function argvSafeText(text: string): string {
    return text.replace(/^(?:-+\s*)+(?=\S)/, '');
}

export function sendCommand(options: Pick<SenderOptions, 'via' | 'imsgPath'>, to: string, text: string): { command: string; args: string[] } {
    if (options.via === 'imsg') return { command: options.imsgPath, args: ['send', '--to', to, '--text', argvSafeText(text)] };
    const args = APPLESCRIPT.flatMap((line) => ['-e', line]);
    return { command: '/usr/bin/osascript', args: [...args, to, text] };
}

function defaultRun(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
        // stdin ignored: some CLIs block reading stdin when it is a pipe.
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => resolve({ code: -1, stderr: error.message }));
        child.on('close', (code) => resolve({ code: code ?? -1, stderr: stderr.slice(0, 500) }));
    });
}

export function createSender(options: SenderOptions) {
    const run = options.run ?? defaultRun;
    let chain: Promise<unknown> = Promise.resolve();
    return function send(to: string, text: string): Promise<void> {
        const job = chain.then(async () => {
            const { command, args } = sendCommand(options, to, text);
            const result = await run(command, args, options.timeoutMs);
            if (result.code !== 0) throw new Error(`send failed (exit ${result.code}): ${result.stderr}`);
        });
        chain = job.catch(() => undefined);
        return job;
    };
}
