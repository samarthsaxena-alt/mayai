// Thin REST client over the PyAI platform (https://docs.pyai.com,
// https://api.pyai.com/openapi.json). Deliberately not a generic wrapper —
// only the calls this app actually makes, named after what they do for us.
//
// Auth: `Authorization: Bearer <key>` (a pyai_test_... sandbox key or a
// pyai_live_... key). Keys are opaque; never parse or log them.
const BASE_URL = (process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/\/$/, "");

class PyAIError extends Error {
  constructor(status, code, message, detail) {
    super(`PyAI ${status} ${code || ""}: ${message}`.trim());
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function apiKey() {
  const key = process.env.PYAI_API_KEY;
  if (!key) throw new Error("PYAI_API_KEY is not set. Copy .env.example to .env and fill it in.");
  return key;
}

async function request(method, path, { body, form, query, headers: extraHeaders } = {}) {
  const url = new URL(BASE_URL + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);

  const headers = { Authorization: `Bearer ${apiKey()}`, ...extraHeaders };
  let payload;
  if (form) {
    payload = form; // a FormData instance; fetch sets the multipart boundary itself
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    const err = data?.error || {};
    throw new PyAIError(res.status, err.code, err.message || text || res.statusText, data);
  }
  return data;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// --- Agents ------------------------------------------------------------
export const agents = {
  create(config) {
    return request("POST", "/v1/agents", { body: config });
  },
  get(agentId) {
    return request("GET", `/v1/agents/${agentId}`);
  },
  update(agentId, config) {
    return request("POST", `/v1/agents/${agentId}`, { body: config });
  },
  remove(agentId) {
    return request("DELETE", `/v1/agents/${agentId}`);
  },
  bindKnowledgebases(agentId, kbIds, weight = 1) {
    return request("PUT", `/v1/agents/${agentId}/knowledgebases`, {
      body: kbIds.map((kb_id) => ({ kb_id, weight })),
    });
  },
  bindTools(agentId, bindings) {
    // bindings: [{ tool_id, enabled, config }]
    return request("PUT", `/v1/agents/${agentId}/tools`, { body: bindings });
  },
};

// --- Knowledgebases ------------------------------------------------------
export const knowledgebases = {
  create(name) {
    return request("POST", "/v1/knowledgebases", { body: { name } });
  },
  get(kbId) {
    return request("GET", `/v1/knowledgebases/${kbId}`);
  },
  async uploadFile(kbId, buffer, filename, title) {
    const form = new FormData();
    form.append("file", new Blob([buffer]), filename);
    if (title) form.append("title", title);
    return request("POST", `/v1/knowledgebases/${kbId}/documents`, { form });
  },
  // For businesses with no PDF to upload: point at a page they already have
  // (Google Business Profile, Facebook Page, Yelp listing) or just paste text.
  addUrl(kbId, url, title) {
    return request("POST", `/v1/knowledgebases/${kbId}/documents`, { body: { url, title } });
  },
  addText(kbId, text, title) {
    return request("POST", `/v1/knowledgebases/${kbId}/documents`, { body: { text, title } });
  },
  getDocument(kbId, docId) {
    return request("GET", `/v1/knowledgebases/${kbId}/documents/${docId}`);
  },
  retryDocument(kbId, docId) {
    return request("POST", `/v1/knowledgebases/${kbId}/documents/${docId}/retry`);
  },
  deleteDocument(kbId, docId) {
    return request("DELETE", `/v1/knowledgebases/${kbId}/documents/${docId}`);
  },
};

// --- Tools ---------------------------------------------------------------
export const tools = {
  list() {
    return request("GET", "/v1/tools");
  },
  create(toolDef) {
    return request("POST", "/v1/tools", { body: toolDef });
  },
  get(toolId) {
    return request("GET", `/v1/tools/${toolId}`);
  },
  update(toolId, patch) {
    return request("POST", `/v1/tools/${toolId}`, { body: patch });
  },
};

// --- Omni (realtime voice sessions) ---------------------------------------
export const omni = {
  // Confirmed-reliable after a call ends (unlike the live tool-call/transcript
  // events over the WS) — see [[mayai-pyai-tool-calling-bug]]. Backs the
  // transcript-extraction workaround in src/extraction.js.
  getTranscript(callId) {
    return request("GET", `/v1/omni/calls/${callId}/transcript`);
  },
  // Newest-first list of ended Omni sessions, filterable by the session_label
  // we pass on connect (we use the agent_id as that label). This is the one
  // call-lifecycle signal that works identically whether the call arrived via
  // a PyAI-native number or the Twilio bridge — src/callPoller.js uses it to
  // detect "a call just ended" without needing PyAI to push us anything.
  listCalls({ session_label, limit, cursor } = {}) {
    return request("GET", "/v1/omni/calls", { query: { session_label, limit, cursor } });
  },
  // Mints a short-lived, origin-locked token so a BROWSER can open one Omni
  // session directly against PyAI, without ever holding PYAI_API_KEY. Backs
  // src/routes/webcall.js's token-mint endpoint — confirmed by direct testing
  // that session_label alone (no inline configure frame) auto-loads the
  // agent's real greeting/persona/KB/tools binding here exactly like it does
  // for native telephony, and that an established session survives well past
  // the token's own ttl_seconds (that only gates the initial handshake).
  createSession({ allowed_origins, session_label, ttl_seconds } = {}) {
    return request("POST", "/v1/omni/sessions", { body: { allowed_origins, session_label, ttl_seconds } });
  },
};

// --- Webhook signing (post-call extraction / transcription-job webhooks) --
export const webhookSigning = {
  status() {
    return request("GET", "/v1/webhooks/signing-secret");
  },
  // Returns { secret: "whsec_..." } ONCE — store it immediately, PyAI never shows it again.
  rotate() {
    return request("POST", "/v1/webhooks/signing-secret");
  },
};

// --- Voices ----------------------------------------------------------------
export const voices = {
  list() {
    return request("GET", "/v1/voices");
  },
};

// --- Telephony (native PyAI numbers, requires a live key + telephony:manage) --
export const telephony = {
  listNumbers() {
    return request("GET", "/v1/telephony/numbers");
  },
  // $1/mo for US/CA, $6/mo for India (per PyAI's own docs) — always show this
  // to the user before provisionNumber() actually buys anything.
  searchAvailable({ country, area_code, contains, limit } = {}) {
    return request("GET", "/v1/telephony/available", { query: { country, area_code, contains, limit } });
  },
  // Idempotency-Key is required by PyAI so a retry never double-buys a
  // number; reusing the same key + body just replays the original result.
  provisionNumber(body, idempotencyKey) {
    return request("POST", "/v1/telephony/numbers", { body, headers: { "Idempotency-Key": idempotencyKey } });
  },
  assignNumber(numberId, agentId) {
    return request("POST", `/v1/telephony/numbers/${numberId}/assign`, { body: { agent_id: agentId } });
  },
  releaseNumber(numberId) {
    return request("DELETE", `/v1/telephony/numbers/${numberId}`);
  },
};

export { PyAIError };
