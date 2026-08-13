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

async function request(method, path, { body, form, query } = {}) {
  const url = new URL(BASE_URL + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);

  const headers = { Authorization: `Bearer ${apiKey()}` };
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
  provisionNumber(body) {
    return request("POST", "/v1/telephony/numbers", { body });
  },
  assignNumber(numberId, agentId) {
    return request("POST", `/v1/telephony/numbers/${numberId}/assign`, { body: { agent_id: agentId } });
  },
  releaseNumber(numberId) {
    return request("DELETE", `/v1/telephony/numbers/${numberId}`);
  },
};

export { PyAIError };
