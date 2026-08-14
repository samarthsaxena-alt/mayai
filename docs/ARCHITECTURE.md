# Architecture

MayAI is a thin, deliberate layer over [PyAI](https://pyai.com). It is not a
from-scratch voice stack, and the design goal was to keep it that way: PyAI owns
speech, retrieval, and telephony; this repo owns the business's configuration,
its call outcomes, and the honesty guarantees around them.

## One agent, one source of truth

There is exactly one place "the agent" lives: a persistent **PyAI Agent**
resource (`agent_id`). The builder UI is a real CRUD layer over that agent —
`src/agentSync.js` is the only module that pushes to it — plus a local SQLite
log for business data PyAI doesn't model (bookings, notes, Q&A, call outcomes).

Editing a field and saving actually changes what the live agent says on the next
call. Nothing in the UI is a mockup.

```
                       ┌──────────────────────────┐
  Caller ─── phone ───▶ │   PyAI Telephony + Omni  │  (speech-to-speech, fused)
                       └───────────┬──────────────┘
                                   │ retrieves
                       ┌───────────▼──────────────┐
                       │   PyAI Knowledgebase     │  (the business's own docs)
                       └───────────┬──────────────┘
                                   │
        ┌──────────────────────────▼───────────────────────────┐
        │  this repo (Fastify)                                 │
        │                                                      │
        │  agentSync.js ──push config──▶ PyAI Agent resource   │
        │  tools.js       4 tools: booking / Q&A / note / esc.  │
        │  extraction.js  post-call transcript ▶ Claude ▶ rows  │
        │  db.js          SQLite: calls, bookings, qa, notes    │
        └──────────────────────────┬───────────────────────────┘
                                   │
                       ┌───────────▼──────────────┐
                       │  Builder UI (vanilla JS) │  Quick Start + 6-tab Customize
                       └──────────────────────────┘
```

## Industry differences are data, not code

`src/industries.js` is the single file mapping each business type to:

- its **booking shape** (a reservation's "party size" vs. a dental appointment's
  "reason for visit" vs. an HVAC service call's "issue")
- its **Q&A categories** (menu/allergy vs. insurance/procedure vs.
  listing/financing)
- its **knowledge-document label**

Everything downstream — `promptBuilder.js`, `tools.js`, the UI — reads the active
business's resolved shape from there rather than hardcoding a vertical. Adding a
seventh industry is "add an object to one file," not "touch five files."

## Knowledge ingestion

A PDF, a URL the business already has (Google Business Profile, Facebook Page,
Yelp), or pasted text goes straight into a PyAI **Knowledgebase** bound to the
agent. PyAI parses, chunks, and indexes all three; none of that is hand-rolled
here. Knowledge-source failures retry at most twice
(`src/routes/knowledge.js`), and the failure reason always surfaces on the
Knowledge screen — never a silent hang.

## The four tools

`src/tools.js` defines four real, server-executed tools whose exact input shape
is generated per-business from `industries.js` at registration time:

| Tool | Purpose |
| --- | --- |
| `log_booking` | Capture an appointment / reservation / service call |
| `log_qa_answer` | Record an answered question **plus its grounding evidence** |
| `log_note` | Capture a special request worth flagging |
| `escalate_to_human` | Hand off when the agent shouldn't guess |

These four are also the **billing unit**: pricing is outcome-based (30 free
outcomes/month, then per-outcome), and an "outcome" is precisely one of these
four actions succeeding. The revenue model and the audit trail are the same
data, by design.

## Call outcome derivation

Every call exits as one of `completed` / `partial` / `escalated`
(`calls.status`), derived from real tool telemetry rather than guessed. Identical
across every industry, since tool *names* never change — only their field shapes:

- `escalate_to_human` fired → **escalated** (wins over everything else, even if
  another intent in the same call resolved — deliberately conservative, surfaces
  the miss rather than masking it)
- `log_booking` / `log_qa_answer` / `log_note` fired → **completed**
- Call ended with none of the above → **partial**

## The grounding gate, described accurately

The product's central claim is that a factual answer either traces to what the
business actually provided, or the agent says it doesn't know.

It is important to be precise about what enforces this. Omni is a **fused
speech-to-speech model** — there is no seam between "decide the answer" and
"speak it" where a hard pre-utterance block could be inserted. So the gate is
three real pieces working together:

1. the persona instructs the agent to answer only from retrieved
   knowledge-base content (`src/promptBuilder.js`),
2. PyAI's Knowledgebase actually retrieves real chunks from what was
   uploaded/linked/typed,
3. every Q&A turn logs a `grounded` flag and the exact `source_excerpt` it
   claims to have used, as an audit trail (`src/tools.js`).

**This is a soft gate with a real audit trail, not a hard block.** That is a
deliberate tradeoff to ship on Omni's native strengths within a hackathon time
budget, and it is stated plainly here rather than oversold. See
[STATUS.md](STATUS.md) for how well it is currently evidenced in practice.

## Post-call extraction path

During the build, PyAI's custom function-calling did not fire on live Omni
sessions (see [PLATFORM-NOTES.md](PLATFORM-NOTES.md)). Rather than fake the
outcome data, a post-call path was built:

`src/callPoller.js` polls `GET /v1/omni/calls/{id}/transcript` after a call ends
→ `src/extraction.js` hands the transcript to Claude (`src/anthropic.js`) with
the *exact same four tool definitions* the live agent would have called →
whatever it infers is applied through the same handlers
(`tools.js: applyExtractedAction`) a live webhook would have used.

Every row written this way is tagged `source = 'transcript_extraction'` (vs.
`'live_tool_call'`), so nothing pretends to be a live tool call it wasn't —
visible per-row in the Actions call detail view. `hasLiveToolActivity()` skips
the pipeline entirely for any call where live tool calls did fire, so if the
upstream behaviour changes this becomes a no-op with no other code changes.

## Web calling

The "talk to it right here" browser widget (`public/webcall.js`) connects the
browser **directly** to PyAI's Omni WebSocket. This server exposes only one
stateless endpoint, `POST /api/webcall/token` (`src/routes/webcall.js`), which
mints a short-lived, origin-locked PyAI session token; the browser then opens the
socket straight to PyAI. No audio byte passes through this server, which is what
makes serverless hosting of the token endpoint viable.

Two behaviours confirmed by direct testing against the real agent (the docs were
ambiguous):

- `session_label=<agent_id>` alone, with **no inline `configure` frame**,
  auto-loads the agent's persisted greeting, persona, knowledgebase, and tools
  binding. Sending a partial inline `configure` **overwrites** that binding
  rather than adding to it — an earlier version did exactly that, which is why
  its ack echoed `"tools":0,"kb":false`.
- An ephemeral token's `ttl_seconds` gates only the initial handshake window; an
  established session survives well past token expiry.
