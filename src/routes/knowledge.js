// Knowledge screen: upload a menu/allergen PDF. The file is actually sent to
// PyAI's Knowledgebase API, which parses/chunks/indexes it server-side — we
// don't hand-roll PDF parsing. No PDF uploaded = the agent's persona already
// tells it to say so rather than guess (see promptBuilder.js).
import { getConfig, updateConfig, db } from "../db.js";
import { knowledgebases } from "../pyai.js";
import { syncAgent } from "../agentSync.js";

const MAX_RETRIES = 2;

async function ensureKb(restaurantName) {
  const config = getConfig();
  if (config.kb_id) return config.kb_id;
  const kb = await knowledgebases.create(`${restaurantName || "Open Receptionist"} — menu & allergens`);
  updateConfig({ kb_id: kb.id });
  return kb.id;
}

export default async function knowledgeRoutes(app) {
  app.get("/api/knowledge", async (req, reply) => {
    const config = getConfig();
    const docs = db.prepare(`SELECT * FROM knowledge_documents ORDER BY uploaded_at DESC`).all();

    // Refresh status for anything not yet indexed/failed-out.
    if (config.kb_id) {
      for (const doc of docs) {
        if (!doc.kb_doc_id || doc.status === "indexed") continue;
        try {
          const remote = await knowledgebases.getDocument(config.kb_id, doc.kb_doc_id);
          const status = remote.status === "indexed" ? "indexed" : remote.status === "failed" ? "failed" : "pending";
          db.prepare(`UPDATE knowledge_documents SET status = ?, fail_reason = ?, updated_at = unixepoch() WHERE id = ?`).run(
            status,
            remote.error || null,
            doc.id
          );
          doc.status = status;
          doc.fail_reason = remote.error || null;
        } catch (err) {
          req.log.warn(err, "failed to refresh knowledge doc status");
        }
      }
    }

    return reply.send({
      documents: docs.map((d) => ({ ...d, can_retry: d.status === "failed" && d.retry_count < MAX_RETRIES })),
      has_knowledge_base: !!config.kb_id,
    });
  });

  app.post("/api/knowledge/upload", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no file uploaded" });

    const config = getConfig();
    const buffer = await file.toBuffer();
    const kbId = await ensureKb(config.restaurant_name);

    const info = db
      .prepare(`INSERT INTO knowledge_documents (filename, status) VALUES (?, 'pending')`)
      .run(file.filename);

    try {
      const uploaded = await knowledgebases.uploadFile(kbId, buffer, file.filename, file.filename);
      db.prepare(`UPDATE knowledge_documents SET kb_doc_id = ?, status = ? WHERE id = ?`).run(
        uploaded.id,
        uploaded.status === "indexed" ? "indexed" : "pending",
        info.lastInsertRowid
      );
      await syncAgent(); // binds the KB to the agent the first time one exists
      return reply.send({ document_id: info.lastInsertRowid, kb_doc_id: uploaded.id, status: uploaded.status });
    } catch (err) {
      db.prepare(`UPDATE knowledge_documents SET status = 'failed', fail_reason = ? WHERE id = ?`).run(
        String(err.message || err),
        info.lastInsertRowid
      );
      req.log.error(err, "knowledge upload failed");
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
