// Knowledge screen. Three real ways in, not just "upload a PDF" — most of
// the businesses this is actually for (HVAC, dental, a corner bakery) don't
// have a menu/service PDF sitting around, and plenty have no website at all:
//   - upload a file (PDF, etc.)
//   - point at a URL they already have (Google Business Profile, Facebook
//     Page, Yelp listing — almost every SMB has ONE of these even with zero
//     real web presence)
//   - just paste text (a plain "what we offer, what it costs, what people
//     always ask" form — no file, no URL, for the person who's never made
//     a PDF in their life)
// All three hit the same PyAI Knowledgebase API, which parses/indexes
// server-side — we don't hand-roll parsing for any of them. No knowledge
// source at all = the agent's persona already tells it to say so rather than
// guess (see promptBuilder.js).
import { getConfig, updateConfig, db } from "../db.js";
import { knowledgebases } from "../pyai.js";
import { syncAgent } from "../agentSync.js";
import { getTemplate } from "../industries.js";

const MAX_RETRIES = 2;

async function ensureKb(businessName, knowledgeLabel) {
  const config = getConfig();
  if (config.kb_id) return config.kb_id;
  const kb = await knowledgebases.create(`${businessName || "Open Receptionist"} — ${knowledgeLabel || "knowledge"}`);
  updateConfig({ kb_id: kb.id });
  return kb.id;
}

function insertDoc(filename, source) {
  return db.prepare(`INSERT INTO knowledge_documents (filename, source, status) VALUES (?, ?, 'pending')`).run(filename, source);
}

// Recording the document's own status and binding the KB to the agent are
// two different things that can fail independently — a syncAgent() hiccup
// (e.g. PUBLIC_HOST not set yet) must never be mistaken for the document
// itself having failed to upload/index, or a perfectly good document gets
// marked "failed" and offered a pointless retry.
function recordDocSuccess(info, uploaded) {
  db.prepare(`UPDATE knowledge_documents SET kb_doc_id = ?, status = ? WHERE id = ?`).run(
    uploaded.id,
    uploaded.status === "indexed" ? "indexed" : "pending",
    info.lastInsertRowid
  );
}

async function bindKbBestEffort(req) {
  try {
    await syncAgent(); // binds the KB to the agent the first time one exists
  } catch (err) {
    req.log.warn(err, "document indexed, but syncing the agent (e.g. tool webhooks) failed — will retry on next save");
  }
}

function onUploadFail(info, err) {
  db.prepare(`UPDATE knowledge_documents SET status = 'failed', fail_reason = ? WHERE id = ?`).run(String(err.message || err), info.lastInsertRowid);
}

