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

/* Our extraction request is the same shape every time: an identical system
 * prompt plus the same four tool definitions, followed by one call's transcript.
 * Measured with /v1/messages/count_tokens against a real call: 1,712 input
 * tokens total, of which 1,428 (83%) is that fixed prefix. Requests render as
 * tools -> system -> messages, so one cache breakpoint on the last system block
 * caches the tools and the system prompt together, and only the transcript is
 * billed at full rate. Cache reads cost ~0.1x input, which drops input cost per
 * extraction by roughly 75%.
 *
 * Only worth doing because the prefix clears the model's minimum cacheable
 * length (1,024 tokens on Sonnet-tier) — below that the marker is silently
 * ignored. If the system prompt or the tool definitions ever shrink, re-check
 * that with count_tokens before assuming this still caches. */
function withCacheBreakpoint(system) {
  if (!system) return system;
  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return system; // caller passed blocks and owns its own breakpoints
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
        system: withCacheBreakpoint(system),
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

/** Flattens a response's token usage into one loggable line. `cached` is the
 * share of input served from cache — if it sits at 0 across repeated calls, the
 * breakpoint above stopped working (usually because the prefix changed or fell
 * below the minimum cacheable length) and we're paying full input rate. */
export function usageSummary(response) {
  const u = response?.usage || {};
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const uncached = u.input_tokens || 0;
  const totalInput = cacheRead + cacheWrite + uncached;
  return {
    input_total: totalInput,
    input_uncached: uncached,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output: u.output_tokens || 0,
    cached_share: totalInput ? Math.round((cacheRead / totalInput) * 100) / 100 : 0,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export { AnthropicError };
