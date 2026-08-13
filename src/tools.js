// The four real tools the live agent calls. Each is registered with PyAI as a
// server-execution webhook tool (the PyAI engine POSTs directly to our
// /webhooks/tools/:name route when the model decides to call it — no
// client-loop wiring on our WebSocket bridge needed).
//
// These map 1:1 onto the brief's four intents + fallback, and their firing
// (or not firing) is exactly how we derive the harness exit-state:
//   escalate_to_human fired            -> escalated  (wins over everything)
//   log_reservation /
//   log_menu_or_allergy_answer /
//   log_special_request fired          -> completed
//   call ended, none of the above fired -> partial
import { db } from "./db.js";
import { tools as pyaiTools } from "./pyai.js";

export const TOOL_DEFS = [
  {
    name: "log_reservation",
    description:
      "Log a confirmed table reservation after reading the details back to the caller and getting their confirmation.",
    side_effect: "action",
    input_schema: {
      type: "object",
      required: ["name", "party_size", "date", "time"],
      properties: {
        name: { type: "string", description: "Name the reservation is under." },
        party_size: { type: "integer", description: "Number of guests." },
        date: { type: "string", description: "Reservation date, as stated by the caller (e.g. 'Friday, August 14')." },
        time: { type: "string", description: "Reservation time, as stated by the caller (e.g. '7:30 PM')." },
        special_request: { type: "string", description: "Optional note, e.g. a birthday or accessibility need." },
      },
    },
  },
  {
    name: "log_menu_or_allergy_answer",
    description:
      "Log a menu or allergy question you just answered (or told the caller you couldn't answer), including whether it was grounded in the restaurant's knowledge base.",
    side_effect: "action",
    input_schema: {
      type: "object",
      required: ["question", "answer", "intent", "grounded"],
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        intent: { type: "string", enum: ["menu", "allergy"] },
        grounded: { type: "boolean", description: "True only if the answer came from the knowledge base." },
        source_excerpt: { type: "string", description: "The exact excerpt from the knowledge base you based the answer on, if any." },
      },
    },
  },
  {
    name: "log_special_request",
    description: "Log a special occasion note (birthday, proposal, anniversary, etc.) mentioned by the caller.",
    side_effect: "action",
    input_schema: {
      type: "object",
      required: ["note"],
      properties: {
        note: { type: "string" },
      },
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Call this whenever the caller's request is outside reservations, menu questions, allergy questions, or special-occasion notes. Tell the caller a team member will call them back, then call this tool with the reason.",
    side_effect: "action",
    input_schema: {
      type: "object",
      required: ["reason"],
      properties: {
        reason: { type: "string" },
      },
    },
  },
];

function webhookBase() {
  const host = process.env.PUBLIC_HOST;
  if (!host) throw new Error("PUBLIC_HOST must be set to register tool webhooks PyAI's engine can reach.");
  return `https://${host}`;
}

/** Idempotently register (or reuse) the 4 tools with PyAI. Returns { name -> tool_id }. */
export async function ensureToolsRegistered() {
  const secret = process.env.TOOL_WEBHOOK_SECRET;
  if (!secret) throw new Error("TOOL_WEBHOOK_SECRET must be set before registering tools.");

  const ids = {};
  const remote = await pyaiTools.list().catch(() => ({ data: [] }));
  const byName = new Map((remote.data || []).map((t) => [t.name, t]));

  for (const def of TOOL_DEFS) {
    const cached = db.prepare(`SELECT tool_id FROM pyai_tools WHERE name = ?`).get(def.name);
    if (cached?.tool_id) {
      ids[def.name] = cached.tool_id;
      continue;
    }
    const existing = byName.get(def.name);
    if (existing) {
      ids[def.name] = existing.id;
    } else {
      const created = await pyaiTools.create({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
        webhook_url: `${webhookBase()}/webhooks/tools/${def.name}`,
        execution: "server",
        side_effect: def.side_effect,
        auth_header: "X-Tool-Secret",
        auth_secret: secret,
        timeout_ms: 5000,
      });
      ids[def.name] = created.id;
    }
    db.prepare(`INSERT OR REPLACE INTO pyai_tools (name, tool_id) VALUES (?, ?)`).run(def.name, ids[def.name]);
  }
  return ids;
}

