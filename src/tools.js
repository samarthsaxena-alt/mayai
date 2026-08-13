// The four real tools the live agent calls. Generic across industries — the
// shapes are fixed (log_booking / log_qa_answer / log_note / escalate_to_human),
// but each is REGISTERED with PyAI using the active business's resolved
// template (src/industries.js) for field names/labels and the QA intent enum,
// so a dental office's log_booking asks for "reason for visit" while a
// restaurant's asks for "party size" — same tool, different shape.
//
// Each is a server-execution webhook tool: the PyAI engine POSTs directly to
// our /webhooks/tools/:name route when the model decides to call it — no
// client-loop wiring on our WebSocket bridge needed.
//
// Firing (or not firing) one of these is exactly how we derive the harness
// exit-state:
//   escalate_to_human fired                    -> escalated  (wins over everything)
//   log_booking / log_qa_answer / log_note fired -> completed
//   call ended, none of the above fired          -> partial
import { db } from "./db.js";
import { tools as pyaiTools } from "./pyai.js";
import { getTemplate } from "./industries.js";

/** Build the 4 tool definitions for the business's active template. */
export function buildToolDefs(config) {
  const tpl = getTemplate(config.template_key);
  return [
    {
      name: "log_booking",
      description: `Log a confirmed ${tpl.bookingLabel.toLowerCase()} after reading the details back to the caller and getting their confirmation.`,
      side_effect: "action",
      input_schema: {
        type: "object",
        required: ["name", "date", "time", tpl.bookingDetailField.key],
        properties: {
          name: { type: "string", description: `Name the ${tpl.bookingLabel.toLowerCase()} is under.` },
          date: { type: "string", description: "Date, as stated by the caller (e.g. 'Friday, August 14')." },
          time: { type: "string", description: "Time, as stated by the caller (e.g. '7:30 PM')." },
          [tpl.bookingDetailField.key]: { type: tpl.bookingDetailField.type === "integer" ? "integer" : "string", description: tpl.bookingDetailField.label },
        },
        additionalProperties: false,
      },
    },
    {
      name: "log_qa_answer",
      description: `Log a question you just answered (or told the caller you couldn't answer), including whether it was grounded in the business's knowledge base.`,
      side_effect: "action",
      input_schema: {
        type: "object",
        required: ["question", "answer", "intent", "grounded"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
          intent: { type: "string", enum: tpl.qaIntents.map((q) => q.key), description: tpl.qaIntents.map((q) => `${q.key} = ${q.label}`).join("; ") },
          grounded: { type: "boolean", description: "True only if the answer came from the knowledge base." },
          source_excerpt: { type: "string", description: "The exact excerpt from the knowledge base you based the answer on, if any." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "log_note",
      description: `Log a ${tpl.noteLabel.toLowerCase()} mentioned by the caller.`,
      side_effect: "action",
      input_schema: {
        type: "object",
        required: ["note"],
        properties: { note: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "escalate_to_human",
      description:
        "Call this whenever the caller's request is outside bookings, the question types you're grounded to answer, or notes. Tell the caller a team member will call them back, then call this tool with the reason.",
      side_effect: "action",
      input_schema: {
        type: "object",
        required: ["reason"],
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
    },
  ];
}

function webhookBase() {
  const host = process.env.PUBLIC_HOST;
  if (!host) throw new Error("PUBLIC_HOST must be set to register tool webhooks PyAI's engine can reach.");
  return `https://${host}`;
}

/**
 * Idempotently register (or reuse) the 4 tools with PyAI for the business's
 * CURRENT template. Re-registers (new tool_id, old one left orphaned but
 * disabled implicitly by no longer being bound) if the template's shape
 * changed since last registration — cheap enough for a single-tenant app.
 */
export async function ensureToolsRegistered(config) {
  const secret = process.env.TOOL_WEBHOOK_SECRET;
  if (!secret) throw new Error("TOOL_WEBHOOK_SECRET must be set before registering tools.");

  const defs = buildToolDefs(config);
  const ids = {};
  const remote = await pyaiTools.list().catch(() => ({ data: [] }));
  const byName = new Map((remote.data || []).map((t) => [t.name, t]));

  for (const def of defs) {
    const cached = db.prepare(`SELECT tool_id FROM pyai_tools WHERE name = ?`).get(def.name);
    const existing = cached?.tool_id ? { id: cached.tool_id } : byName.get(def.name);

    if (existing) {
      ids[def.name] = existing.id;
      // A business can switch templates (restaurant -> dental, say) after
      // tools were already registered. Push the current shape every time
      // rather than trusting a stale cached schema — cheap, and correct.
      await pyaiTools.update?.(existing.id, {
        description: def.description,
        input_schema: def.input_schema,
      }).catch(() => {}); // best-effort; a create-only PyAI account without update perms shouldn't block setup
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
  log_booking(callId, agentId, args, config) {
    ensureCall(callId, agentId);
    const tpl = getTemplate(config.template_key);
    const { name, date, time } = args;
    const detailValue = args[tpl.bookingDetailField.key];
    const info = db
      .prepare(`INSERT INTO bookings (call_id, name, booking_date, booking_time, detail_label, detail_value) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(callId, name, date, time, tpl.bookingDetailField.label, detailValue != null ? String(detailValue) : null);
    markCallStatus(callId, "completed", `${tpl.bookingLabel.toLowerCase()} #${info.lastInsertRowid} booked`);
    return { ok: true, booking_id: info.lastInsertRowid };
  },
  log_qa_answer(callId, agentId, args) {
    ensureCall(callId, agentId);
    const { question, answer, intent, grounded, source_excerpt } = args;
    const info = db
      .prepare(`INSERT INTO qa_answers (call_id, question, answer, intent, grounded, source_excerpt) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(callId, question, answer, intent, grounded ? 1 : 0, source_excerpt || null);
    markCallStatus(callId, "completed", `"${intent}" question answered (grounded=${!!grounded})`);
    return { ok: true, qa_id: info.lastInsertRowid };
  },
  log_note(callId, agentId, args) {
    ensureCall(callId, agentId);
    const info = db.prepare(`INSERT INTO notes (call_id, note) VALUES (?, ?)`).run(callId, args.note);
    markCallStatus(callId, "completed", "note logged");
    return { ok: true, note_id: info.lastInsertRowid };
  },
  escalate_to_human(callId, agentId, args) {
    ensureCall(callId, agentId);
    markCallStatus(callId, "escalated", args.reason || "escalated to human");
    return { ok: true };
  },
};

/** Called by the webhook route. Records the invocation and runs the handler. */
export function handleToolCall(toolName, { call_id, agent_id, arguments: args }, config) {
  recordInvocation(call_id, toolName, args, null);
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return { error: `unknown tool ${toolName}` };
  const result = handler(call_id, agent_id, args || {}, config);
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
