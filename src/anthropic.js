// Thin REST client over the Anthropic Messages API — same shape as pyai.js:
// only the one call this app actually makes, named after what it does for us.
// Used exclusively by src/extraction.js's transcript-extraction workaround;
// unrelated to voice, so deliberately not routed through PyAI.
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const API_VERSION = "2023-06-01";

class AnthropicError extends Error {
  constructor(status, message, detail) {
    super(`Anthropic ${status}: ${message}`.trim());
    this.status = status;
    this.detail = detail;
  }
}

function apiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
  return key;
}

/** True if a key is configured, without throwing — lets callers skip the workaround cleanly. */
export function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export const messages = {
  async create({ model, max_tokens = 2048, system, messages: msgs, tools, tool_choice }) {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "anthropic-version": API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens,
        system,
        messages: msgs,
        tools,
        tool_choice,
      }),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new AnthropicError(res.status, data?.error?.message || text || res.statusText, data);
    }
    return data;
  },
};

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export { AnthropicError };
