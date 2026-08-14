import { getConfig, updateConfig, getBusinessByKey, getOrCreateBusiness, updateBusiness } from "../db.js";
import { getTemplate, listTemplates } from "../industries.js";
import { syncAgent } from "../agentSync.js";
import { telephony } from "../pyai.js";

// Businesses (src/db.js: businesses table) don't store a phone_number or
// setup_step column — the phone number is a fact about the ONE shared PyAI
// number (whichever agent it's currently bound to), not something that
// belongs to any one business row, and setup_step is derivable from what
// actually exists rather than needing its own persisted state. This cross-
// references the real PyAI telephony API so the builder UI's "is this
// business on the clock" and wizard-step display are honest rather than
// reading a field that was never being written to for business rows (the
// original bug: the internal builder ignored business_key entirely and fell
// back to the singleton's stale setup_step, showing the wrong wizard step).
async function enrichBusinessConfig(biz) {
  let phone_number = null;
  let phone_number_id = null;
  if (biz.agent_id) {
    try {
      const numbers = await telephony.listNumbers();
      const match = (numbers.data || []).find((n) => n.agent_id === biz.agent_id);
      if (match) {
        phone_number = match.phone_number;
        phone_number_id = match.id;
      }
    } catch {
      // No live/telephony-scoped key, or the call failed — leave phone fields
      // null rather than let this break the whole config response.
    }
  }
  const setup_step = biz.kb_id && biz.agent_id ? "live" : biz.agent_id ? "knowledge" : "business_type";
  return { ...biz, phone_number, phone_number_id, setup_step };
}

