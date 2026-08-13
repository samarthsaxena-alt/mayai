import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import configRoutes from "./src/routes/config.js";
import knowledgeRoutes from "./src/routes/knowledge.js";
import actionsRoutes from "./src/routes/actions.js";
import webhooksRoutes from "./src/routes/webhooks.js";
import telephonyRoutes from "./src/routes/telephony.js";
import analyticsRoutes from "./src/routes/analytics.js";

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

await app.register(websocket);
await app.register(multipart);
await app.register(fastifyStatic, { root: join(__dirname, "public") });

await app.register(configRoutes);
await app.register(knowledgeRoutes);
await app.register(actionsRoutes);
await app.register(webhooksRoutes);
await app.register(telephonyRoutes);
await app.register(analyticsRoutes);

app.get("/api/health", async () => ({ ok: true }));

await app.listen({ port: Number(PORT), host: "0.0.0.0" });
app.log.info(`Open Receptionist listening on :${PORT}`);
app.log.info(`Builder UI: http://localhost:${PORT}/`);
if (!process.env.PUBLIC_HOST) {
  app.log.warn("PUBLIC_HOST is not set — tool webhook registration and Twilio's /voice will use the request Host header.");
}
