// bridges/mac/sender.ts
// Outbound for the Mac line, one send at a time. Two ways to drive Messages:
//
//   imsg        the open-source `imsg` CLI (github.com/steipete/imsg). The
//               production system ran a pinned, patched build of it. Check
//               `imsg --help` on your version: texts and files use
//               `send --to/--text/--file`; voice notes, tapbacks and typing use
//               the subcommands that drive Messages directly (`send-attachment
//               --audio`, `tapback`, `typing`), which need an imsg build that
//               has them.
//   applescript osascript telling Messages.app to send. No extra install,
//               but slower, and macOS asks for Automation permission once.
//               Texts and files only: AppleScript cannot make a native voice
//               note, a tapback or a typing bubble, so those answer NotSupported.
//
// FILES. Stock imsg keeps only the LAST --file of one command (measured in
// production: two --file flags, one attachment in chat.db), so each file is
// its own send, after the text. AppleScript can only send files Messages may
// read: if a send "succeeds" with nothing delivered, copy the file under
// ~/Pictures first.
//
// Arguments go through argv, never through a shell or a script string, so a
// message cannot inject commands.

import { spawn } from 'node:child_process';

export type SendVia = 'imsg' | 'applescript';

export interface SenderOptions {
    via: SendVia;
    imsgPath: string;
    timeoutMs: number;
    run?: Runner;
}

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stderr: string }>;

export interface Media {
    files?: string[];
    // Send the single file as a native voice note (waveform bubble).
    audio?: boolean;
}

export interface Command {
    command: string;
    args: string[];
}

// The request is fine; this way of driving Messages cannot do it.
export class NotSupported extends Error {}

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

const APPLESCRIPT_FILE = [
    'on run argv',
    '  set targetHandle to item 1 of argv',
    '  set theFile to POSIX file (item 2 of argv)',
    '  tell application "Messages"',
    '    set targetService to 1st account whose service type = iMessage',
    '    send theFile to participant targetHandle of targetService',
    '  end tell',
    'end run',
];

// The imsg CLI reads any argument starting with "-" as an option.
export function argvSafeText(text: string): string {
    return text.replace(/^(?:-+\s*)+(?=\S)/, '');
}

// A Messages chat guid: a group id ("chat123...") is iMessage;+;, a person iMessage;-;.
export function chatGuidFor(to: string): string {
    if (to.includes(';')) return to;
    return /^chat\d+/.test(to) ? `iMessage;+;${to}` : `iMessage;-;${to}`;
}

function script(lines: string[], ...argv: string[]): Command {
    return { command: '/usr/bin/osascript', args: [...lines.flatMap((line) => ['-e', line]), ...argv] };
}

export function sendCommand(options: Pick<SenderOptions, 'via' | 'imsgPath'>, to: string, text: string): Command {
    if (options.via === 'imsg') return { command: options.imsgPath, args: ['send', '--to', to, '--text', argvSafeText(text)] };
    return script(APPLESCRIPT, to, text);
}

// Every command one send needs, in order: the text first, then the files.
export function sendCommands(options: Pick<SenderOptions, 'via' | 'imsgPath'>, to: string, text: string, media: Media = {}): Command[] {
    const files = (media.files ?? []).filter(Boolean);
    const commands = text ? [sendCommand(options, to, text)] : [];
    if (media.audio) {
        if (options.via !== 'imsg') throw new NotSupported('native voice notes need imsg (MAC_SEND_VIA=imsg)');
        if (files.length !== 1) throw new Error('a voice note is exactly one file');
        return [...commands, { command: options.imsgPath, args: ['send-attachment', '--chat', chatGuidFor(to), '--file', files[0], '--audio'] }];
    }
    for (const file of files) {
        commands.push(options.via === 'imsg' ? { command: options.imsgPath, args: ['send', '--to', to, '--file', file] } : script(APPLESCRIPT_FILE, to, file));
    }
    return commands;
}

// `guid` is the raw chat.db guid of the message to react to.
export function tapbackCommand(options: Pick<SenderOptions, 'via' | 'imsgPath'>, to: string, guid: string, kind: string): Command {
    if (options.via !== 'imsg') throw new NotSupported('tapbacks need imsg (MAC_SEND_VIA=imsg)');
    return { command: options.imsgPath, args: ['tapback', '--chat', chatGuidFor(to), '--message', guid, '--kind', kind, '--json'] };
}

export function typingCommand(options: Pick<SenderOptions, 'via' | 'imsgPath'>, to: string): Command {
    if (options.via !== 'imsg') throw new NotSupported('typing needs imsg (MAC_SEND_VIA=imsg)');
    return { command: options.imsgPath, args: ['typing', '--chat-guid', chatGuidFor(to)] };
}

export function defaultRun(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
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
    return function send(to: string, text: string, media: Media = {}): Promise<void> {
        let commands: Command[];
        try {
            commands = sendCommands(options, to, text, media);
        } catch (error) {
            return Promise.reject(error);
        }
        const job = chain.then(async () => {
            for (const { command, args } of commands) {
                const result = await run(command, args, options.timeoutMs);
                if (result.code !== 0) throw new Error(`send failed (exit ${result.code}): ${result.stderr}`);
            }
        });
        chain = job.catch(() => undefined);
        return job;
    };
}
