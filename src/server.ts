// src/server.ts
// The agent server: reads .env, turns on each channel whose settings are
// present, and serves the routes in src/app.ts. Run: npm start

import { readFileSync } from 'node:fs';
import { env, envBool, envInt, envMap, loadEnvFile, requireEnv } from './config.ts';
import { createLogger } from './log.ts';
import { startHttp } from './http.ts';
import { openStore } from './store.ts';
import type { Channel } from './channels/types.ts';
import { createRouter } from './channels/router.ts';
import { createIMessageChannel } from './channels/imessage.ts';
import { createTwilioChannel } from './channels/sms-twilio.ts';
import { createPostmarkChannel } from './channels/email-postmark.ts';
import { createSlackChannel, createSlackClient } from './channels/slack.ts';
import { createLlm } from './agent/llm.ts';
import { buildTools } from './agent/tools.ts';
import { createPipeline } from './agent/pipeline.ts';
import { createImageLoader } from './agent/media.ts';
import { createVoiceNotes } from './agent/voice-note.ts';
import { createCardRenderer } from './cards/render.ts';
import { writeContactCard } from './agent/contact-card.ts';
import { createOperator } from './operator.ts';
import { createAlerter } from './ops/alert.ts';
import { createReminderRunner } from './reminders.ts';
import { createBrowseClient } from './browse-client.ts';
import { createRoutes } from './app.ts';

loadEnvFile();
const log = createLogger('server');
const store = openStore(env('DATABASE_PATH', 'data/agent.sqlite'));
const alert = createAlerter(env('ALERT_SLACK_WEBHOOK_URL'), (m) => log.warn(m));
const port = envInt('PORT', 3000);

// ---- channels: each one is on when its settings are present ----
const channels: Channel[] = [];
const lines = envMap('IMESSAGE_LINES');
if (Object.keys(lines).length) {
    channels.push(createIMessageChannel({ lines, defaultLine: env('IMESSAGE_DEFAULT_LINE', Object.keys(lines)[0]), bridgeKey: requireEnv('BRIDGE_KEY') }));
}
if (env('TWILIO_ACCOUNT_SID')) {
    channels.push(createTwilioChannel({ accountSid: env('TWILIO_ACCOUNT_SID'), authToken: requireEnv('TWILIO_AUTH_TOKEN'), fromNumber: requireEnv('TWILIO_FROM_NUMBER') }));
}
const postmark = env('POSTMARK_SERVER_TOKEN') ? createPostmarkChannel({ serverToken: env('POSTMARK_SERVER_TOKEN'), fromAddress: requireEnv('EMAIL_FROM_ADDRESS') }) : null;
if (postmark) channels.push(postmark);
const slackClient = env('SLACK_BOT_TOKEN') ? createSlackClient({ botToken: env('SLACK_BOT_TOKEN') }) : null;
if (slackClient && envBool('SLACK_DM_CHANNEL', true)) channels.push(createSlackChannel(slackClient));

const router = createRouter(store, channels);
const operatorChannel = env('SLACK_OPERATOR_CHANNEL');
const operator = createOperator({
    store,
    log,
    slack: slackClient && operatorChannel ? { client: slackClient, channel: operatorChannel } : undefined,
    email: postmark && env('OPERATOR_EMAIL') ? { channel: postmark, to: env('OPERATOR_EMAIL') } : undefined,
});

const workerUrl = env('BROWSER_WORKER_URL');
const workerSecret = env('BROWSER_WORKER_SECRET');
const browse = workerUrl && workerSecret ? createBrowseClient(workerUrl, workerSecret, `http://127.0.0.1:${port}/internal/browse-result`) : undefined;

