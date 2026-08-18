// SQLite is our own source of truth for everything PyAI doesn't model for us:
// business config text, bookings, notes, call outcomes, and a full
// tool-invocation audit trail (the "blocking gate" evidence trail). PyAI's
// own Agent/Knowledgebase/Tool resources remain the source of truth for
// persona/voice/KB/tool wiring — this file never duplicates those, it only
// caches the PyAI-side ids we need to address them.
//
// Generic across industries on purpose: a "booking" is a reservation for a
// restaurant, a showing for real estate, an appointment for dental/skincare,
// a service call for HVAC, a consultation for a law firm — same shape, one
// generic detail field whose meaning comes from src/industries.js at
// render/tool-registration time, not from the schema.
import DatabaseCtor from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseCtor(join(DATA_DIR, "open-receptionist.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS business_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  template_key TEXT NOT NULL DEFAULT 'restaurant_general',
  industry_key TEXT NOT NULL DEFAULT 'restaurant',
  business_name TEXT NOT NULL DEFAULT 'My Business',
  ai_name TEXT,                -- the AI's own name (e.g. "Sam") — the "meet your AI" hiring framing hinges on this being a real name, not "your agent"
  agent_id TEXT,               -- PyAI agent_id, once created
  kb_id TEXT,                  -- PyAI knowledgebase id, once created
  greeting TEXT,
  greeting_variants TEXT,      -- JSON array of alternate opening lines; PyAI rotates them per call
  ack_mode TEXT NOT NULL DEFAULT 'auto',  -- conversational acknowledgment ("mm-hmm", "got it") mode
  behavior_role TEXT,
  behavior_personality TEXT,
  behavior_style TEXT,
  callflow_booking_policy TEXT,
  callflow_qa_intents_json TEXT,   -- [{key,label,policy,hardRule}], generalizes menu/allergy etc.
  callflow_note_policy TEXT,
  callflow_fallback_policy TEXT,
  voice_id TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  barge_sensitivity TEXT NOT NULL DEFAULT 'normal',
  idle_check_in TEXT NOT NULL DEFAULT 'auto',
  consent_line TEXT DEFAULT 'This call may be recorded for quality and training purposes.',
  recordings_enabled INTEGER NOT NULL DEFAULT 1,
  tools_bound INTEGER NOT NULL DEFAULT 0,   -- have we PUT our 4 tools onto the agent yet
  phone_number TEXT,
  phone_number_id TEXT,
  telephony_mode TEXT,          -- 'pyai_native' | 'twilio_bridge'
  setup_step TEXT NOT NULL DEFAULT 'business_type', -- business_type | knowledge | live — drives the Quick Start wizard
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_doc_id TEXT,
  filename TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload', -- upload | url | text
  status TEXT NOT NULL DEFAULT 'pending', -- pending | indexed | failed
  fail_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,          -- our own call id: twilio callSid or a generated uuid
  agent_id TEXT,
  caller_number TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | completed | partial | escalated
  status_reason TEXT,
  -- Transcript-extraction workaround (see src/extraction.js) for PyAI's
  -- custom tool-calling not firing live: not_applicable (live tools fired,
  -- nothing to backfill) | pending | success | failed | skipped (no
  -- ANTHROPIC_API_KEY configured).
  extraction_status TEXT NOT NULL DEFAULT 'not_applicable',
  extraction_error TEXT,
  transcript_polled_at INTEGER,
  -- Caps how many times the automatic poller (src/callPoller.js) retries a
  -- call whose transcript never becomes available (e.g. PyAI never
  -- established a real Omni session for it) — without this it retries
  -- forever, once per poll interval. A manual reprocess still ignores this
  -- cap since that's an explicit, one-off user action.
  extraction_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transcript_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES calls(id),
  role TEXT,
  text TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 1,
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT REFERENCES calls(id),
  name TEXT,
  booking_date TEXT,
  booking_time TEXT,
  detail_label TEXT,   -- e.g. "Party size", "Property or listing" — from industries.js at write time
  detail_value TEXT,
  -- 'live_tool_call' (PyAI's engine invoked our webhook directly) or
  -- 'transcript_extraction' (backfilled from the ended-call transcript —
  -- see src/extraction.js). Surfaced in the Actions UI so nothing pretends
  -- to be a live tool call it wasn't.
  source TEXT NOT NULL DEFAULT 'live_tool_call',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT REFERENCES calls(id),
  note TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live_tool_call',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS qa_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT REFERENCES calls(id),
  question TEXT,
  answer TEXT,
  intent TEXT,          -- key from the active industry's qaIntents (e.g. 'menu', 'insurance', 'listing')
  grounded INTEGER NOT NULL DEFAULT 0,
  source_excerpt TEXT,
  source TEXT NOT NULL DEFAULT 'live_tool_call',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pyai_tools (
  name TEXT PRIMARY KEY,   -- our tool name, e.g. 'log_booking'
  tool_id TEXT NOT NULL,   -- PyAI's tool id
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT,
  tool_name TEXT NOT NULL,
  args_json TEXT,
  result_json TEXT,
  source TEXT NOT NULL DEFAULT 'live_tool_call',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Per-business persistent config, added alongside (not replacing)
-- business_config above. business_config remains the internal Quick
-- Start/Customize builder's singleton — untouched, still works exactly as
-- before. This table is for the public marketing-site flow: every verified
-- business (keyed by its own domain, or a slug fallback) keeps its own
-- agent_id + kb_id permanently, so a second business configuring theirs
-- never overwrites or destroys the first one's setup. The shared phone
-- number can still only be bound to one agent_id at a time (see
-- /api/telephony/go-live) — that's a real, disclosed limitation, not
-- something this table pretends to solve.
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_key TEXT UNIQUE NOT NULL,
  template_key TEXT NOT NULL DEFAULT 'restaurant_general',
  industry_key TEXT NOT NULL DEFAULT 'restaurant',
  business_name TEXT NOT NULL,
  ai_name TEXT,
  agent_id TEXT,
  kb_id TEXT,
  greeting TEXT,
  greeting_variants TEXT,
  ack_mode TEXT NOT NULL DEFAULT 'auto',
  behavior_role TEXT,
  behavior_personality TEXT,
  behavior_style TEXT,
  callflow_booking_policy TEXT,
  callflow_qa_intents_json TEXT,
  callflow_note_policy TEXT,
  callflow_fallback_policy TEXT,
  voice_id TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  barge_sensitivity TEXT NOT NULL DEFAULT 'normal',
  idle_check_in TEXT NOT NULL DEFAULT 'auto',
  consent_line TEXT DEFAULT 'This call may be recorded for quality and training purposes.',
  recordings_enabled INTEGER NOT NULL DEFAULT 1,
  tools_bound INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`);

// --- Migrations for columns added after the initial CREATE TABLE shipped ---
// better-sqlite3/SQLite has no "ADD COLUMN IF NOT EXISTS"; guard by checking
// PRAGMA table_info so this stays idempotent across restarts on an existing
// on-disk database (data/open-receptionist.db predates these columns).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("calls", "extraction_status", `extraction_status TEXT NOT NULL DEFAULT 'not_applicable'`);
ensureColumn("calls", "extraction_error", `extraction_error TEXT`);
ensureColumn("calls", "transcript_polled_at", `transcript_polled_at INTEGER`);
ensureColumn("calls", "extraction_attempts", `extraction_attempts INTEGER NOT NULL DEFAULT 0`);
ensureColumn("calls", "summary", `summary TEXT`);
ensureColumn("business_config", "ai_name", `ai_name TEXT`);
ensureColumn("bookings", "source", `source TEXT NOT NULL DEFAULT 'live_tool_call'`);
ensureColumn("notes", "source", `source TEXT NOT NULL DEFAULT 'live_tool_call'`);
ensureColumn("qa_answers", "source", `source TEXT NOT NULL DEFAULT 'live_tool_call'`);
ensureColumn("tool_invocations", "source", `source TEXT NOT NULL DEFAULT 'live_tool_call'`);
ensureColumn("knowledge_documents", "business_id", `business_id INTEGER REFERENCES businesses(id)`);

// Ensure the singleton config row exists.
db.prepare(`INSERT OR IGNORE INTO business_config (id) VALUES (1)`).run();

export function getConfig() {
  return db.prepare(`SELECT * FROM business_config WHERE id = 1`).get();
}

export function updateConfig(fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return getConfig();
  const set = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(`UPDATE business_config SET ${set}, updated_at = unixepoch() WHERE id = 1`).run(fields);
  return getConfig();
}

// --- Per-business persistent config (see businesses table above) ---------

export function getBusinessByKey(key) {
  return db.prepare(`SELECT * FROM businesses WHERE business_key = ?`).get(key);
}

export function getBusinessById(id) {
  return db.prepare(`SELECT * FROM businesses WHERE id = ?`).get(id);
}

export function createBusiness(key, businessName) {
  db.prepare(`INSERT INTO businesses (business_key, business_name) VALUES (?, ?)`).run(key, businessName || key);
  return getBusinessByKey(key);
}

export function getOrCreateBusiness(key, businessName) {
  return getBusinessByKey(key) || createBusiness(key, businessName);
}

export function updateBusiness(id, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return getBusinessById(id);
  const set = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(`UPDATE businesses SET ${set}, updated_at = unixepoch() WHERE id = @id`).run({ ...fields, id });
  return getBusinessById(id);
}

export function listBusinesses() {
  return db.prepare(`SELECT id, business_key, business_name, agent_id, kb_id, updated_at FROM businesses ORDER BY updated_at DESC`).all();
}