/** Ensure a `calls` row exists (idempotent — call_id doubles as PyAI's retry key). */
function ensureCall(callId, agentId) {
  db.prepare(`INSERT OR IGNORE INTO calls (id, agent_id) VALUES (?, ?)`).run(callId, agentId || null);
}

function recordInvocation(callId, toolName, args, result) {
  db.prepare(
    `INSERT INTO tool_invocations (call_id, tool_name, args_json, result_json) VALUES (?, ?, ?, ?)`
  ).run(callId, toolName, JSON.stringify(args ?? {}), JSON.stringify(result ?? {}));
}

/** Escalated wins over completed; completed wins over partial (still in_progress / never resolved). */
function markCallStatus(callId, status, reason) {
  const row = db.prepare(`SELECT status FROM calls WHERE id = ?`).get(callId);
  if (!row) return;
  const rank = { in_progress: 0, partial: 1, completed: 2, escalated: 3 };
  if ((rank[status] ?? 0) >= (rank[row.status] ?? 0)) {
    db.prepare(`UPDATE calls SET status = ?, status_reason = ? WHERE id = ?`).run(status, reason, callId);
  }
}

/** The actual handlers, keyed by tool name. Each returns the JSON PyAI forwards to the model. */
export const TOOL_HANDLERS = {
  log_reservation(callId, agentId, args) {
    ensureCall(callId, agentId);
    const { name, party_size, date, time, special_request } = args;
    const info = db
      .prepare(
        `INSERT INTO reservations (call_id, name, party_size, reservation_date, reservation_time, special_request) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(callId, name, party_size, date, time, special_request || null);
    markCallStatus(callId, "completed", `reservation #${info.lastInsertRowid} booked`);
    return { ok: true, reservation_id: info.lastInsertRowid };
  },
  log_menu_or_allergy_answer(callId, agentId, args) {
    ensureCall(callId, agentId);
    const { question, answer, intent, grounded, source_excerpt } = args;
    const info = db
      .prepare(
        `INSERT INTO qa_answers (call_id, question, answer, intent, grounded, source_excerpt) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(callId, question, answer, intent, grounded ? 1 : 0, source_excerpt || null);
    markCallStatus(callId, "completed", `${intent} question answered (grounded=${!!grounded})`);
    return { ok: true, qa_id: info.lastInsertRowid };
  },
  log_special_request(callId, agentId, args) {
    ensureCall(callId, agentId);
    const info = db.prepare(`INSERT INTO special_requests (call_id, note) VALUES (?, ?)`).run(callId, args.note);
    markCallStatus(callId, "completed", "special request logged");
    return { ok: true, special_request_id: info.lastInsertRowid };
  },
  escalate_to_human(callId, agentId, args) {
    ensureCall(callId, agentId);
    markCallStatus(callId, "escalated", args.reason || "escalated to human");
    return { ok: true };
  },
};

/** Called by the webhook route. Records the invocation and runs the handler. */
export function handleToolCall(toolName, { call_id, agent_id, arguments: args }) {
  recordInvocation(call_id, toolName, args, null);
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return { error: `unknown tool ${toolName}` };
  const result = handler(call_id, agent_id, args || {});
  recordInvocation(call_id, `${toolName}:result`, args, result);
  return result;
}

/** Close out a call at end-of-call time; anything still in_progress becomes partial. */
export function finalizeCall(callId, reason) {
  const row = db.prepare(`SELECT status FROM calls WHERE id = ?`).get(callId);
  if (!row) return;
  const status = row.status === "in_progress" ? "partial" : row.status;
  const statusReason = row.status === "in_progress" ? reason || "call ended before any intent resolved" : undefined;
  db.prepare(
    `UPDATE calls SET ended_at = unixepoch(), status = ?, status_reason = COALESCE(?, status_reason) WHERE id = ?`
  ).run(status, statusReason, callId);
}
