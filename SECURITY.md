# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's "Report a vulnerability" (Security tab of this repository), not in a public issue. We aim to reply within a week.

## Hardening checklist

- Every process listens on `127.0.0.1`. Only `/channels/*` should be reachable from the internet, through a tunnel or HTTPS proxy.
- `BRIDGE_KEY`, `ADMIN_TOKEN`, `BROWSER_WORKER_SECRET`, `EMAIL_INBOUND_TOKEN`: long random values (`openssl rand -hex 32`), different from each other.
- `.env` and `lines/*.env` are mode 600 and never committed. `npm run scan` before every commit.
- Phones on their own network that only the Mac can reach. SMServer runs without TLS and must never be exposed.
- Change the default `mobile` and `root` passwords on every jailbroken phone, and prefer SSH keys.
- Keep the jailbroken phones' SSH and SMServer passwords out of shell history and command lines (the scripts read them from the environment).
- The browser worker runs as a macOS user that can read nothing sensitive.
- Back up `data/agent.sqlite` encrypted. It holds customer conversations.
