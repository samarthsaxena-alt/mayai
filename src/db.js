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
  status_reason TEXT
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
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT REFERENCES calls(id),
  note TEXT NOT NULL,
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
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`);

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
