// Server-execution tool webhooks. PyAI's engine POSTs here directly when the
// live agent decides to call a tool — this is real engine-native function
// calling, not something our WebSocket bridge code has to intercept.
import { handleToolCall } from "../tools.js";

export default async function webhooksRoutes(app) {
  app.post("/webhooks/tools/:name", async (req, reply) => {
    const secret = req.headers["x-tool-secret"];
    if (!secret || secret !== process.env.TOOL_WEBHOOK_SECRET) {
      req.log.warn("rejected tool webhook call: bad or missing X-Tool-Secret");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const { name } = req.params;
    const body = req.body || {};
    req.log.info({ tool: name, call_id: body.call_id, args: body.arguments }, "tool call");

    try {
      const result = handleToolCall(name, body);
      return reply.send(result);
    } catch (err) {
      req.log.error(err, "tool handler failed");
      return reply.code(500).send({ error: String(err.message || err) });
    }
  });
}
