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

**Still reproducing as of this writing** (re-confirmed same-day): a live call
streams real greeting audio fine, but zero transcript events arrive over the
WebSocket for either side of the conversation, and `POST /v1/audio/speech`
still 503s with `"Speech synthesis is unavailable."` This is why
`npm run spike` reports Step 3 as failed rather than crashing — that step's
only purpose is synthesizing a fake caller line via that same endpoint for the
test itself, so its failure doesn't mean your setup is broken, only that this
one upstream endpoint is currently down. Check before assuming it's fixed.

## `AgentConfig.greeting` auto-loading via `session_label` is inconsistent, not a clean yes/no

This has been observed on **both** sides at different times, against the same
agent, with no code change in between — so treat it as genuinely flaky platform
behavior, not a fixed rule to code against:

- Direct testing (Aug 2026, later in the same build window as the entry below)
  found session_label alone *did* reliably auto-load a real, long-established
  agent's persona/greeting/KB/tools — verified by sampling actual non-silent
  PCM16 amplitude, not just byte counts — with zero inline `configure` frame
  sent, on a `pyai_live_` key.
- The same test against a **`pyai_test_` sandbox key** never auto-loaded
  anything — connects and stays silent forever (confirmed by retrying the same
  agent 60s later, ruling out a propagation delay), until an inline `configure`
  frame is sent, at which point it works immediately.
- Later the same day, the previously-reliable **live key also went silent** on
  the identical agent it had worked on minutes earlier — with no code change on
  either side. Sending a fallback `configure` frame fixed it there too.

**Net effect: don't rely on session_label-alone auto-load, on any key type.**
The shipped mitigation (`public/webcall.js`) connects normally, waits a short
grace window for real audio to arrive on its own, and only sends a fallback
`configure` frame (fetched from `POST /api/webcall/token`'s
`fallback_greeting`/`fallback_persona`) if nothing arrived — self-healing
regardless of which of the above is the cause, without ever touching the
already-working fast path (which never reaches the fallback).

Separately, still confirmed true: a *partial* inline `configure` (just
`{greeting, persona}`, no `kb`/`tools` keys) silently overwrites the
knowledgebase/tools binding rather than merging with it — this is why the
fallback above is a **grace-window fallback**, sent only when actually needed,
rather than sent unconditionally on every call.

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
