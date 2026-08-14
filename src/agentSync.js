// The single place that pushes our local config to the real PyAI agent.
// Every screen's "save" ends up here, so "editing and saving actually changes
// what the agent says on the next call" is one code path, not five.
import { getConfig, updateConfig, getBusinessById, updateBusiness, db } from "./db.js";
import { agents } from "./pyai.js";
import { buildPersonaPrompt, buildGreeting } from "./promptBuilder.js";
import { fillPlaceholders } from "./industries.js";
import { ensureToolsRegistered, buildExtractionSchema } from "./tools.js";

function webhookBase() {
  const host = process.env.PUBLIC_HOST;
  if (!host) return null;
  return `https://${host}`;
}

function parseGreetingVariants(json, businessName, aiName) {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // Same "lead with the AI's own name" rule as buildGreeting — every
    // rotated opener should still sound like a person answering, not an IVR.
    return arr.map((t) => {
      const filled = fillPlaceholders(t, businessName, aiName);
      return aiName ? `Hi, this is ${aiName}! ${filled}` : filled;
    });
  } catch {
    return null;
  }
}

function agentPayload(config) {
  return {
    name: config.business_name || "Open Receptionist",
    persona_system_prompt: buildPersonaPrompt(config),
    greeting: buildGreeting(config),
    greeting_variants: parseGreetingVariants(config.greeting_variants, config.business_name, config.ai_name),
    voice_id: config.voice_id || null,
    language: config.language || "en",
    barge_sensitivity: config.barge_sensitivity || "normal",
    ack_mode: config.ack_mode || "auto",
    idle_check_in: config.idle_check_in || "auto",
    // PyAI requires a disclosure whenever recordings are on — a real
    // compliance guardrail (recording calls with no disclosure is illegal in
    // two-party-consent states), not a technicality to route around.
    consent_line: config.consent_line || (config.recordings_enabled ? "This call may be recorded for quality and training purposes." : null),
    recordings_enabled: !!config.recordings_enabled,
    // PyAI's OWN post-call extraction feature (Agent.extraction_schema +
    // extraction_webhook_url) — a first-party alternative to our
    // src/extraction.js transcript-polling workaround, tried because that
    // workaround depends on GET /v1/omni/calls/{id}/transcript, which has
    // proven unreliable on native calls (recording_finalize_timeout). This
    // may run over a different internal pipeline; see src/routes/webhooks.js
    // for the receiver. Only set when we have a public URL for PyAI to POST to.
    ...(webhookBase()
      ? { extraction_schema: buildExtractionSchema(config), extraction_webhook_url: `${webhookBase()}/webhooks/extraction` }
      : {}),
  };
}

/**
 * Create the PyAI agent if it doesn't exist yet, else push the latest config
 * to it. Pass a `businessId` to operate on that business's own persistent
 * row (src/db.js: businesses table) instead of the internal builder UI's
 * singleton `business_config` row — this is what lets multiple businesses
 * from the public marketing-site flow each keep their own agent/KB without
 * overwriting each other. Omit `businessId` to keep the original
 * single-tenant behavior exactly as before (used by the internal
 * Quick Start/Customize builder).
 */
export async function syncAgent(businessId) {
  if (businessId) {
    let biz = getBusinessById(businessId);
    const payload = agentPayload(biz);

    if (!biz.agent_id) {
      const created = await agents.create(payload);
      biz = updateBusiness(businessId, { agent_id: created.agent_id });
    } else {
      await agents.update(biz.agent_id, payload);
    }

    if (biz.kb_id) {
      await agents.bindKnowledgebases(biz.agent_id, [biz.kb_id]);
    }

    const toolIds = await ensureToolsRegistered(biz);
    await agents.bindTools(
      biz.agent_id,
      Object.values(toolIds).map((tool_id) => ({ tool_id, enabled: true }))
    );
    updateBusiness(businessId, { tools_bound: 1 });

    return getBusinessById(businessId);
  }

  let config = getConfig();
  const payload = agentPayload(config);

  if (!config.agent_id) {
    const created = await agents.create(payload);
    config = updateConfig({ agent_id: created.agent_id });
  } else {
    await agents.update(config.agent_id, payload);
  }

  if (config.kb_id) {
    await agents.bindKnowledgebases(config.agent_id, [config.kb_id]);
  }

  // Always re-sync tools (idempotent create-or-update) rather than gate on a
  // one-time flag — a business can switch industries/templates later, and the
  // tool shape (e.g. log_booking's detail field) needs to follow.
  const toolIds = await ensureToolsRegistered(config);
  await agents.bindTools(
    config.agent_id,
    Object.values(toolIds).map((tool_id) => ({ tool_id, enabled: true }))
  );
  updateConfig({ tools_bound: 1 });

  return getConfig();
}
