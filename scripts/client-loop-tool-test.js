// Narrows the failure further: declare log_booking WITHOUT an `endpoint` —
// client-loop mode, per the wire protocol docs the engine should emit a
// `tool_call` event over the WS for the client to execute and reply to with
// `tool_result`, instead of the platform calling out to a URL itself. If
// THIS fires, the problem is specifically PyAI's outbound webhook-calling
// (both the inline `endpoint` and REST `webhook_url` flavors) — not the
// model's willingness to call a tool at all.
import { getConfig } from "../src/db.js";
import { buildToolDefs } from "../src/tools.js";

const TAG = { AUDIO: 0x01, TRANSCRIPT: 0x02, CONTROL: 0x03 };
const CALLER_LINE = "Hi, I'd like to book a table for two this Friday at 7 PM. The name is Sam.";
const CONFIRM_LINE = "Yes, that's correct, thank you.";

async function synthesizeAudio(rate, text) {
  const res = await fetch(`${process.env.PYAI_BASE_URL || "https://api.pyai.com"}/v1/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PYAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, response_format: "pcm", sample_rate: rate }),
  });
  if (!res.ok) throw new Error(`Speak API failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(ok, label, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
}

async function main() {
  const config = getConfig();
  const defs = buildToolDefs(config);
  const clientLoopTools = defs.map((d) => ({ name: d.name, description: d.description, parameters: d.input_schema })); // no `endpoint`

  const url = `${(process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/^http/, "ws")}/v1/omni?format=pcm16&rate=24000&session_label=${config.agent_id}`;
  const ws = new WebSocket(url, [`pyai-key.${process.env.PYAI_API_KEY}`]);
  ws.binaryType = "arraybuffer";

  let keepLineOpen = true;
  let toolCallSeen = false;
  const timeout = setTimeout(() => finish(1, "timed out after 45s"), 45000);

  async function streamUtterance(text, label) {
    console.log(`\n--- Turn: "${text}" (${label}) ---`);
    const pcm = await synthesizeAudio(24000, text);
    const chunkSize = 24000 * 2 * 0.02;
    for (let off = 0; off < pcm.length; off += chunkSize) {
      const frame = new Uint8Array(chunkSize + 1);
      frame[0] = TAG.AUDIO;
      frame.set(pcm.subarray(off, off + chunkSize), 1);
      ws.send(frame);
      await sleep(20);
    }
  }

  async function holdLineOpen(ms) {
    const chunkSize = 24000 * 2 * 0.02;
    const silence = new Uint8Array(chunkSize).fill(0);
    const until = Date.now() + ms;
    while (keepLineOpen && Date.now() < until) {
      const frame = new Uint8Array(silence.length + 1);
      frame[0] = TAG.AUDIO;
      frame.set(silence, 1);
      ws.send(frame);
      await sleep(20);
    }
  }

  function sendControl(obj) {
    const json = new TextEncoder().encode(JSON.stringify(obj));
    const frame = new Uint8Array(json.length + 1);
    frame[0] = TAG.CONTROL;
    frame.set(json, 1);
    ws.send(frame);
  }

  ws.addEventListener("open", () => {
    log(true, "websocket upgraded — client-loop tools (no endpoint field)");
    sendControl({
      type: "configure",
      persona: config.behavior_role || "You are a restaurant receptionist.",
      greeting: config.greeting || "Thanks for calling!",
      tools: clientLoopTools,
    });
  });

  ws.addEventListener("message", async (ev) => {
    const buf = Buffer.from(ev.data);
    const tag = buf[0];
    if (tag === TAG.CONTROL) {
      let evt;
      try {
        evt = JSON.parse(buf.subarray(1).toString());
      } catch {
        return;
      }
      if (evt.event === "configured" || evt.event === "config_ack") {
        log(true, "configured", JSON.stringify(evt));
        run();
      } else if (evt.event === "tool_call") {
        toolCallSeen = true;
        log(true, "tool_call EVENT RECEIVED — client-loop path is live", JSON.stringify(evt));
        // Reply so the conversation doesn't stall, proving the round-trip.
        sendControl({ type: "tool_result", call_id: evt.call_id, result: { ok: true, note: "handled by client-loop test script" } });
      } else if (evt.event !== "hello" && evt.event !== "session_started" && evt.type !== "audio_position") {
        console.log("   [control]", JSON.stringify(evt));
      }
    } else if (tag === TAG.TRANSCRIPT) {
      const raw = buf.subarray(1).toString();
      try {
        console.log("   [transcript]", JSON.stringify(JSON.parse(raw)));
      } catch {
        console.log("   [transcript:partial]", JSON.stringify(raw));
      }
    }
  });

  ws.addEventListener("error", (err) => console.error("websocket error", err.message || err));
  ws.addEventListener("close", (ev) => console.log(`   [close] code=${ev.code} reason=${ev.reason}`));

  async function run() {
    await holdLineOpen(6500);
    await streamUtterance(CALLER_LINE, "the booking request");
    await holdLineOpen(6000);
    await streamUtterance(CONFIRM_LINE, "confirming");
    await holdLineOpen(6000);
    finish(toolCallSeen ? 0 : 1);
  }

  function finish(code, note) {
    keepLineOpen = false;
    clearTimeout(timeout);
    console.log("\n--- Summary ---");
    log(toolCallSeen, "tool_call event received over the WS (client-loop path)");
    if (note) console.log(note);
    try {
      ws.close();
    } catch {}
    process.exit(code);
  }
}

main().catch((err) => {
  console.error("client-loop-tool-test failed:", err.message || err);
  process.exit(1);
});
