// Server-execution tool webhooks. PyAI's engine POSTs here directly when the
// live agent decides to call a tool — this is real engine-native function
// calling, not something our WebSocket bridge code has to intercept.
import { createHmac, timingSafeEqual } from "node:crypto";
import { handleToolCall, applyNativeExtraction } from "../tools.js";
import { db, getConfig } from "../db.js";

/** HMAC-SHA256 over "<t>.<rawBody>", per PyAI's webhook-signing docs. */
function verifyPyaiSignature(req) {
  const secret = process.env.PYAI_WEBHOOK_SIGNING_SECRET;
  const header = req.headers["x-pyai-signature"];
  if (!secret || !header || !req.rawBody) return false;
  // Expected header shape: "t=<unix_ts>,v1=<hex_hmac>" (Stripe-style) — accept
  // that or a bare "<t>.<hex_hmac>" fallback, since the exact delimiter isn't
  // spelled out beyond "HMAC-SHA256 over \"<t>.<rawBody>\"".
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k?.trim(), v?.trim()];
    })
  );
  const t = parts.t || header.split(".")[0];
  const sig = parts.v1 || header.split(".")[1];
  if (!t || !sig) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${req.rawBody}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false; // length mismatch etc. — never let a malformed sig throw past this into a false positive
  }
}

export default async function webhooksRoutes(app) {
  app.post("/webhooks/tools/:name", async (req, reply) => {
    const secret = req.headers["x-tool-secret"];
    if (!secret || secret !== process.env.TOOL_WEBHOOK_SECRET) {
      req.log.warn("rejected tool webhook call: bad or missing X-Tool-Secret");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const { name } = req.params;
    const body = req.body || {};
    req.log.info({ tool: name, call_id: body.call_id, args: body.arguments }, "tool call");

    try {
      const result = handleToolCall(name, body, getConfig());
      return reply.send(result);
    } catch (err) {
      req.log.error(err, "tool handler failed");
      return reply.code(500).send({ error: String(err.message || err) });
    }
  });

  // PyAI's OWN native post-call extraction (Agent.extraction_schema +
  // extraction_webhook_url, event `omni.call.extracted`) — a first-party
  // alternative to src/extraction.js's transcript-polling workaround, tried
  // because that workaround's data source (GET .../transcript) has proven
  // unreliable on native calls. See src/tools.js: buildExtractionSchema /
  // applyNativeExtraction.
  app.post("/webhooks/extraction", async (req, reply) => {
    if (!verifyPyaiSignature(req)) {
      req.log.warn({ headers: req.headers }, "rejected extraction webhook: bad or missing X-PyAI-Signature");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const body = req.body || {};
    req.log.info({ body }, "native extraction webhook received");

    // Shape not fully pinned down by PyAI's docs beyond "event
    // omni.call.extracted" — accept a couple of reasonable envelopes rather
    // than assuming one exact structure on the first real delivery.
    const callId = body.call_id || body.data?.call_id || body.id;
    const agentId = body.agent_id || body.data?.agent_id || getConfig().agent_id;
    const extracted = body.extracted || body.data?.extracted || body.data || body;

    if (!callId) {
      req.log.warn({ body }, "extraction webhook missing a call_id — can't attribute this payload to a call");
      return reply.code(400).send({ error: "missing call_id" });
    }

    db.prepare(
      `INSERT INTO calls (id, agent_id, started_at, ended_at, status) VALUES (?, ?, unixepoch(), unixepoch(), 'partial')
       ON CONFLICT(id) DO NOTHING`
    ).run(callId, agentId);

    try {
      const result = applyNativeExtraction(callId, agentId, extracted, getConfig());
      db.prepare(`UPDATE calls SET extraction_status = 'success' WHERE id = ?`).run(callId);
      return reply.send({ ok: true, applied: result });
    } catch (err) {
      req.log.error(err, "failed to apply native extraction payload");
      db.prepare(`UPDATE calls SET extraction_status = 'failed', extraction_error = ? WHERE id = ?`).run(String(err.message || err), callId);
      return reply.code(500).send({ error: String(err.message || err) });
    }
  });
}
