// SQLite is our own source of truth for everything PyAI doesn't model for us:
// restaurant-specific config text, reservations, special requests, call outcomes,
// and a full tool-invocation audit trail (the "blocking gate" evidence trail).
// PyAI's own Agent/Knowledgebase/Tool resources remain the source of truth for
// persona/voice/KB/tool wiring — this file never duplicates those, it only
// caches the PyAI-side ids we need to address them.
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
CREATE TABLE IF NOT EXISTS restaurant_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  template_key TEXT NOT NULL DEFAULT 'restaurant_general',
  restaurant_name TEXT NOT NULL DEFAULT 'My Restaurant',
  agent_id TEXT,               -- PyAI agent_id, once created
  kb_id TEXT,                  -- PyAI knowledgebase id, once created
  greeting TEXT,
  behavior_role TEXT,
  behavior_personality TEXT,
  behavior_style TEXT,
  callflow_reservation_policy TEXT,
  callflow_menu_policy TEXT,
  callflow_allergy_policy TEXT,
  callflow_special_policy TEXT,
  callflow_fallback_policy TEXT,
  voice_id TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  barge_sensitivity TEXT NOT NULL DEFAULT 'normal',
  idle_check_in TEXT NOT NULL DEFAULT 'auto',
  consent_line TEXT,
  recordings_enabled INTEGER NOT NULL DEFAULT 1,
  tools_bound INTEGER NOT NULL DEFAULT 0,   -- have we PUT our 4 tools onto the agent yet
  phone_number TEXT,
  phone_number_id TEXT,
  telephony_mode TEXT,          -- 'pyai_native' | 'twilio_bridge'
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_doc_id TEXT,
  filename TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT REFERENCES calls(id),
  name TEXT,
  party_size INTEGER,
  reservation_date TEXT,
  reservation_time TEXT,
  special_request TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS special_requests (
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
  intent TEXT,          -- 'menu' | 'allergy'
  grounded INTEGER NOT NULL DEFAULT 0,
  source_excerpt TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pyai_tools (
  name TEXT PRIMARY KEY,   -- our tool name, e.g. 'log_reservation'
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
db.prepare(`INSERT OR IGNORE INTO restaurant_config (id) VALUES (1)`).run();

export function getConfig() {
  return db.prepare(`SELECT * FROM restaurant_config WHERE id = 1`).get();
}

export function updateConfig(fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return getConfig();
  const set = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(`UPDATE restaurant_config SET ${set}, updated_at = unixepoch() WHERE id = 1`).run(fields);
  return getConfig();
}
