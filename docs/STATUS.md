# Status

An honest account of what works, what is unproven, and what was deliberately not
built. This is a hackathon build (August 2026), and the point of this document is
that you should not have to discover any of the below by surprise.

## What genuinely works

- **The builder is real, not a mockup.** Every screen writes to actual PyAI Agent
  and Knowledgebase resources. Saving a field changes what the live agent says on
  the next call.
- **Knowledge ingestion works across all three input types** — file upload, a URL,
  or pasted text — and documents reach an `indexed` state in PyAI.
- **A real phone number answers.** PyAI-native telephony connects callers to the
  configured agent without this server touching the audio path.
- **Browser web-calling works** via an ephemeral, origin-locked PyAI session token
  minted by a single stateless endpoint. Verified against the real production agent
  by sampling actual audio amplitude, not just byte counts.
- **Six industries are preconfigured** as data rather than branching code
  (`src/industries.js`).
- **Post-call outcome extraction works end to end.** Verified against a real phone
  call: it correctly pulled a booking out of a transcript containing garbled
  speech-to-text segments.

## What is unproven or currently broken

Stated plainly, because the dashboard will show you these anyway.

### The grounding gate has no verified success case yet

This is the product's central claim, so it deserves the bluntest treatment.

The mechanism is built and the audit trail is real: `log_qa_answer` records a
`grounded` flag and a `source_excerpt`. But **there is not yet a single verified
instance of the gate demonstrably preventing a wrong answer** — no logged Q&A row
with `grounded=true` traced to a genuine source excerpt, and no captured refusal.

It is also, by design, a **soft gate rather than a hard block**: Omni is a fused
speech-to-speech model, so there is no seam between deciding an answer and speaking
it where a pre-utterance block could be inserted. See
[ARCHITECTURE.md](ARCHITECTURE.md#the-grounding-gate-described-accurately).

Until a real grounded answer or refusal is captured on a live call, treat the
grounding claim as **designed and instrumented, not demonstrated.**

### Call duration metrics are meaningless

`calls.ended_at` is stamped with `unixepoch()` at row-write time rather than at
actual call end, at every write site. Any duration derived from it — including the
average call length shown in Analytics — is an artifact of when rows happened to be
written, not how long anyone was on the phone. **Do not read the duration figures.**

### Most logged calls have no outcomes

The large majority of recorded calls show status `partial` with zero bookings, Q&A,
or escalations. These are predominantly short test dials from development rather
than real conversations, but the log does not currently distinguish "nobody said
anything" from "the pipeline failed to extract what was said", which is a
meaningful gap in the data model.

### Extraction writes placeholder values in at least one case

One `qa_answers` row contains literal `"Placeholder"` for both question and answer,
with an `intent` that does not match its transcript (the transcript is a booking
conversation). So the extraction path can produce a row that is structurally valid
and semantically wrong. Root-causing this is open work.

### Some backfills fail outright

Calls tagged `BACKFILL FAILED` in the Actions log are extraction attempts that
errored — largely transcript unavailability upstream. They are individually
retryable from the UI, and the failure is surfaced rather than hidden, but the
failure rate is not yet acceptable.

### Live custom tool-calling does not fire

An upstream platform issue, not a defect in this repo — see
[PLATFORM-NOTES.md](PLATFORM-NOTES.md). The post-call extraction path exists
precisely because of it, and is designed to become a no-op if this is fixed
upstream.

## There is no automated test suite

To be unambiguous: **this repo has no automated tests.** The files in `scripts/`
(`omni-spike.js`, `live-tool-test.js`, `inline-tools-test.js`,
`client-loop-tool-test.js`, `prebuilt-tool-test.js`) are **manual one-off probe
scripts** written to isolate specific platform behaviours during the build. They
were genuinely useful — several findings in
[PLATFORM-NOTES.md](PLATFORM-NOTES.md) came from them — but they assert nothing and
run nothing in CI.

## Hosting reality

The marketing site is a static page on Vercel. The application backend runs on a
laptop behind an authenticated tunnel with a static domain. It is not deployed to
durable infrastructure: SQLite and the background call poller both need replacing
(a hosted database and a scheduled job respectively) before this could run
serverless.

## Not built, and not faked

Cut deliberately rather than stubbed, per the build's own rule that a feature which
can't be made real should be removed and named:

- **Outbound calling**
- **Mandarin** — the platform's agent-level `language` field supported
  `en | fr | es | de | hi`. The original brief asked for Hindi and Mandarin; Hindi
  is real and native, Mandarin was cut rather than faked with a hand-rolled STT/TTS
  detour.
- **Payment processing**
- **Multi-location support**
- **Hand-rolled voicemail / answering-machine detection** — the platform's AMD
  product is an outbound-dialing concept, so an inbound-only receptionist doesn't
  expose a fake toggle for it.
- **Anything beyond each industry's defined intents** (see `src/industries.js`)
- **Industries beyond the six shipped** — adding one is cheap architecturally, but
  each deserves its own review of intents and hard rules rather than a rubber-stamped
  copy.

## What a real deployment would need next

Roughly in order of how much it matters:

1. Stamp `calls.ended_at` at actual call end, so duration and cost data mean
   something.
2. Capture a verified grounded answer and a verified refusal on live calls — the
   central claim needs evidence, not just instrumentation.
3. Fix the placeholder-value path in extraction, and distinguish "empty call" from
   "extraction failed" in the data model.
4. Drive down the backfill failure rate.
5. A real test suite, starting with the outcome-derivation logic in `tools.js`,
   which is pure and easily testable.
6. Durable hosting: hosted database, scheduled poller, and call forwarding from a
   business's existing number — the last being the single biggest real-world
   adoption blocker.
