# Open Receptionist

A free, open-source AI phone receptionist for small businesses, built on
[PyAI](https://pyai.com) Omni. Pick your business type, feed it what you
offer (a PDF, a link, or just typed-in text — no website required), and a
real phone number rings into a real agent that books appointments, answers
questions grounded in what you gave it, logs anything worth flagging, and
escalates the rest to a human callback.

Started as a restaurant-only build; expanded to six industries
(restaurant, real estate, dental, HVAC, legal, skincare/aesthetics) because
the actual TAM for "an AI receptionist that doesn't hallucinate" isn't
restaurants, it's every technologically-laggard SMB in the country. Nothing
here is a mockup. Every screen is wired to PyAI's real Agents, Knowledgebases,
and Tools APIs — editing a field and saving actually changes what the live
agent says on the next call.

## The needle-mover

Everyone can wire an LLM to a phone number now — that's not the differentiator
anymore. The thing almost nobody building on top of a generic voice-agent
platform bothers to get right is refusing to guess about something a caller
is relying on being true (an allergy, an insurance plan, a listed price).

Open Receptionist's actual bet: **every factual answer either traces to what
the business actually gave it, or the agent says it doesn't know — never in
between, and it's logged so you can check.** `log_qa_answer` (`src/tools.js`)
captures a `grounded` flag and the exact `source_excerpt` on every single
answer, visible on the Actions screen. A generic Vapi/Retell-style receptionist
will confidently answer "no nuts" (or "yes, we take that insurance") when it's
actually unsure — that's not a hypothetical, it's the default failure mode of
an ungrounded LLM asked a factual question it wants to be helpful about. This
is the one feature the whole build is willing to spend effort on that a demo
receptionist wouldn't bother with, and it generalizes across every industry
for free — the mechanism doesn't care whether the fact is a menu ingredient or
a dental insurance plan.

## Zero friction, on purpose

The primary experience is a 3-step **Quick Start** wizard, not the 6-tab
builder: (1) what kind of business + its name, (2) what it offers — upload a
file, paste a link, or just type it in, (3) go live. No jargon, no blank
textareas up front, one obvious next action per screen, skippable where
skipping is honest (no knowledge yet just means the agent says so instead of
guessing). The full 6-tab **Customize** view (Templates/Behavior/Knowledge/Call
Flow/Actions/Advanced) is still there underneath for anyone who wants to tune
persona, call-flow policy, voice, or language — reachable any time, never
required to get a working agent.

## Architecture in one paragraph

There's exactly one place "the agent" lives: a persistent **PyAI Agent**
resource (`agent_id`). The builder UI is a thin, real CRUD layer over that
agent (`src/agentSync.js` is the only place that pushes to it) plus our own
SQLite log for business-specific data PyAI doesn't model (bookings, notes,
call outcomes). What differs by industry is data, not code:
**`src/industries.js`** is the one file that maps each business type to its
own booking shape (a reservation's "party size" vs. a dental appointment's
"reason for visit" vs. an HVAC service call's "issue"), its Q&A categories
(menu/allergy vs. insurance/procedure vs. listing/financing), and its
knowledge-document label — everything downstream (`promptBuilder.js`,
`tools.js`, the UI) reads the active business's resolved shape from there
instead of hardcoding a vertical. Adding a 7th industry is "add an object to
one file," not "touch five files."

The knowledge source (PDF, a URL they already have — Google Business Profile,
Facebook Page, Yelp — or just pasted text) goes straight into a PyAI
**Knowledgebase** bound to the agent; PyAI parses/chunks/indexes all three,
we don't hand-roll any of it. The four tool types (booking / Q&A / note /
escalate) are real, server-executed **Tools** (`src/tools.js`) that PyAI's
engine calls directly via webhook — no client-loop tool-calling shim needed,
and their exact input shape is generated per-business from `industries.js` at
registration time.

## Setup

```bash
npm install
cp .env.example .env
```

Get a PyAI key (see below), put it in `.env` as `PYAI_API_KEY`, then:

