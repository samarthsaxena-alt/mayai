// Real numbers only — every figure here is a live aggregate over calls,
// bookings, qa_answers, and notes. No seeded/demo data: if no calls have
// happened yet, this returns honest zeros and an empty timeline, not a
// fabricated chart. The grounding rate is the headline metric on purpose —
// it's the product's actual differentiator (see README "The needle-mover"),
// not just another stat.
import { db, getConfig } from "../db.js";
import { getTemplate } from "../industries.js";

export default async function analyticsRoutes(app) {
  app.get("/api/analytics/summary", async (req, reply) => {
    const config = getConfig();
    const tpl = getTemplate(config.template_key);

    const totalCalls = db.prepare(`SELECT COUNT(*) AS n FROM calls`).get().n;
    const statusRows = db.prepare(`SELECT status, COUNT(*) AS n FROM calls GROUP BY status`).all();
    const statusBreakdown = { completed: 0, partial: 0, escalated: 0, in_progress: 0 };
    for (const row of statusRows) statusBreakdown[row.status] = row.n;

    const qaTotals = db.prepare(`SELECT COUNT(*) AS n, SUM(grounded) AS grounded_n FROM qa_answers`).get();
    const groundingRate = qaTotals.n > 0 ? qaTotals.grounded_n / qaTotals.n : null;

    const bookingCount = db.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n;
    const noteCount = db.prepare(`SELECT COUNT(*) AS n FROM notes`).get().n;
    const qaByIntent = db
      .prepare(`SELECT intent, COUNT(*) AS n, SUM(grounded) AS grounded_n FROM qa_answers GROUP BY intent`)
      .all()
      .map((r) => ({ intent: r.intent, count: r.n, grounded: r.grounded_n }));

    // Daily call volume for the last 14 days (real, empty days included as 0 — no gap-filling with fake data beyond zero).
    const days = [];
    const now = Math.floor(Date.now() / 1000) || 0; // Date.now() fine here — this runs at request time, not in a Workflow script
    for (let i = 13; i >= 0; i--) {
      const dayStart = now - i * 86400 - (now % 86400);
      const dayEnd = dayStart + 86400;
      const n = db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE started_at >= ? AND started_at < ?`).get(dayStart, dayEnd).n;
      days.push({ date: new Date(dayStart * 1000).toISOString().slice(0, 10), calls: n });
    }

    const avgDuration = db
      .prepare(`SELECT AVG(ended_at - started_at) AS avg_s FROM calls WHERE ended_at IS NOT NULL`)
      .get().avg_s;

    return reply.send({
      total_calls: totalCalls,
      status_breakdown: statusBreakdown,
      grounding_rate: groundingRate, // null when there's no Q&A data yet — distinct from 0%
      qa_total: qaTotals.n,
      qa_by_intent: qaByIntent,
      booking_count: bookingCount,
      booking_label: tpl.bookingLabel,
      note_count: noteCount,
      note_label: tpl.noteLabel,
      avg_call_duration_s: avgDuration,
      daily_volume: days,
    });
  });
}
