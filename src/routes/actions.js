// Actions screen: what actually happened on real calls. Every row here comes
// from a real tool invocation the live agent made (or a call that ended
// without one), never seeded/mocked data.
import { db } from "../db.js";

export default async function actionsRoutes(app) {
  app.get("/api/actions/calls", async (req, reply) => {
    const calls = db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM reservations r WHERE r.call_id = c.id) AS reservation_count,
                (SELECT COUNT(*) FROM qa_answers q WHERE q.call_id = c.id) AS qa_count,
                (SELECT COUNT(*) FROM special_requests s WHERE s.call_id = c.id) AS special_request_count
         FROM calls c
         ORDER BY c.started_at DESC
         LIMIT 200`
      )
      .all();
    return reply.send({ calls });
  });

  app.get("/api/actions/calls/:id", async (req, reply) => {
    const id = req.params.id;
    const call = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(id);
    if (!call) return reply.code(404).send({ error: "not found" });
    return reply.send({
      call,
      transcript: db.prepare(`SELECT * FROM transcript_lines WHERE call_id = ? ORDER BY ts, id`).all(id),
      reservations: db.prepare(`SELECT * FROM reservations WHERE call_id = ?`).all(id),
      qa_answers: db.prepare(`SELECT * FROM qa_answers WHERE call_id = ?`).all(id),
      special_requests: db.prepare(`SELECT * FROM special_requests WHERE call_id = ?`).all(id),
      tool_invocations: db.prepare(`SELECT * FROM tool_invocations WHERE call_id = ? ORDER BY created_at, id`).all(id),
    });
  });

  app.get("/api/actions/reservations", async (req, reply) => {
    return reply.send({ reservations: db.prepare(`SELECT * FROM reservations ORDER BY created_at DESC LIMIT 200`).all() });
  });

  app.get("/api/actions/special-requests", async (req, reply) => {
    return reply.send({
      special_requests: db.prepare(`SELECT * FROM special_requests ORDER BY created_at DESC LIMIT 200`).all(),
    });
  });

  app.get("/api/actions/qa", async (req, reply) => {
    return reply.send({ qa_answers: db.prepare(`SELECT * FROM qa_answers ORDER BY created_at DESC LIMIT 200`).all() });
  });
}
