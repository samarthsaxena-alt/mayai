# Setup

Requires **Node 22+**.

```bash
npm install
cp .env.example .env
```

## 1. Get a PyAI key

**For development** — a cardless **sandbox key** covers everything except buying a
phone number:

```bash
curl -sX POST https://api.pyai.com/v1/sandbox/keys \
  -H "Content-Type: application/json" \
  -d '{"label":"mayai"}'
```

Sandbox keys are per-network rate-limited and appear to auto-suspend temporarily
under heavy request volume — one returned 401 mid-build after normal iterative
testing, then recovered on its own about twenty minutes later. If a sandbox key goes
quiet, retry before minting a new one.

**For a real phone number** — you need a `pyai_live_` key with credit. Sign up at
[console.pyai.com](https://console.pyai.com), add a payment method, and mint a live
key.

Put the key in `.env` as `PYAI_API_KEY`.

## 2. Verify the core loop

```bash
npm run spike
```

This runs `scripts/omni-spike.js`, which creates a real agent and opens a real Omni
session. If this passes, your key and connectivity are good.

```bash
npm start   # builder UI + server on http://localhost:8080
```

At this point the builder is fully functional: you can configure a business, upload
knowledge, and have it indexed. What you cannot do yet is receive a call.

## 3. Set `PUBLIC_HOST` (required for tool registration)

Tool registration needs a publicly reachable URL, because PyAI validates
tool-webhook URLs against an SSRF allow-list — localhost and private IPs are
rejected.

```bash
# .env
PUBLIC_HOST=your-subdomain.ngrok.app
```

While developing, `ngrok http 8080` gives you one. Agent setup and knowledge
ingestion both work without this; only tool registration — which is what makes
bookings, Q&A, and notes actually log — requires it.

## 4. Get a phone number

Two paths.

### PyAI-native (recommended — less code, and the default)

In the Quick Start "put me on the phone" step, or the Advanced tab, list your PyAI
numbers or buy one, then assign it.

> **This costs real money** (metered per connected minute). The UI confirms before
> assigning. Buying a number requires a live key with credit, and is a step you have
> to take yourself.

Calls then connect straight through PyAI's own media bridge — this server is not on
the audio path at all.

### Bring your own Twilio number (fallback)

```bash
# .env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
HUMAN_NUMBER=+15551230000
```

Point that Twilio number's "A call comes in" webhook at
`https://<PUBLIC_HOST>/voice` (POST). This path runs through
`src/routes/telephony.js`'s `/voice` and `/media` routes via `@pyai/twilio`.

## 5. Optional: post-call outcome extraction

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5
```

This enables the post-call transcript-extraction path
([ARCHITECTURE.md](ARCHITECTURE.md#post-call-extraction-path)), which reconstructs
outcomes from an ended call's transcript. Without it, calls show extraction as
"skipped" rather than failing.

## Optional: tunnel binaries

`bin/` is gitignored — the tunnel binaries are not vendored in this repo. Install
whichever you use yourself:

```bash
# ngrok — https://ngrok.com/download
# cloudflared — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

## Once it's live

Saving anything in Customize — or re-running Quick Start — keeps pushing the latest
config to the same live agent. No redeploy needed to change what it says on the next
call.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PYAI_API_KEY` | yes | PyAI sandbox or live key |
| `PYAI_BASE_URL` | no | Defaults to `https://api.pyai.com` |
| `PORT` | no | Defaults to 8080 |
| `PUBLIC_HOST` | for tools | Publicly reachable host for tool webhooks |
| `TOOL_WEBHOOK_SECRET` | for tools | Shared secret PyAI sends back on every tool webhook |
| `ANTHROPIC_API_KEY` | no | Enables post-call outcome extraction |
| `ANTHROPIC_MODEL` | no | Defaults to a current Claude model |
| `TWILIO_ACCOUNT_SID` | Twilio path only | Twilio credentials |
| `TWILIO_AUTH_TOKEN` | Twilio path only | Twilio credentials |
| `HUMAN_NUMBER` | Twilio path only | Where escalations ring |
