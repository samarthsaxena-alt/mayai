import { getConfig, updateConfig } from "../db.js";
import { getTemplate, listTemplates } from "../templates.js";
import { syncAgent } from "../agentSync.js";

export default async function configRoutes(app) {
  app.get("/api/templates", async () => ({ templates: listTemplates() }));

  app.get("/api/config", async () => ({ config: getConfig() }));

  // Templates screen: pick a cuisine preset. Seeds Behavior + Call Flow fields
  // (still editable afterward) and pushes to the live agent immediately.
  app.post("/api/config/template", async (req, reply) => {
    const { template_key } = req.body || {};
    const t = getTemplate(template_key);
    updateConfig({
      template_key: t.key,
      greeting: t.greeting,
      greeting_variants: t.greetingVariants ? JSON.stringify(t.greetingVariants) : null,
      behavior_role: t.role,
      behavior_personality: t.personality,
      behavior_style: t.style,
      callflow_reservation_policy: t.reservationPolicy,
      callflow_menu_policy: t.menuPolicy,
      callflow_allergy_policy: t.allergyPolicy,
      callflow_special_policy: t.specialPolicy,
      callflow_fallback_policy: t.fallbackPolicy,
    });
    const config = await syncAgent();
    return reply.send({ config });
  });

  // Behavior screen: free-text role/personality/style. These ARE the system
  // prompt sent to the live agent, not a preview of it.
  app.post("/api/config/behavior", async (req, reply) => {
    const { restaurant_name, greeting, greeting_variants, behavior_role, behavior_personality, behavior_style } = req.body || {};
    updateConfig({
      restaurant_name,
      greeting,
      greeting_variants: Array.isArray(greeting_variants) ? JSON.stringify(greeting_variants.filter(Boolean)) : null,
      behavior_role,
      behavior_personality,
      behavior_style,
    });
    const config = await syncAgent();
    return reply.send({ config });
  });

  // Call Flow screen: the four-intent + fallback routing policy text.
  app.post("/api/config/callflow", async (req, reply) => {
    const {
      callflow_reservation_policy,
      callflow_menu_policy,
      callflow_allergy_policy,
      callflow_special_policy,
      callflow_fallback_policy,
    } = req.body || {};
    updateConfig({
      callflow_reservation_policy,
      callflow_menu_policy,
      callflow_allergy_policy,
      callflow_special_policy,
      callflow_fallback_policy,
    });
    const config = await syncAgent();
    return reply.send({ config });
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

  // "Finish setup": create/update the real PyAI agent, bind KB + tools.
  // Phone number provisioning/assignment is a separate, explicit step (see
  // /api/telephony) since it can carry a real cost.
  app.post("/api/config/finish-setup", async (req, reply) => {
    try {
      const config = await syncAgent();
      return reply.send({ config });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });
}
