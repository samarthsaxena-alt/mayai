import { getConfig, updateConfig } from "../db.js";
import { getTemplate, listTemplates } from "../industries.js";
import { syncAgent } from "../agentSync.js";

export default async function configRoutes(app) {
  app.get("/api/templates", async () => ({ templates: listTemplates() }));

  app.get("/api/config", async () => ({ config: getConfig() }));

  // Step 1 of Quick Start (and the Templates screen in Customize): pick a
  // business type. Seeds Behavior + Call Flow fields (still editable
  // afterward) and pushes to the live agent immediately. Also accepts the
  // business name here so a stranger can do step 1 in one screen.
  app.post("/api/config/template", async (req, reply) => {
    const { template_key, business_name } = req.body || {};
    const t = getTemplate(template_key);
    updateConfig({
      template_key: t.key,
      industry_key: t.industryKey,
      business_name: business_name || getConfig().business_name,
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
  // prompt sent to the live agent, not a preview of it.
  app.post("/api/config/behavior", async (req, reply) => {
    const { business_name, greeting, greeting_variants, behavior_role, behavior_personality, behavior_style } = req.body || {};
    updateConfig({
      business_name,
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
    try {
      const config = await syncAgent();
      updateConfig({ setup_step: "live" });
      return reply.send({ config: getConfig() });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });
}