// ---- media: photos in (LLM_VISION), voice notes out (TTS_MODEL), cards (CARDS), contact card ----
const llmBaseUrl = env('LLM_BASE_URL', 'https://api.openai.com/v1');
const mediaDir = env('MEDIA_DIR', 'data/media');
const loadImage = envBool('LLM_VISION') ? createImageLoader({ bridgeUrls: Object.values(lines), bridgeKey: env('BRIDGE_KEY') }) : undefined;
const voiceNotes = env('TTS_MODEL') && Object.keys(lines).length
    ? createVoiceNotes({ baseUrl: env('TTS_BASE_URL', llmBaseUrl), apiKey: env('TTS_API_KEY', env('LLM_API_KEY')), model: env('TTS_MODEL'), voice: env('TTS_VOICE', 'alloy'), outDir: mediaDir })
    : undefined;
// CARDS=1: picture cards (src/cards/), drawn by headless Chrome. iMessage only.
const cards = envBool('CARDS') && Object.keys(lines).length
    ? createCardRenderer({ outDir: mediaDir, theme: env('CARD_THEME') === 'dark' ? 'dark' : 'light', timeZone: env('TIMEZONE', 'UTC'), executablePath: env('CHROME_PATH') || undefined })
    : undefined;
let contactCardPath: string | undefined;
if (envBool('SEND_CONTACT_CARD')) {
    if (env('CONTACT_PHONE')) contactCardPath = writeContactCard(mediaDir, { name: env('AGENT_NAME', 'Assistant'), org: env('BUSINESS_NAME'), phone: env('CONTACT_PHONE') });
    else log.warn('SEND_CONTACT_CARD is on but CONTACT_PHONE is empty; not sending contact cards');
}

const businessInfoFile = env('BUSINESS_INFO_FILE');
const pipeline = createPipeline({
    store,
    router,
    llm: createLlm({ baseUrl: llmBaseUrl, apiKey: requireEnv('LLM_API_KEY'), model: requireEnv('LLM_MODEL') }),
    tools: buildTools({ browse: Boolean(browse), voice: Boolean(voiceNotes), cards: Boolean(cards) }),
    operator,
    browse,
    loadImage,
    voiceNotes,
    cards,
    log: createLogger('agent'),
    config: {
        agentName: env('AGENT_NAME', 'Assistant'),
        businessName: env('BUSINESS_NAME', 'our business'),
        businessInfo: businessInfoFile ? readFileSync(businessInfoFile, 'utf8') : '',
        timeZone: env('TIMEZONE', 'UTC'),
        historyLimit: envInt('HISTORY_LIMIT', 30),
        maxRepliesPerHour: envInt('MAX_REPLIES_PER_HOUR', 30),
        debounceMs: envInt('REPLY_DEBOUNCE_MS', 1500),
        maxToolRounds: envInt('MAX_TOOL_ROUNDS', 5),
        contactCardPath,
    },
});

const routes = createRoutes({
    store,
    pipeline,
    router,
    log,
    cards,
    config: {
        bridgeKey: env('BRIDGE_KEY'),
        adminToken: env('ADMIN_TOKEN'),
        publicBaseUrl: env('PUBLIC_BASE_URL').replace(/\/+$/, ''),
        twilioAuthToken: env('TWILIO_AUTH_TOKEN') || undefined,
        emailInboundToken: env('EMAIL_INBOUND_TOKEN') || undefined,
        slack: slackClient && env('SLACK_SIGNING_SECRET') ? { signingSecret: env('SLACK_SIGNING_SECRET'), operatorChannel, client: slackClient } : undefined,
        workerSecret: workerSecret || undefined,
    },
});

const reminders = createReminderRunner(store, router, alert);
reminders.start(30_000);
startHttp(routes, port, env('HOST', '127.0.0.1'), (m) => log.error(m));
const extras = [browse && 'browser worker', loadImage && 'vision', voiceNotes && 'voice notes', cards && 'cards', contactCardPath && 'contact card'].filter(Boolean).join(', ');
log.info(`listening on ${env('HOST', '127.0.0.1')}:${port}; channels: ${channels.map((c) => c.id).join(', ') || 'none'}${extras ? `; on: ${extras}` : ''}`);
