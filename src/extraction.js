// Workaround for the PyAI platform bug where custom tool-calling never fires
// on a live Omni session (see [[mayai-pyai-tool-calling-bug]] / the README).
// PyAI's own prebuilt tools fire correctly and `GET /v1/omni/calls/{id}/transcript`
// is confirmed reliable after a call ends — so instead of relying on live
// tool calls, we poll that endpoint once a call ends, hand the transcript to
// Claude with the exact same 4 tool definitions the live agent would have
// called, and write whatever it infers happened into the same
// bookings/qa_answers/notes/calls tables the live webhook path writes to.
// Every row this produces is tagged source = 'transcript_extraction'
// (src/tools.js: applyExtractedAction) so the Actions UI never conflates a
// backfilled action with a real live tool call.
//
// This is intentionally a stopgap: the moment PyAI's bug is fixed, live tool
// calls resume writing source = 'live_tool_call' rows directly, and
// hasLiveToolActivity() makes this whole pipeline a no-op per call — nothing
// else in the app needs to change.
import { db } from "./db.js";
import { omni } from "./pyai.js";
import { messages as anthropicMessages, isConfigured as anthropicConfigured } from "./anthropic.js";
import { buildToolDefs, applyExtractedAction, hasLiveToolActivity } from "./tools.js";

const POLL_ATTEMPTS = 5;
const POLL_DELAY_MS = 3000; // transcript finalization can lag a couple seconds behind call end

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setExtractionStatus(callId, status, error) {
  db.prepare(`UPDATE calls SET extraction_status = ?, extraction_error = ? WHERE id = ?`).run(status, error || null, callId);
}

/** Normalizes whatever shape PyAI's transcript endpoint returns into a flat
 * [{role, text}] list — undocumented in detail beyond "role-labeled turns",
 * so this accepts the couple of reasonable shapes an API like this tends to use. */
function normalizeTurns(payload) {
  const raw = payload?.transcript?.turns ?? payload?.transcript ?? payload?.turns ?? payload?.messages ?? payload;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => ({
      role: t.role || t.speaker || "unknown",
      text: t.text || t.content || t.message || "",
    }))
    .filter((t) => t.text);
}

/** Retries a few times — the transcript may not be finalized the instant the call ends. */
async function pollTranscript(callId) {
  let lastErr;
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    try {
      const payload = await omni.getTranscript(callId);
      const turns = normalizeTurns(payload);
      if (turns.length > 0) return turns;
      lastErr = new Error("transcript endpoint returned no turns yet");
    } catch (err) {
      lastErr = err;
    }
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_DELAY_MS * attempt);
  }
  throw lastErr || new Error("transcript never became available");
}

/** Persists polled turns into transcript_lines — only if the live path (WS
 * onTranscript, Twilio bridge only) hasn't already populated them, so this
 * also backfills transcripts for calls where only PyAI-native telephony ran. */
function saveTurnsIfMissing(callId, turns) {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM transcript_lines WHERE call_id = ?`).get(callId);
  if (existing.n > 0) return;
  const insert = db.prepare(`INSERT INTO transcript_lines (call_id, role, text, is_final) VALUES (?, ?, ?, 1)`);
  const insertMany = db.transaction((rows) => rows.forEach((t) => insert.run(callId, t.role, t.text)));
  insertMany(turns);
}

const SYSTEM_PROMPT = `You are auditing a just-ended phone call transcript for an AI phone receptionist. \
Your job is to reconstruct, after the fact, which of the tools below the receptionist agent should have \
called live during this call, and call each one exactly once per distinct thing that happened.

Rules:
- Only call a tool for something that actually happened in the transcript — never invent details.
- If the same kind of thing happened more than once (e.g. two separate questions answered), call the \
relevant tool once per occurrence, in the order they happened.
- For log_qa_answer, set grounded=true only if the assistant's answer in the transcript reads as coming \
from real knowledge-base facts (specific menu items, prices, policies, etc.) rather than a vague or \
hedged reply; set source_excerpt to the specific fact if you can identify it from the assistant's phrasing.
- If nothing in the transcript matches any tool (e.g. a call that was just a wrong number, or ended with \
no resolution), don't call anything.
- Never call a tool for something that didn't happen just to have output.`;

/** Runs the extraction call against Claude, returns [{name, input}] tool-use blocks. */
async function runExtraction(turns, config) {
  const tools = buildToolDefs(config).map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const transcriptText = turns.map((t) => `${t.role}: ${t.text}`).join("\n");
  const response = await anthropicMessages.create({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Transcript:\n\n${transcriptText}` }],
    tools,
    tool_choice: { type: "auto" },
    max_tokens: 4096,
  });
  return (response?.content || []).filter((block) => block.type === "tool_use").map((block) => ({ name: block.name, input: block.input }));
}

/**
 * Full pipeline for one ended call: poll transcript -> backfill
 * transcript_lines -> extract actions with Claude -> apply each via the same
 * handlers the live webhook path uses. Safe to call more than once (e.g. a
 * manual "reprocess" retry) — re-running just re-derives and re-applies,
 * which can double-log actions on a genuine retry; that's an accepted
 * tradeoff of a stopgap pipeline, not a live system of record.
 */
export async function processCallTranscript(callId, agentId, config) {
  if (hasLiveToolActivity(callId)) {
    setExtractionStatus(callId, "not_applicable");
    return { status: "not_applicable" };
  }

  setExtractionStatus(callId, "pending");

  // Poll + save the transcript regardless of whether Claude is configured —
  // it's free, useful on its own (visible in the Actions call-detail view),
  // and shouldn't be gated behind the LLM key that only the *inference* step
  // (turning the transcript into tool calls) actually needs.
  let turns;
  try {
    turns = await pollTranscript(callId);
    db.prepare(`UPDATE calls SET transcript_polled_at = unixepoch() WHERE id = ?`).run(callId);
    saveTurnsIfMissing(callId, turns);
  } catch (err) {
    db.prepare(`UPDATE calls SET extraction_attempts = extraction_attempts + 1 WHERE id = ?`).run(callId);
    setExtractionStatus(callId, "failed", String(err?.message || err));
    return { status: "failed", error: String(err?.message || err) };
  }

  if (!anthropicConfigured()) {
    setExtractionStatus(callId, "skipped", "ANTHROPIC_API_KEY not set");
    return { status: "skipped" };
  }

  try {
    const actions = await runExtraction(turns, config);
    for (const action of actions) {
      applyExtractedAction(callId, agentId, action.name, action.input, config);
    }
    setExtractionStatus(callId, "success");
    return { status: "success", actions_applied: actions.length };
  } catch (err) {
    setExtractionStatus(callId, "failed", String(err?.message || err));
    return { status: "failed", error: String(err?.message || err) };
  }
}