```bash
npm run spike   # Hour 0-2: proves a real Omni session + agent-config works
npm start        # the builder UI + server, http://localhost:8080
```

## The one thing only you can do

I can't create accounts, enter payment details, or buy anything — those are
account/purchase actions you have to take yourself. Everything else in this
repo is built and wired for real; this is the one manual step blocking an
actual ringing phone number:

1. **Get a PyAI key.**
   - For development, a cardless **sandbox key** works for everything except
     buying a phone number:
     ```bash
     curl -sX POST https://api.pyai.com/v1/sandbox/keys -H "Content-Type: application/json" -d '{"label":"open-receptionist"}'
     ```
     Sandbox keys are per-network rate-limited AND appear to auto-suspend
     temporarily under heavy request volume (ours returned 401 mid-build after
     normal iterative testing, then recovered on its own ~20 minutes later) —
     don't be alarmed if a sandbox key goes quiet for a bit; it's not
     necessarily dead, retry later before minting a new one.
   - For a **real phone number**, you need a `pyai_live_` key with credit:
     sign up at [console.pyai.com](https://console.pyai.com), add a payment
     method, and mint a live key.
2. **Set `PUBLIC_HOST`** in `.env` to a public host PyAI's engine can reach
   for tool webhooks (e.g. an `ngrok http 8080` hostname while developing, or
   your real deployment host in production). Without it, agent/knowledge
   setup still works — only tool registration (needed for bookings/Q&A/notes
   to actually log) requires a reachable public URL, since PyAI validates
   webhook URLs against an SSRF allow-list (no localhost/private IPs).
3. **Get a phone number**, either path:
   - **PyAI-native (recommended, less code, what this app defaults to):** in
     the Quick Start "Go live" step or the Advanced tab, list your PyAI
     numbers or buy one (**real cost**, currently $0.01/min connected — the UI
     confirms before assigning), then assign it. Calls then connect straight
     through PyAI's own media bridge; our server isn't even on the audio path.
   - **Bring your own Twilio number (fallback):** set `TWILIO_ACCOUNT_SID` /
     `TWILIO_AUTH_TOKEN` / `HUMAN_NUMBER` in `.env`, point that Twilio number's
     "A call comes in" webhook at `https://<PUBLIC_HOST>/voice` (POST). This
     path runs through `src/routes/telephony.js`'s `/voice` + `/media` routes
     via `@pyai/twilio`.

Once a number is assigned, saving anything in Customize (or re-running Quick
Start) keeps pushing the latest config to the same live agent — no redeploy
needed to change what it says.

## Real platform behavior found by actually running this (not assumed from docs)

- **`AgentConfig.greeting` does not auto-load from the persistent agent
  profile via `session_label={agent_id}`** as the docs claim — confirmed
  `false` on a raw session until the greeting was sent inline in the
  `configure` frame. We always send it inline (`agentSync.js`); if PyAI fixes
  the auto-load, nothing here breaks.
- **`GET /v1/knowledgebases/{id}/documents/{docId}`** (per-document status)
  404s as an unrecognized route on the live API despite being documented in
  PyAI's own OpenAPI spec. We poll `GET /v1/knowledgebases/{id}` instead
  (returns every document's status inline) — works, and is one API call
  instead of N.
- **Recording disclosure is enforced server-side**: PyAI's Agent API rejects
  `recordings_enabled: true` with no `consent_line` (400, not a silent
  accept). A real compliance guardrail, not a bug — `agentSync.js` defaults a
  disclosure line whenever recordings are on rather than routing around it.
- **Interim/partial transcript frames ship as raw text, not JSON** — only
  *final* transcripts are JSON-wrapped, contrary to what the docs/SDK
  implicitly assume. Found via `scripts/omni-spike.js`; parse defensively.
- Turn finalization + assistant reply after a fully-transcribed synthetic
  caller utterance did not fire in raw-WebSocket testing even with the line
  held open via continuous silence frames — most likely a synthetic-audio /
  pure-digital-silence artifact of that test harness, not a platform bug, but
  unconfirmed. Watch for this explicitly on the first real phone call
  (real telephony audio has jitter and a real noise floor a synthesized clip
  and pure zero-silence padding don't).

## Known platform limitation vs. the original brief: Mandarin

The original (restaurant-only) brief asked for Hindi + Mandarin. PyAI's
Agent-level `language` field currently supports `en | fr | es | de | hi` —
**no Mandarin**. This is a real platform constraint, not something worth
faking with a hand-rolled STT/TTS detour. Per the brief's own rule ("if a
feature can't be made real in time, cut it and say so — never fake it"),
**Mandarin is cut from this build.** Hindi is real and supported natively.

## Harness

Every call exits as one of `completed` / `partial` / `escalated`
(`calls.status` in SQLite, visible on the Actions screen with its reason).
Derived from real tool-call telemetry, not guessed, and identical across
every industry since the tool *names* never change, only their field shapes:

- `escalate_to_human` fired → **escalated** (wins over everything else, even
  if another intent in the same call was resolved — deliberately
  conservative, surfaces the miss rather than masking it)
- `log_booking` / `log_qa_answer` / `log_note` fired → **completed**
- Call ended with none of the above → **partial**

**Blocking gate** (no factual claim ships unless it traces to what the
business actually gave it): Omni is a fused speech-to-speech model — there's
no seam between "decide the answer" and "speak it" to insert a hard
pre-utterance block. The real gate is three real pieces working together:
(1) the persona instructs the agent to only use retrieved knowledge-base
content, (2) PyAI's Knowledgebase actually retrieves real chunks from what was
uploaded/linked/typed, (3) every Q&A turn logs a `grounded` flag + the exact
`source_excerpt` it claims to have used, as an audit trail. It's a soft gate
with a real audit trail, not a hard block — a deliberate tradeoff to ship on
Omni's native strengths within the time budget.

**Bounded retry:** knowledge-source failures retry at most twice
(`src/routes/knowledge.js`), with the failure reason always surfaced on the
Knowledge screen — never a silent hang. A document's own status is tracked
independently of downstream agent-sync steps (see platform-behavior notes
above — this separation was itself a bug fix once discovered live).

**Capability registry:** model/voice/language/tools are all config on the
PyAI Agent resource, not hardcoded here — see the Advanced tab.

## Out of scope (not built, not faked)

- Outbound calling
- Anything beyond each industry's defined intents (see `src/industries.js`)
- Languages beyond English, Hindi (Mandarin cut — see above)
- Payment processing
- Multi-location support
- Hand-rolled voicemail/AMD detection (PyAI's AMD product exists but is an
  outbound-dialing concept; not applicable to an inbound-only receptionist, so
  the Advanced tab doesn't expose a fake toggle for it)
- Industries beyond the six shipped (real estate, dental, HVAC, legal,
  skincare join restaurant) — adding another is cheap (see Architecture
  above) but each one deserves its own review of intents/hard-rules before
  going live, not a rubber-stamped copy

## Project layout

```
server.js                    Fastify app entry
src/db.js                    SQLite schema (business config, calls, bookings, notes, qa, tool audit trail)
src/pyai.js                  Thin REST client over api.pyai.com
src/agentSync.js             The one place that pushes local config -> the live PyAI agent
src/industries.js            Industry registry — booking/Q&A/note shape per business type
src/promptBuilder.js         Assembles persona_system_prompt from Behavior + Call Flow fields
src/tools.js                 The 4 real tools (dynamic per industry) + harness status derivation
src/routes/config.js         Templates/Behavior/Call Flow/Advanced CRUD + Quick Start step 1/3
src/routes/knowledge.js      Upload/URL/paste-text -> PyAI Knowledgebase, bounded retry
src/routes/actions.js        Real call/booking/Q&A/note log (read side)
src/routes/webhooks.js       PyAI engine -> our tool webhooks
src/routes/telephony.js      PyAI-native number + Twilio-bridge fallback
public/                      Quick Start wizard + 6-tab Customize builder (vanilla JS, no build step)
scripts/omni-spike.js        Hour 0-2 spike: real agent + real Omni session smoke test
```
