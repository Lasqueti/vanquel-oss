// bridges/phone/websocket.ts
// One text frame to SMServer's websocket (default port 8740). That is how
// SMServer shows a typing bubble: the frame "typing:<chat>" starts it and
// "idle:<chat>" ends it. A whole websocket client would be overkill for one
// fire-and-forget frame, so this writes the Upgrade handshake, waits for the
// "101" line (about 300 ms when all is well), writes one masked frame, gives
// SMServer a moment to read it, and hangs up.
//
// TRANSPORT. A plain TCP socket by default. With SMSERVER_VIA_CURL=1 (a
// process that cannot reach the phone's LAN address itself) it goes through
// `nc`, exactly as production did, since curl has no websocket support.
// A missing 101 is only reported; no answer at all throws.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// A client text frame: FIN + opcode 1, masked as RFC 6455 requires.
export function websocketTextFrame(text: string, mask: Buffer = randomBytes(4)): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;
    let header: Buffer;
    if (length <= 125) {
        header = Buffer.from([0x81, 0x80 | length]);
    } else if (length <= 65535) {
        header = Buffer.alloc(4);
        header.writeUInt8(0x81, 0);
        header.writeUInt8(0x80 | 126, 1);
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header.writeUInt8(0x81, 0);
        header.writeUInt8(0x80 | 127, 1);
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    return Buffer.concat([header, mask, masked]);
}

export function upgradeRequest(url: URL, key: string): Buffer {
    const port = Number(url.port || 80);
    const host = port === 80 ? url.hostname : `${url.hostname}:${port}`;
    return Buffer.from([
        `GET ${url.pathname || '/'}${url.search} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Origin: http://vanquel-bridge', '', '',
    ].join('\r\n'), 'ascii');
}

// The two ends of a connection, whatever carries it.
export interface Pipe {
    write(bytes: Buffer): void;
    onData(listener: (chunk: Buffer) => void): void;
    onClose(listener: (error?: Error) => void): void;
    end(): void;
}

function tcpPipe(host: string, port: number): Pipe {
    const socket = connect(port, host);
    return {
        write: (bytes) => void socket.write(bytes),
        onData: (listener) => void socket.on('data', listener),
        onClose: (listener) => {
            socket.on('error', listener);
            socket.on('close', () => listener());
        },
        end: () => socket.destroy(),
    };
}

function ncPipe(host: string, port: number): Pipe {
    const child = spawn('nc', ['-w', '3', host, String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    return {
        write: (bytes) => void child.stdin.write(bytes),
        onData: (listener) => void child.stdout.on('data', listener),
        onClose: (listener) => {
            child.on('error', listener);
            child.on('close', () => listener());
        },
        end: () => {
            child.stdin.end();
            child.kill('SIGTERM');
        },
    };
}

export interface WebsocketOptions {
    viaNc?: boolean;
    graceMs?: number;
    open?: (host: string, port: number) => Pipe;
}

export async function websocketSend(url: string, text: string, options: WebsocketOptions = {}): Promise<{ upgraded: boolean }> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:') throw new Error(`only ws:// websockets are supported, not ${parsed.protocol}`);
    const open = options.open ?? (options.viaNc ? ncPipe : tcpPipe);
    const pipe = open(parsed.hostname, Number(parsed.port || 80));
    let received = Buffer.alloc(0);
    let closed: Error | null = null;
    let ended = false;
    pipe.onData((chunk) => {
        received = Buffer.concat([received, chunk]);
    });
    pipe.onClose((error) => {
        ended = true;
        closed = error ?? null;
    });
    const firstLine = () => received.subarray(0, Math.max(0, received.indexOf('\r\n')) || received.length).toString('latin1');
    const upgraded = () => / 101 /.test(` ${firstLine()} `);
    try {
        pipe.write(upgradeRequest(parsed, randomBytes(16).toString('base64')));
        const deadline = Date.now() + 1500;
        // Until the status line is in (or the far end hangs up).
        while (Date.now() < deadline && !ended && received.indexOf(0x0a) < 0) await delay(20);
        if (upgraded()) {
            pipe.write(websocketTextFrame(text));
            await delay(options.graceMs ?? 850);
            return { upgraded: true };
        }
        if (!received.length) throw new Error(`no websocket answer from ${parsed.host}${closed ? `: ${(closed as Error).message}` : ''}`);
        return { upgraded: false };
    } finally {
        pipe.end();
    }
}
