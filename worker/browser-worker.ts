// worker/browser-worker.ts
// The browser worker: a separate process on the Mac mini that runs web tasks
// for the agent in real Chrome. Separate so a restart of the agent server
// never kills a task half way. Listens on 127.0.0.1 only.
//   POST /tasks             {id, goal, startUrl?, profile, callbackUrl}  -> 202
//   GET  /tasks/<id>        status
//   POST /tasks/<id>/cancel
//   GET  /health
// All but /health need X-Worker-Secret. When a task ends, the result is
// POSTed to callbackUrl (the agent server), which texts it to the person.
// Run: npm run worker

import { env, envBool, envInt, loadEnvFile, requireEnv } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import { HttpError, header, json, parseJson, safeEqual, startHttp } from '../src/http.ts';
import type { Req } from '../src/http.ts';
import { createLlm } from '../src/agent/llm.ts';
import { runLoop } from './loop.ts';
import type { LoopResult } from './loop.ts';
import { openChrome } from './chrome-page.ts';

loadEnvFile();
const log = createLogger('browser-worker');
const secret = requireEnv('BROWSER_WORKER_SECRET');
const maxTasks = envInt('WORKER_MAX_TASKS', 2);
const llm = createLlm({ baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1'), apiKey: requireEnv('LLM_API_KEY'), model: env('WORKER_LLM_MODEL') || requireEnv('LLM_MODEL') });

interface Task {
    id: string;
    profile: string;
    status: 'running' | LoopResult['status'];
    summary: string;
    cancelled: boolean;
}

const tasks = new Map<string, Task>();
const running = () => [...tasks.values()].filter((t) => t.status === 'running');

function requireSecret(req: Req): void {
    if (!safeEqual(header(req, 'x-worker-secret'), secret)) throw new HttpError(401, 'bad worker secret');
}

async function report(callbackUrl: string, task: Task): Promise<void> {
    try {
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': secret },
            body: JSON.stringify({ id: task.id, status: task.status, summary: task.summary }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (error) {
        log.error(`callback for ${task.id} failed: ${(error as Error).message}`);
    }
}

async function run(task: Task, goal: string, startUrl: string | undefined, callbackUrl: string): Promise<void> {
    let close: (() => Promise<void>) | undefined;
    try {
        const chrome = await openChrome({ profilesDir: env('WORKER_PROFILES_DIR', 'data/browser-profiles'), profile: task.profile, headless: envBool('WORKER_HEADLESS'), executablePath: env('CHROME_PATH') || undefined });
        close = chrome.close;
        const result = await runLoop({
            goal,
            startUrl,
            page: chrome.page,
            llm,
            maxSteps: envInt('WORKER_MAX_STEPS', 25),
            deadline: Date.now() + envInt('WORKER_TASK_TIMEOUT_MS', 8 * 60_000),
            isCancelled: () => task.cancelled,
        });
        task.status = result.status;
        task.summary = result.summary;
        log.info(`task ${task.id} ${result.status} after ${result.steps} steps`);
    } catch (error) {
        task.status = 'failed';
        task.summary = 'The web task hit an error and stopped.';
        log.error(`task ${task.id} failed: ${(error as Error).message}`);
    } finally {
        await close?.().catch(() => undefined);
    }
    await report(callbackUrl, task);
}

startHttp({
    'GET /health': () => json(200, { ok: true, running: running().length }),
    'POST /tasks': (req) => {
        requireSecret(req);
        const body = parseJson(req);
        const id = String(body.id ?? '');
        const goal = String(body.goal ?? '').trim();
        const profile = String(body.profile ?? '');
        const callbackUrl = String(body.callbackUrl ?? '');
        if (!id || !goal || !profile || !callbackUrl) throw new HttpError(400, 'id, goal, profile and callbackUrl are required');
        if (running().length >= maxTasks) throw new HttpError(429, 'worker is busy');
        if (running().some((t) => t.profile === profile)) throw new HttpError(409, 'this person already has a task running');
        const task: Task = { id, profile, status: 'running', summary: '', cancelled: false };
        tasks.set(id, task);
        void run(task, goal, body.startUrl ? String(body.startUrl) : undefined, callbackUrl);
        return json(202, { ok: true });
    },
    'GET /tasks/*': (req) => {
        requireSecret(req);
        const task = tasks.get(req.path.split('/')[2] ?? '');
        if (!task) throw new HttpError(404, 'no such task');
        return json(200, { id: task.id, status: task.status, summary: task.summary });
    },
    'POST /tasks/*': (req) => {
        requireSecret(req);
        const [, , id, verb] = req.path.split('/');
        const task = tasks.get(id ?? '');
        if (!task || verb !== 'cancel') throw new HttpError(404, 'no such task');
        task.cancelled = true;
        return json(200, { ok: true });
    },
}, envInt('BROWSER_WORKER_PORT', 3105), '127.0.0.1', (m) => log.error(m));
log.info('ready');
