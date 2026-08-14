import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import configRoutes from "./src/routes/config.js";
import knowledgeRoutes from "./src/routes/knowledge.js";
import actionsRoutes from "./src/routes/actions.js";
import webhooksRoutes from "./src/routes/webhooks.js";
import telephonyRoutes from "./src/routes/telephony.js";
import analyticsRoutes from "./src/routes/analytics.js";
import webcallRoutes from "./src/routes/webcall.js";
import { startCallPoller } from "./src/callPoller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { PORT = "8080" } = process.env;

if (!process.env.PYAI_API_KEY) {
  console.error("Missing PYAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!process.env.TOOL_WEBHOOK_SECRET) {
  console.error("Missing TOOL_WEBHOOK_SECRET. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const app = Fastify({ logger: true });

// Demo-only: the MayAI marketing site (a Claude Artifact, origin varies) needs
// to call these APIs directly from the browser. Reflecting any origin is fine
// for a hackathon demo hitting a single-tenant dev backend behind a tunnel —
// tighten this to an explicit allowlist before this is ever real production.
await app.register(cors, { origin: true, methods: ["GET", "POST"] });

// Preserve the raw request body alongside the normal parsed JSON — needed to
// verify X-PyAI-Signature on incoming webhooks (HMAC-SHA256 over the exact
// raw bytes, not a re-serialization of the parsed object, which could differ
// in key order/whitespace). Every other route's req.body works exactly as
// before; this only adds req.rawBody alongside it.
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  req.rawBody = body;
  if (body.length === 0) return done(null, undefined);
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    err.statusCode = 400;
    done(err);
  }
});

await app.register(websocket);
await app.register(multipart);
await app.register(fastifyStatic, { root: join(__dirname, "public") });

await app.register(configRoutes);
await app.register(knowledgeRoutes);
await app.register(actionsRoutes);
await app.register(webhooksRoutes);
await app.register(telephonyRoutes);
await app.register(analyticsRoutes);
await app.register(webcallRoutes);

app.get("/api/health", async () => ({ ok: true }));

await app.listen({ port: Number(PORT), host: "0.0.0.0" });
app.log.info(`Open Receptionist listening on :${PORT}`);
app.log.info(`Builder UI: http://localhost:${PORT}/`);

// Detects ended PyAI-native calls (no Twilio WS to hook onClose into) and
// runs the transcript-extraction workaround on them — see src/callPoller.js.
startCallPoller(app.log);
if (!process.env.PUBLIC_HOST) {
  app.log.warn("PUBLIC_HOST is not set — tool webhook registration and Twilio's /voice will use the request Host header.");
}
