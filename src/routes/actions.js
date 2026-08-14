// Actions screen: what actually happened on real calls. Every row here comes
// from a real tool invocation the live agent made (or a call that ended
// without one), never seeded/mocked data.
import { db, getConfig } from "../db.js";
import { getTemplate } from "../industries.js";
import { processCallTranscript } from "../extraction.js";

export default async function actionsRoutes(app) {
  app.get("/api/actions/calls", async (req, reply) => {
    const config = getConfig();
    const tpl = getTemplate(config.template_key);
    const calls = db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM bookings b WHERE b.call_id = c.id) AS booking_count,
                (SELECT COUNT(*) FROM qa_answers q WHERE q.call_id = c.id) AS qa_count,
                (SELECT COUNT(*) FROM notes n WHERE n.call_id = c.id) AS note_count
         FROM calls c
         ORDER BY c.started_at DESC
         LIMIT 200`
      )
      .all();
    return reply.send({ calls, booking_label: tpl.bookingLabel, note_label: tpl.noteLabel });
  });

  app.get("/api/actions/calls/:id", async (req, reply) => {
    const id = req.params.id;
    const call = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(id);
    if (!call) return reply.code(404).send({ error: "not found" });
    return reply.send({
      call,
      transcript: db.prepare(`SELECT * FROM transcript_lines WHERE call_id = ? ORDER BY ts, id`).all(id),
      bookings: db.prepare(`SELECT * FROM bookings WHERE call_id = ?`).all(id),
      qa_answers: db.prepare(`SELECT * FROM qa_answers WHERE call_id = ?`).all(id),
      notes: db.prepare(`SELECT * FROM notes WHERE call_id = ?`).all(id),
      tool_invocations: db.prepare(`SELECT * FROM tool_invocations WHERE call_id = ? ORDER BY created_at, id`).all(id),
    });
  });

  // Manual retry for the transcript-extraction workaround (src/extraction.js)
  // — useful since the automatic pass on call-end is fire-and-forget and can
  // fail transiently (e.g. transcript not yet finalized, a rate limit).
  app.post("/api/actions/calls/:id/reprocess", async (req, reply) => {
    const call = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(req.params.id);
    if (!call) return reply.code(404).send({ error: "not found" });
    const result = await processCallTranscript(call.id, call.agent_id, getConfig());
    return reply.send(result);
  });

  app.get("/api/actions/bookings", async (req, reply) => {
    return reply.send({ bookings: db.prepare(`SELECT * FROM bookings ORDER BY created_at DESC LIMIT 200`).all() });
  });

  app.get("/api/actions/notes", async (req, reply) => {
    return reply.send({ notes: db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT 200`).all() });
  });

  app.get("/api/actions/qa", async (req, reply) => {
    return reply.send({ qa_answers: db.prepare(`SELECT * FROM qa_answers ORDER BY created_at DESC LIMIT 200`).all() });
  });
}
