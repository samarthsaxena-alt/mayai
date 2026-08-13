// The single place that pushes our local config to the real PyAI agent.
// Every screen's "save" ends up here, so "editing and saving actually changes
// what the agent says on the next call" is one code path, not five.
import { getConfig, updateConfig, db } from "./db.js";
import { agents } from "./pyai.js";
import { buildPersonaPrompt, buildGreeting } from "./promptBuilder.js";
import { fillPlaceholders } from "./templates.js";
import { ensureToolsRegistered } from "./tools.js";

function parseGreetingVariants(json, restaurantName) {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((t) => fillPlaceholders(t, restaurantName));
  } catch {
    return null;
  }
}

function agentPayload(config) {
  return {
    name: config.restaurant_name || "Open Receptionist",
    persona_system_prompt: buildPersonaPrompt(config),
    greeting: buildGreeting(config),
    greeting_variants: parseGreetingVariants(config.greeting_variants, config.restaurant_name),
    voice_id: config.voice_id || null,
    language: config.language || "en",
    barge_sensitivity: config.barge_sensitivity || "normal",
    ack_mode: config.ack_mode || "auto",
    idle_check_in: config.idle_check_in || "auto",
    consent_line: config.consent_line || null,
    recordings_enabled: !!config.recordings_enabled,
  };
}

/** Create the PyAI agent if it doesn't exist yet, else push the latest config to it. */
export async function syncAgent() {
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

  if (!config.tools_bound) {
    const toolIds = await ensureToolsRegistered();
    await agents.bindTools(
      config.agent_id,
      Object.values(toolIds).map((tool_id) => ({ tool_id, enabled: true }))
    );
    updateConfig({ tools_bound: 1 });
  }

  return getConfig();
}
