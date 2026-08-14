# Platform notes

Real behaviour found by actually running this against the live API, not assumed
from documentation. Recorded here because several of these contradict the docs,
and the next person building on the same platform will lose the same hours.

Everything below was observed during an August 2026 build window. Any of it may
have been fixed since — treat it as a changelog of what was true then, and verify
before relying on it.

## Custom tool-calling did not fire on live Omni sessions

The four custom tools (`log_booking` / `log_qa_answer` / `log_note` /
`escalate_to_human`) were never invoked by the Omni model during a real
conversation, across all three documented registration mechanisms:

1. REST-registered tools + webhook
2. inline `configure` + endpoint
3. inline `configure` client-loop with no endpoint

Tried in both Test and Live environments — six combinations, zero successes, and
no error surfaced anywhere; `configure` acknowledged as if accepted.

**Control test:** PyAI's own prebuilt tools (e.g. `datetime`) *do* fire correctly
through the identical mechanism, verified by transcribing the agent's reply audio
directly (live transcript events over the WebSocket were independently
unreliable at the time). `GET /v1/models` also reported
`pyai-omni-realtime` capabilities as `["realtime","speech-to-speech","agents"]`,
with no `tools` / `function-calling` entry.

Reported upstream with full reproduction detail. The workaround built in response
is the post-call transcript-extraction path described in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Transcript delivery and TTS outage

Separately, transcript delivery and `POST /v1/audio/speech` were unavailable
platform-wide during part of the build. Confirmed by re-running this repo's own
previously-working `scripts/omni-spike.js` unmodified: zero transcript events,
and a 503 from Speech. Worth an A/B against a known-good script before assuming
your own change broke something.

## `AgentConfig.greeting` does not auto-load via `session_label`

Contrary to the docs, the greeting did not auto-load from the persistent agent
profile on a raw session — confirmed `false` until the greeting was sent inline
in the `configure` frame. `agentSync.js` therefore always sends it inline.

Note the tension with the web-calling finding in
[ARCHITECTURE.md](ARCHITECTURE.md): a *partial* inline `configure` overwrites the
knowledgebase/tools binding. Send the full config or none of it.

## `GET /v1/knowledgebases/{id}/documents/{docId}` 404s

The per-document status route 404s as unrecognized on the live API despite
appearing in PyAI's own OpenAPI spec. `GET /v1/knowledgebases/{id}` returns every
document's status inline instead — which is also one API call rather than N.

## Recording disclosure is enforced server-side

The Agent API rejects `recordings_enabled: true` with no `consent_line` (a 400,
not a silent accept). This is a real compliance guardrail rather than a bug;
`agentSync.js` defaults a disclosure line whenever recordings are on instead of
routing around it.

## Interim transcript frames are raw text, not JSON

Only *final* transcripts are JSON-wrapped. Interim/partial frames arrive as raw
text, contrary to what the docs and SDK implicitly assume. Found via
`scripts/omni-spike.js`; parse defensively.

## Sandbox keys auto-suspend under load

Cardless sandbox keys are per-network rate-limited and appear to auto-suspend
temporarily under heavy request volume — one returned 401 mid-build after normal
iterative testing, then recovered on its own roughly twenty minutes later. Don't
mint a new key immediately; retry first.

## Webhook URLs are validated against an SSRF allow-list

Tool registration requires a publicly reachable `PUBLIC_HOST`; localhost and
private IPs are rejected. Agent and knowledge setup work fine without it — only
tool registration needs it.

## No Mandarin at the agent level

The Agent `language` field supported `en | fr | es | de | hi` at time of writing.
The original brief asked for Hindi and Mandarin; Hindi is real and supported
natively, and **Mandarin was cut rather than faked** with a hand-rolled STT/TTS
detour.

## Rapid session reconnect on the same `session_label`

Two ephemeral sessions opened back-to-back on the same `session_label` within
roughly a second can transiently return zero audio on the second. Observed as an
artifact of an abrupt `process.exit()` in a test script rather than a real
hang-up; a browser's graceful close doesn't appear to trigger it. Worth
remembering if web calls seem to silently fail right after a fast reconnect.
