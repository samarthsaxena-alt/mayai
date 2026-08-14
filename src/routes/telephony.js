// Two telephony paths:
//
// 1) PyAI-native number (primary, recommended): buy + assign a number to our
//    agent_id via PyAI's own Telephony API. Calls connect straight into Omni
//    through PyAI's media bridge — no code of ours is on the audio path at
//    all. See /api/telephony/*.
//
// 2) Twilio bring-your-own-number (fallback): Twilio hits POST /voice, we
//    return TwiML that opens a Media Streams socket back to GET /media, and
//    @pyai/twilio's OmniAgent.bridge does the mu-law<->PCM16 transcode,
//    barge-in, and DTMF for us.
//
// Either way, the SAME agent_id is what's actually live — there's exactly one
// place "the agent" lives (PyAI), matching the brief's capability-registry
// requirement (model/voice/language is config, not hardcoded here).
import { connectStreamTwiML, OmniAgent } from "@pyai/twilio";
import { getConfig, updateConfig, getBusinessByKey, db } from "../db.js";
import { telephony } from "../pyai.js";
import { finalizeCall } from "../tools.js";
import { processCallTranscript } from "../extraction.js";

export default async function telephonyRoutes(app) {
  // --- Path 1: PyAI-native numbers -----------------------------------------
  app.get("/api/telephony/numbers", async (req, reply) => {
    try {
      const list = await telephony.listNumbers();
      return reply.send(list);
    } catch (err) {
      return reply.code(502).send({ error: String(err.message || err), hint: "requires a pyai_live_ key with telephony:manage scope" });
    }
  });

  // Buys a real number. Real cost (see PyAI pricing) — the UI must confirm
  // with whoever clicks this before calling it.
  app.post("/api/telephony/provision", async (req, reply) => {
    try {
      const result = await telephony.provisionNumber(req.body || {});
      return reply.send(result);
    } catch (err) {
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });

  app.post("/api/telephony/assign", async (req, reply) => {
    const config = getConfig();
    if (!config.agent_id) return reply.code(400).send({ error: "finish setup first — no agent_id yet" });
    const { number_id, phone_number } = req.body || {};
    try {
      const result = await telephony.assignNumber(number_id, config.agent_id);
      updateConfig({ phone_number: phone_number || result.phone_number, phone_number_id: number_id, telephony_mode: "pyai_native" });
      return reply.send(result);
    } catch (err) {
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });

  // Public marketing-site flow's "put me on the phone" step. Businesses each
  // keep their own persistent agent_id/kb_id (src/db.js: businesses table),
  // but there is still only ONE real phone number owned on the account — it
  // can only ever be bound to one agent at a time. This just re-binds the
  // already-owned number to whichever verified business asks; it costs
  // nothing extra (no new number purchased, see /api/telephony/provision for
  // the one action that does), but it does mean whoever calls this last is
  // the one the phone number currently answers as. That's a real, disclosed
  // limitation — see [[mayai-website-artifact]] memory — not a bug to hide.
  app.post("/api/telephony/go-live", async (req, reply) => {
    const { business_key } = req.body || {};
    if (!business_key) return reply.code(400).send({ error: "business_key required" });
    const biz = getBusinessByKey(business_key);
    if (!biz || !biz.agent_id) return reply.code(400).send({ error: "business not configured yet — call /api/config/template first" });
    try {
      const numbers = await telephony.listNumbers();
      const owned = (numbers.data || [])[0];
      if (!owned) return reply.code(400).send({ error: "no phone number owned yet" });
      const result = await telephony.assignNumber(owned.id, biz.agent_id);
      return reply.send({ phone_number: result.phone_number || owned.phone_number, business_name: biz.business_name });
    } catch (err) {
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });

  // --- Path 2: Twilio bring-your-own-number fallback -----------------------
  app.post("/voice", async (req, reply) => {
    const config = getConfig();
    const host = process.env.PUBLIC_HOST || req.headers.host;
    reply.type("text/xml").send(connectStreamTwiML(`wss://${host}/media`, {}));
  });

  app.get("/media", { websocket: true }, (twilioWS) => {
    const config = getConfig();
    if (!config.agent_id) {
      app.log.error("incoming call but no agent_id yet — finish setup first");
      twilioWS.close(1011, "agent not configured");
      return;
    }

    const bridge = OmniAgent.bridge(twilioWS, {
      apiKey: process.env.PYAI_API_KEY,
      sessionLabel: config.agent_id, // loads the persisted persona/voice/KB/tools automatically
      baseURL: process.env.PYAI_BASE_URL,
      twilioControl:
        process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
          ? { accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN }
          : undefined,
      transferDestination: process.env.HUMAN_NUMBER,
      onTranscript: (t) => {
        const callId = bridge.callSid || bridge.streamSid;
        if (!callId) return;
        db.prepare(`INSERT OR IGNORE INTO calls (id, agent_id) VALUES (?, ?)`).run(callId, config.agent_id);
        if (t.final) {
          db.prepare(`INSERT INTO transcript_lines (call_id, role, text, is_final) VALUES (?, ?, ?, 1)`).run(
            callId,
            t.role || "unknown",
            t.text
          );
        }
      },
      onTransfer: (info) => app.log.info({ info }, "transfer_to_human"),
      onError: (err) => app.log.error(err, "omni bridge error"),
      onClose: () => {
        const callId = bridge.callSid || bridge.streamSid;
        if (!callId) return;
        finalizeCall(callId, "call ended");
        // Fire-and-forget: PyAI's custom tool-calling doesn't fire live (see
        // [[mayai-pyai-tool-calling-bug]]), so backfill from the ended call's
        // transcript instead. Never blocks the WS from closing; failures are
        // recorded on the call row (extraction_status/extraction_error) for
        // the Actions UI to surface, not thrown here.
        processCallTranscript(callId, config.agent_id, config).catch((err) =>
          app.log.error(err, "transcript extraction pipeline failed")
        );
      },
    });
  });
}
