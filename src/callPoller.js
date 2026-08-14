// Detects "a call just ended" without depending on Twilio at all — needed
// because a PyAI-native number has "no code of ours on the audio path"
// (src/routes/telephony.js), so there's no WebSocket onClose to hook the
// transcript-extraction workaround (src/extraction.js) into for that path.
//
// GET /v1/omni/calls?session_label=<agent_id> lists every ended Omni session
// for our agent, newest first, regardless of whether it arrived via a
// PyAI-native number or the Twilio bridge — so this one poller covers both
// transports uniformly. It only ever sees calls PyAI already considers
// finished (status: completed | failed), which is exactly the signal we need.
import { db, getConfig } from "./db.js";
import { omni } from "./pyai.js";
import { processCallTranscript } from "./extraction.js";
import { hasLiveToolActivity } from "./tools.js";

const POLL_INTERVAL_MS = 20_000;
// Some calls never get a transcript at all (e.g. PyAI failed to establish the
// Omni engine session for that call — seen in practice as
// recording_result.terminal_reason: "engine_session_identity_missing"). Without
// a cap the poller would retry those every interval forever. A manual
// reprocess (Actions screen / API) still ignores this cap — it calls
// processCallTranscript directly, not through needsProcessing().
const MAX_AUTO_ATTEMPTS = 3;

/** True if this call_id needs (re)processing: never seen, or a prior attempt didn't finish (and hasn't exhausted its auto-retry budget). */
function needsProcessing(callId) {
  const row = db.prepare(`SELECT extraction_status, extraction_attempts FROM calls WHERE id = ?`).get(callId);
  if (!row) return true;
  if (row.extraction_status === "pending") return true;
  if (row.extraction_status === "failed") return row.extraction_attempts < MAX_AUTO_ATTEMPTS;
  return false;
}

async function pollOnce(log) {
  const config = getConfig();
  if (!config.agent_id) return; // nothing to poll for before setup finishes

  let list;
  try {
    list = await omni.listCalls({ session_label: config.agent_id, limit: 20 });
  } catch (err) {
    log?.error?.(err, "call poller: failed to list omni calls");
    return;
  }

  for (const item of list?.data || []) {
    if (item.status !== "completed" && item.status !== "failed") continue;
    if (hasLiveToolActivity(item.call_id)) continue; // live tool-calling worked for this one — nothing to backfill
    if (!needsProcessing(item.call_id)) continue;

    db.prepare(
      `INSERT INTO calls (id, agent_id, started_at, ended_at, status)
       VALUES (?, ?, COALESCE(?, unixepoch()), unixepoch(), 'partial')
       ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at`
    ).run(item.call_id, config.agent_id, item.started_at ? Math.floor(item.started_at / 1000) : null);

    log?.info?.({ call_id: item.call_id }, "call poller: backfilling ended call via transcript extraction");
    try {
      await processCallTranscript(item.call_id, config.agent_id, config);
    } catch (err) {
      log?.error?.(err, "call poller: transcript extraction pipeline failed");
    }
  }
}

/**
 * Starts the poller; returns a stop() function. Call once at server boot.
 *
 * Uses a self-rescheduling setTimeout, NOT setInterval — pollOnce() can run
 * long (pollTranscript's own retry backoff alone can take ~45s for a call
 * that never gets a transcript), and setInterval would fire the next tick on
 * wall-clock time regardless, letting two pollOnce() runs overlap. That
 * overlap let two concurrent runs both pass needsProcessing() for the same
 * call before either had incremented extraction_attempts, double-counting
 * attempts and defeating MAX_AUTO_ATTEMPTS. Chaining via setTimeout instead
 * guarantees only one pollOnce() is ever in flight at a time.
 */
export function startCallPoller(log) {
  let stopped = false;
  let timer = null;

  async function tick() {
    try {
      await pollOnce(log);
    } catch (err) {
      log?.error?.(err, "call poller: unexpected error");
    }
    if (!stopped) {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
      timer.unref?.();
    }
  }

  tick(); // run immediately rather than waiting a full interval
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