export default async function configRoutes(app) {
  app.get("/api/templates", async () => ({ templates: listTemplates() }));

  // With ?business_key=<key>, returns that business's own persistent config
  // (src/db.js: businesses table) instead of the internal builder's
  // singleton — used by the public marketing-site flow. Unknown key = 404,
  // not a silent fallback to the singleton (that would leak someone else's
  // config to a caller who typed a key that never got created).
  app.get("/api/config", async (req, reply) => {
    const { business_key } = req.query || {};
    if (business_key) {
      const biz = getBusinessByKey(business_key);
      if (!biz) return reply.code(404).send({ error: "unknown business_key" });
      return reply.send({ config: await enrichBusinessConfig(biz) });
    }
    return reply.send({ config: getConfig() });
  });

  // Step 1 of Quick Start (and the Templates screen in Customize): pick a
  // business type. Seeds Behavior + Call Flow fields (still editable
  // afterward) and pushes to the live agent immediately. Also accepts the
  // business name here so a stranger can do step 1 in one screen.
  //
  // Pass business_key to route this at a specific business's own persistent
  // row (src/db.js: businesses table) instead of the internal builder's
  // singleton row — this is what the public marketing-site flow uses so one
  // business's setup never overwrites another's. Omit it to keep the
  // original single-tenant behavior (internal builder UI).
  app.post("/api/config/template", async (req, reply) => {
    const { template_key, business_name, ai_name, business_key } = req.body || {};
    const t = getTemplate(template_key);

    if (business_key) {
      const biz = getOrCreateBusiness(business_key, business_name);
      updateBusiness(biz.id, {
        template_key: t.key,
        industry_key: t.industryKey,
        business_name: business_name || biz.business_name,
        ai_name: ai_name !== undefined ? ai_name || null : biz.ai_name,
        greeting: t.greeting,
        greeting_variants: t.greetingVariants ? JSON.stringify(t.greetingVariants) : null,
        behavior_role: t.role,
        behavior_personality: t.personality,
        behavior_style: t.style,
        callflow_booking_policy: t.bookingPolicy,
        callflow_qa_intents_json: JSON.stringify(t.qaIntents),
        callflow_note_policy: t.notePolicy,
        callflow_fallback_policy: t.fallbackPolicy,
      });
      const updated = await syncAgent(biz.id);
      return reply.send({ config: updated });
    }

    updateConfig({
      template_key: t.key,
      industry_key: t.industryKey,
      business_name: business_name || getConfig().business_name,
      ai_name: ai_name !== undefined ? ai_name || null : getConfig().ai_name,
      greeting: t.greeting,
      greeting_variants: t.greetingVariants ? JSON.stringify(t.greetingVariants) : null,
      behavior_role: t.role,
      behavior_personality: t.personality,
      behavior_style: t.style,
      callflow_booking_policy: t.bookingPolicy,
      callflow_qa_intents_json: JSON.stringify(t.qaIntents),
      callflow_note_policy: t.notePolicy,
      callflow_fallback_policy: t.fallbackPolicy,
      setup_step: "knowledge",
    });
    const config = await syncAgent();
    return reply.send({ config });
  });

  // Behavior screen: free-text role/personality/style. These ARE the system
  // prompt sent to the live agent, not a preview of it. Same business_key
  // convention as /api/config/template above.
  app.post("/api/config/behavior", async (req, reply) => {
    const { business_name, ai_name, greeting, greeting_variants, behavior_role, behavior_personality, behavior_style, business_key } =
      req.body || {};

    if (business_key) {
      const biz = getBusinessByKey(business_key);
      if (!biz) return reply.code(400).send({ error: "unknown business_key — call /api/config/template first" });
      updateBusiness(biz.id, {
        business_name: business_name || biz.business_name,
        ai_name: ai_name !== undefined ? ai_name || null : biz.ai_name,
        greeting,
        greeting_variants: Array.isArray(greeting_variants) ? JSON.stringify(greeting_variants.filter(Boolean)) : biz.greeting_variants,
        behavior_role,
        behavior_personality,
        behavior_style,
      });
      const updated = await syncAgent(biz.id);
      return reply.send({ config: updated });
    }

    updateConfig({
      business_name,
      ai_name: ai_name || null,
      greeting,
      greeting_variants: Array.isArray(greeting_variants) ? JSON.stringify(greeting_variants.filter(Boolean)) : null,
      behavior_role,
      behavior_personality,
      behavior_style,
    });
    const config = await syncAgent();
    return reply.send({ config });
  });

  // Call Flow screen: booking + dynamic Q&A-intent + note + fallback policy text.
  app.post("/api/config/callflow", async (req, reply) => {
    const { callflow_booking_policy, qa_policies, callflow_note_policy, callflow_fallback_policy } = req.body || {};
    const config = getConfig();
    const tpl = getTemplate(config.template_key);
    // qa_policies: { [intentKey]: policyText } from the UI, merged back onto
    // the template's intent metadata (key/label/hardRule) so the shape survives.
    const qaIntents = tpl.qaIntents.map((qa) => ({ ...qa, policy: qa_policies?.[qa.key] ?? qa.policy }));
    updateConfig({
      callflow_booking_policy,
      callflow_qa_intents_json: JSON.stringify(qaIntents),
      callflow_note_policy,
      callflow_fallback_policy,
    });
    const updated = await syncAgent();
    return reply.send({ config: updated });
  });

  // Advanced screen: only fields the platform genuinely exposes as a
  // real, working switch (see AgentConfig on PyAI). Nothing hand-rolled.
  app.post("/api/config/advanced", async (req, reply) => {
    const { voice_id, language, barge_sensitivity, ack_mode, idle_check_in, consent_line, recordings_enabled } = req.body || {};
    updateConfig({
      voice_id,
      language,
      barge_sensitivity,
      ack_mode,
      idle_check_in,
      consent_line,
      recordings_enabled: recordings_enabled ? 1 : 0,
    });
    const config = await syncAgent();
    return reply.send({ config });
  });

  app.get("/api/voices", async (req, reply) => {
    const { voices } = await import("../pyai.js");
    try {
      const list = await voices.list();
      // Surface receptionist-fit voices first — real metadata PyAI already
      // tags each voice with, not a guess on our part.
      const data = (list.data || [])
        .filter((v) => v.language === "en")
        .sort((a, b) => {
          const aFit = a.use_cases?.includes("receptionist / front desk") ? 0 : 1;
          const bFit = b.use_cases?.includes("receptionist / front desk") ? 0 : 1;
          return aFit - bFit || a.name.localeCompare(b.name);
        });
      return reply.send({ ...list, data });
    } catch (err) {
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });

  // "Finish setup" / step 3 of Quick Start: create/update the real PyAI
  // agent, bind KB + tools. Phone number provisioning/assignment is a
  // separate, explicit step (see /api/telephony) since it can carry a real cost.
  app.post("/api/config/finish-setup", async (req, reply) => {
    const { business_key } = req.body || {};
    try {
      if (business_key) {
        const biz = getBusinessByKey(business_key);
        if (!biz) return reply.code(400).send({ error: "unknown business_key" });
        const updated = await syncAgent(biz.id);
        return reply.send({ config: await enrichBusinessConfig(updated) });
      }
      const config = await syncAgent();
      updateConfig({ setup_step: "live" });
      return reply.send({ config: getConfig() });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });
}
