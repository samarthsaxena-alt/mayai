# Open Receptionist

A free, open-source AI phone receptionist for independent restaurants, built on
[PyAI](https://pyai.com) Omni. Pick a cuisine template, upload a menu/allergen
PDF, edit the persona, and a real phone number rings into a real agent that
takes reservations, answers menu/allergy questions grounded in your PDF, logs
special requests, and escalates anything else to a human callback.

Nothing here is a mockup. Every screen is wired to PyAI's real Agents,
Knowledgebases, and Tools APIs — editing a field and saving actually changes
what the live agent says on the next call.

## The needle-mover

Everyone can wire an LLM to a phone number now — that's not the differentiator
anymore. The thing almost nobody building on top of a generic voice-agent
platform bothers to get right is refusing to guess about someone's allergy.

Open Receptionist's actual bet: **every menu or allergy answer either traces to
the uploaded PDF, or the agent says it doesn't know — never in between, and
it's logged so you can check.** `log_menu_or_allergy_answer` (`src/tools.js`)
captures a `grounded` flag and the exact `source_excerpt` on every single
answer, visible on the Actions screen. A generic Vapi/Retell-style receptionist
will confidently answer "no nuts" when it's actually unsure — that's not a
hypothetical, it's the default failure mode of an ungrounded LLM asked a
factual question it wants to be helpful about. This is the one feature the
whole build is willing to spend effort on that a demo receptionist wouldn't
bother with.

## Architecture in one paragraph

There's exactly one place "the agent" lives: a persistent **PyAI Agent**
resource (`agent_id`). The 5-screen builder UI is a thin, real CRUD layer over
that agent (`src/agentSync.js` is the only place that pushes to it) plus our
own SQLite log for restaurant-specific data PyAI doesn't model (reservations,
special requests, call outcomes). The menu/allergen PDF is uploaded straight
into a PyAI **Knowledgebase** bound to the agent — PyAI parses/chunks/indexes
it, we don't hand-roll PDF parsing. The four intents + fallback are four real,
server-executed **Tools** (`src/tools.js`) that PyAI's engine calls directly
via webhook — no client-loop tool-calling shim needed.

## Setup

```bash
npm install
cp .env.example .env
```

Get a PyAI key (see "The one thing only you can do" below), put it in `.env`
as `PYAI_API_KEY`, then:

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
     (I hit this repo's own IP rate limit minting one myself while building —
     run it from your own network, or from your browser's dev tools console.)
   - For a **real phone number**, you need a `pyai_live_` key with credit:
     sign up at [console.pyai.com](https://console.pyai.com), add a payment
     method, and mint a live key.
2. **Set `PUBLIC_HOST`** in `.env` to a public host PyAI's engine can reach
   for tool webhooks (e.g. an `ngrok http 8080` hostname while developing, or
   your real deployment host in production).
3. **Get a phone number**, either path:
   - **PyAI-native (recommended, less code, what this app defaults to):** in
     the Advanced tab, "List my PyAI numbers", or `POST /api/telephony/provision`
     to buy one (**real cost**, currently $0.01/min connected — the UI
     confirms before assigning), then "Assign to this agent". Calls then
     connect straight through PyAI's own media bridge; our server isn't even
     on the audio path.
   - **Bring your own Twilio number (fallback):** set `TWILIO_ACCOUNT_SID` /
     `TWILIO_AUTH_TOKEN` / `HUMAN_NUMBER` in `.env`, point that Twilio number's
     "A call comes in" webhook at `https://<PUBLIC_HOST>/voice` (POST). This
     path runs through `src/routes/telephony.js`'s `/voice` + `/media` routes
     via `@pyai/twilio`.

Once a number is assigned, "Finish setup" on the Advanced tab (or any save on
Templates/Behavior/Call Flow) keeps pushing the latest config to the same
live agent — no redeploy needed to change what it says.

## Known platform limitation vs. the brief: Mandarin

The brief asks for Hindi + Mandarin. PyAI's Agent-level `language` field
currently supports `en | fr | es | de | hi` — **no Mandarin**. This is a real
platform constraint, not something worth faking with a hand-rolled STT/TTS
detour. Per the brief's own rule ("if a feature can't be made real in time,
cut it and say so — never fake it"), **Mandarin is cut from this build.**
Hindi is real and supported natively. If PyAI adds Mandarin, this is a
one-line change (`language: "zh"` wherever `"hi"` appears) plus a template
option in the Advanced tab.

## Harness (§4 of the brief)

Every call exits as one of `completed` / `partial` / `escalated`
(`calls.status` in SQLite, visible on the Actions screen with its reason).
This is derived from real tool-call telemetry, not guessed:

- `escalate_to_human` fired → **escalated** (wins over everything else, even
  if another intent in the same call was resolved — see rationale below)
- `log_reservation` / `log_menu_or_allergy_answer` / `log_special_request`
  fired → **completed**
- Call ended with none of the above → **partial**

**Blocking gate** (no menu/allergy claim ships unless it traces to the PDF):
Omni is a fused speech-to-speech model — there's no seam between "decide the
answer" and "speak it" to insert a hard pre-utterance block. The real gate is
three real pieces working together: (1) the persona instructs the agent to
only use retrieved knowledge-base content, (2) PyAI's Knowledgebase actually
retrieves real chunks from your uploaded PDF, (3) every menu/allergy turn logs
a `grounded` flag + the exact `source_excerpt` it claims to have used, as an
audit trail. It's a soft gate with a real audit trail, not a hard block — a
deliberate tradeoff to ship on Omni's native strengths within the time budget
(see conversation history for the fuller reasoning).

**Bounded retry:** PDF upload failures retry at most twice
(`src/routes/knowledge.js`), with the failure reason always surfaced on the
Knowledge screen — never a silent hang.

**Capability registry:** model/voice/language/tools are all config on the
PyAI Agent resource, not hardcoded here — see the Advanced tab.

## Out of scope (per the brief — not built, not faked)

- Outbound calling
- Complaint handling / anything beyond the four intents
- Languages beyond English, Hindi (Mandarin cut — see above)
- Payment processing
- Multi-location support
- Hand-rolled voicemail/AMD detection (PyAI's AMD product exists but is an
  outbound-dialing concept; not applicable to an inbound-only receptionist, so
  the Advanced tab doesn't expose a fake toggle for it)

## Project layout

```
server.js                    Fastify app entry
src/db.js                    SQLite schema (config, calls, reservations, tool audit trail)
src/pyai.js                  Thin REST client over api.pyai.com
src/agentSync.js             The one place that pushes local config -> the live PyAI agent
src/templates.js             Cuisine persona presets (Templates screen)
src/promptBuilder.js         Assembles persona_system_prompt from Behavior + Call Flow fields
src/tools.js                 The 4 real tools + harness status derivation
src/routes/config.js         Templates/Behavior/Call Flow/Advanced CRUD
src/routes/knowledge.js      PDF upload -> PyAI Knowledgebase, bounded retry
src/routes/actions.js        Real call/reservation/Q&A log (read side)
src/routes/webhooks.js       PyAI engine -> our tool webhooks
src/routes/telephony.js      PyAI-native number + Twilio-bridge fallback
public/                      5-screen builder UI (vanilla JS, no build step)
scripts/omni-spike.js        Hour 0-2 spike: real agent + real Omni session smoke test
```
