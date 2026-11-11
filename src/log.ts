// src/log.ts
// One-line logs with a component tag. Handles are shortened to their last
// four characters so log files do not collect full phone numbers or emails.

export function createLogger(component: string) {
    const line = (level: string, message: string) => `${new Date().toISOString()} ${level} [${component}] ${message}`;
    return {
        info: (message: string) => console.log(line('info', message)),
        warn: (message: string) => console.warn(line('warn', message)),
        error: (message: string) => console.error(line('error', message)),
    };
}

export type Logger = ReturnType<typeof createLogger>;

export function tail(handle: string): string {
    return handle.length <= 4 ? '****' : `...${handle.slice(-4)}`;
}