export default async function knowledgeRoutes(app) {
  app.get("/api/knowledge", async (req, reply) => {
    const config = getConfig();
    const tpl = getTemplate(config.template_key);
    const docs = db.prepare(`SELECT * FROM knowledge_documents ORDER BY uploaded_at DESC`).all();

    // Refresh status for anything not yet indexed/failed-out. Uses the
    // whole-knowledgebase GET (returns each document inline) rather than the
    // per-document GET — that route 404s on the live API despite being in
    // PyAI's own OpenAPI spec, found by actually calling it.
    const needsRefresh = docs.some((d) => d.kb_doc_id && d.status !== "indexed");
    if (config.kb_id && needsRefresh) {
      try {
        const kb = await knowledgebases.get(config.kb_id);
        const byId = new Map((kb.documents || []).map((d) => [d.id, d]));
        for (const doc of docs) {
          const remote = byId.get(doc.kb_doc_id);
          if (!remote || doc.status === "indexed") continue;
          const status = remote.status === "indexed" ? "indexed" : remote.status === "failed" ? "failed" : "pending";
          db.prepare(`UPDATE knowledge_documents SET status = ?, fail_reason = ?, updated_at = unixepoch() WHERE id = ?`).run(
            status,
            remote.error || null,
            doc.id
          );
          doc.status = status;
          doc.fail_reason = remote.error || null;
        }
      } catch (err) {
        req.log.warn(err, "failed to refresh knowledge doc statuses");
      }
    }

    return reply.send({
      documents: docs.map((d) => ({ ...d, can_retry: d.status === "failed" && d.retry_count < MAX_RETRIES })),
      has_knowledge_base: !!config.kb_id,
      knowledge_label: tpl.knowledgeLabel,
    });
  });

  app.post("/api/knowledge/upload", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no file uploaded" });

    const config = getConfig();
    const tpl = getTemplate(config.template_key);
    const buffer = await file.toBuffer();
    const kbId = await ensureKb(config.business_name, tpl.knowledgeLabel);
    const info = insertDoc(file.filename, "upload");

    try {
      const uploaded = await knowledgebases.uploadFile(kbId, buffer, file.filename, file.filename);
      recordDocSuccess(info, uploaded);
      await bindKbBestEffort(req);
      return reply.send({ document_id: info.lastInsertRowid, kb_doc_id: uploaded.id, status: uploaded.status });
    } catch (err) {
      onUploadFail(info, err);
      req.log.error(err, "knowledge upload failed");
      return reply.code(502).send({ error: String(err.message || err), document_id: info.lastInsertRowid });
    }
  });

  // No PDF, but they have a Google Business Profile / Facebook Page / Yelp
  // listing URL — point PyAI at it directly.
  app.post("/api/knowledge/url", async (req, reply) => {
    const { url } = req.body || {};
    if (!url) return reply.code(400).send({ error: "no url provided" });

    const config = getConfig();
    const tpl = getTemplate(config.template_key);
    const kbId = await ensureKb(config.business_name, tpl.knowledgeLabel);
    const info = insertDoc(url, "url");

    try {
      const added = await knowledgebases.addUrl(kbId, url, url);
      recordDocSuccess(info, added);
      await bindKbBestEffort(req);
      return reply.send({ document_id: info.lastInsertRowid, kb_doc_id: added.id, status: added.status });
    } catch (err) {
      onUploadFail(info, err);
      req.log.error(err, "knowledge url add failed");
      return reply.code(502).send({ error: String(err.message || err), document_id: info.lastInsertRowid });
    }
  });

  // No file, no website — just typed-in text (a plain Q&A / price list form).
  app.post("/api/knowledge/text", async (req, reply) => {
    const { text, title } = req.body || {};
    if (!text || !text.trim()) return reply.code(400).send({ error: "no text provided" });

    const config = getConfig();
    const tpl = getTemplate(config.template_key);
    const kbId = await ensureKb(config.business_name, tpl.knowledgeLabel);
    const label = title || "Typed-in info";
    const info = insertDoc(label, "text");

    try {
      const added = await knowledgebases.addText(kbId, text, label);
      recordDocSuccess(info, added);
      await bindKbBestEffort(req);
      return reply.send({ document_id: info.lastInsertRowid, kb_doc_id: added.id, status: added.status });
    } catch (err) {
      onUploadFail(info, err);
      req.log.error(err, "knowledge text add failed");
      return reply.code(502).send({ error: String(err.message || err), document_id: info.lastInsertRowid });
    }
  });

  // Bounded retry: at most MAX_RETRIES, failure reason always surfaced — never a silent hang.
  app.post("/api/knowledge/:id/retry", async (req, reply) => {
    const id = Number(req.params.id);
    const doc = db.prepare(`SELECT * FROM knowledge_documents WHERE id = ?`).get(id);
    if (!doc) return reply.code(404).send({ error: "not found" });
    if (doc.retry_count >= MAX_RETRIES) {
      return reply.code(409).send({ error: `retry limit (${MAX_RETRIES}) reached`, fail_reason: doc.fail_reason });
    }
    const config = getConfig();
    if (!config.kb_id || !doc.kb_doc_id) {
      return reply.code(400).send({ error: "nothing to retry — upload failed before indexing started" });
    }
    try {
      const result = await knowledgebases.retryDocument(config.kb_id, doc.kb_doc_id);
      db.prepare(
        `UPDATE knowledge_documents SET status = 'pending', retry_count = retry_count + 1, fail_reason = NULL, updated_at = unixepoch() WHERE id = ?`
      ).run(id);
      return reply.send({ ok: true, result });
    } catch (err) {
      db.prepare(
        `UPDATE knowledge_documents SET retry_count = retry_count + 1, fail_reason = ?, updated_at = unixepoch() WHERE id = ?`
      ).run(String(err.message || err), id);
      return reply.code(502).send({ error: String(err.message || err) });
    }
  });
}
