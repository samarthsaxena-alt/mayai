// Hour 0-2 telephony spike, de-risked for the part we can test before a real
// phone number exists (that needs a live PyAI key + a purchased number, a
// deliberate manual step — see README). This proves the actual riskiest
// *software* piece instead: create a real persistent PyAI agent, open a real
// Omni realtime session against it, and confirm the full lifecycle fires and
// its stored greeting is actually spoken — before building anything else on
// top of it.
//
// Run: npm run spike
import { agents } from "../src/pyai.js";

const TAG = { AUDIO: 0x01, TRANSCRIPT: 0x02, CONTROL: 0x03 };
const GREETING = "Hello from Open Receptionist. This is a live spike test of the Omni connection.";

function log(ok, label, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
}

async function main() {
  console.log("--- Step 1: create a throwaway test agent on PyAI ---");
  const agent = await agents.create({
    name: "Open Receptionist SPIKE TEST",
    persona_system_prompt: "You are a phone test fixture. Say only your configured greeting, then stay quiet.",
    greeting: GREETING,
    language: "en",
  });
  log(true, "agent created", agent.agent_id);

  console.log("\n--- Step 2: open a real Omni realtime session against it ---");
  const url = `${(process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/^http/, "ws")}/v1/omni?format=pcm16&rate=24000&session_label=${agent.agent_id}`;
  const ws = new WebSocket(url, [`pyai-key.${process.env.PYAI_API_KEY}`]);

  const seen = { hello: false, session_started: false, configured: false, greeting_transcript: false, greeting_audio_bytes: 0 };
  const timeout = setTimeout(() => {
    console.error("\n⏱  Timed out after 15s waiting for the full lifecycle.");
    finish(1);
  }, 15000);

  ws.addEventListener("open", () => {
    log(true, "websocket upgraded");
    const configureFrame = new TextEncoder().encode(JSON.stringify({ type: "configure" }));
    const frame = new Uint8Array(configureFrame.length + 1);
    frame[0] = TAG.CONTROL;
    frame.set(configureFrame, 1);
    ws.send(frame);
  });

  ws.addEventListener("message", (ev) => {
    const buf = Buffer.from(ev.data);
    const tag = buf[0];
    if (tag === TAG.CONTROL) {
      const evt = JSON.parse(buf.subarray(1).toString());
      if (evt.event === "hello") { seen.hello = true; log(true, "hello", JSON.stringify(evt)); }
      if (evt.event === "session_started") { seen.session_started = true; log(true, "session_started"); }
      if (evt.event === "configured" || evt.event === "config_ack") { seen.configured = true; log(true, "configured", JSON.stringify(evt)); }
      if (evt.event === "session_end") { console.log("session ended by server"); finish(seen.greeting_transcript ? 0 : 1); }
    } else if (tag === TAG.TRANSCRIPT) {
      const evt = JSON.parse(buf.subarray(1).toString());
      if (evt.role === "assistant" && evt.final) {
        seen.greeting_transcript = true;
        log(true, "assistant transcript", evt.text);
      }
    } else if (tag === TAG.AUDIO) {
      seen.greeting_audio_bytes += buf.length - 1;
    }

    if (seen.hello && seen.session_started && seen.greeting_transcript && seen.greeting_audio_bytes > 0) {
      clearTimeout(timeout);
      setTimeout(() => finish(0), 500); // let a little more audio land, then stop
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("websocket error", err.message || err);
  });

  function finish(code) {
    console.log("\n--- Summary ---");
    log(seen.hello, "hello received");
    log(seen.session_started, "session_started received");
    log(seen.greeting_transcript, "greeting transcript received");
    log(seen.greeting_audio_bytes > 0, "greeting audio bytes received", `${seen.greeting_audio_bytes} bytes`);
    try { ws.close(); } catch {}
    process.exit(code);
  }
}

main().catch((err) => {
  console.error("Spike failed:", err.message || err);
  process.exit(1);
});
