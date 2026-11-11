# Browser worker

When a customer asks for something that needs a website ("is the 5:40 ferry running today?", "what are the opening hours on their site?"), the agent calls the `browse_web` tool. The browser worker opens real Google Chrome on the Mac mini, works through the task, and the result is texted to the person when it is done.

It is a deliberately small rebuild of the production version: same shape (separate process, real Chrome, one profile per customer, a step loop, hard stops), without the production system's account, payment and document features.

## How it works

- A separate process (`npm run worker`) on `127.0.0.1:3105`, so restarting the agent server never kills a task. The server and worker share `BROWSER_WORKER_SECRET`.
- Real Chrome through [puppeteer-core](https://pptr.dev), visible by default on the Mac's desktop. Many sites block headless browsers; set `WORKER_HEADLESS=1` if you prefer.
- Each step: a text snapshot of the page (numbered buttons, links and fields, plus the page text inside a random fence), the model answers with one JSON action (`goto`, `click`, `type`, `press`, `scroll`, `back`, `done`, `needs_human`), the worker does it.
- Limits: `WORKER_MAX_STEPS` (25), `WORKER_TASK_TIMEOUT_MS` (8 minutes), `WORKER_MAX_TASKS` at once (2), one task per customer.

## What it refuses

- **Spending money.** It stops before clicking anything labelled buy, pay, checkout, place order, subscribe, donate and similar, and hands back.
- **Secrets.** It will not type into password, card, security code or one-time code fields.
- **Your network.** It will not open localhost, private network ranges, link-local or cloud metadata addresses; every request Chrome makes is checked, not just the address bar.
- **Instructions inside pages.** Page text is fenced and the model is told it is data. Invisible characters that can hide instructions are stripped. This lowers the risk of prompt injection; it does not remove it. Do not give the worker access to anything you could not afford a hostile web page to see.

## Isolation, honestly

Each customer gets their own Chrome profile directory (mode 0700) under `WORKER_PROFILES_DIR`, so their cookies do not mix. That is separation, not a sandbox: every profile runs as the same macOS user. Run the worker under a macOS user that can read nothing sensitive, on a network where the Mac can reach nothing you would not expose to the internet. A public hostname that resolves to a private address (DNS rebinding) is only partly covered.

There is no VM. If you need real isolation, run the worker inside a macOS virtual machine or on a separate machine and point `BROWSER_WORKER_URL` at it (and change its listen address and the loopback check in `/internal/browse-result` accordingly).
