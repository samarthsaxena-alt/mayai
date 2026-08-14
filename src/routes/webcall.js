// Web calling — "Talk to {name} right here," modeled on JustCall's own AIVA
// "Talk to Mia" widget. The browser connects DIRECTLY to PyAI's Omni
// WebSocket; this route's only job is minting a short-lived, origin-locked
// session token so the browser never has to hold PYAI_API_KEY.
//
// This replaced an earlier version of this file that itself held the
// WebSocket relay (browser <-> us <-> PyAI), proxying every audio frame.
// That worked, but pinned this route to a persistent-process host — a
// serverless platform like Vercel can't hold a long-lived WS connection open
// in a function invocation. Minting a token is a single stateless request/
// response, which runs fine anywhere.
//
// Sends NO inline `configure` frame — confirmed by direct testing that
// session_label alone auto-loads this agent's real greeting/persona/KB/tools
// binding, exactly like native telephony and the Twilio bridge already do.
// An earlier version of the (then server-side) relay sent one anyway,
// containing only {greeting, persona} — no kb/tools keys — which was
// silently overwriting the auto-loaded binding instead of adding to it.
//
// Token lifetime only gates the initial handshake, not an established call —
// confirmed by holding a session open well past its token's ttl_seconds with
// no server-initiated close. session_label is still the agent_id, so
// src/callPoller.js's existing poll of `GET /v1/omni/calls?session_label=`
// picks these calls up for free, identical to every other transport.
import { getConfig } from "../db.js";
import { omni } from "../pyai.js";

export default async function webcallRoutes(app) {
  app.post("/api/webcall/token", async (req, reply) => {
    const config = getConfig();
    if (!config.agent_id) {
      return reply.code(409).send({ error: "not_configured", message: "Finish setup before starting a web call." });
    }

    // The browser's subsequent WebSocket handshake presents this exact
    // Origin automatically (browsers set it, page JS cannot override it) —
    // locking the token to it is what PyAI requires for a browser-held
    // token, and using the live request's own Origin (rather than a
    // hardcoded PUBLIC_HOST) means this works unmodified in dev, behind a
    // tunnel, or on whatever domain this ends up deployed to.
    const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;

    let session;
    try {
      session = await omni.createSession({ allowed_origins: [origin], session_label: config.agent_id });
    } catch (err) {
      app.log.error(err, "web call: failed to mint Omni session token");
      return reply.code(502).send({ error: "token_mint_failed", message: "Couldn't start a web call session — try again." });
    }

    return {
      token: session.token,
      url: `${session.url}&session_label=${config.agent_id}`,
      expires_at: session.expires_at,
      ai_name: config.ai_name || null,
    };
  });
}
