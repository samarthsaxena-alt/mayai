// Tests the OTHER documented tool mechanism: sending `tools` inline in the
// Omni configure frame (with an explicit per-tool `endpoint`), rather than
// relying on session_label to auto-load tools bound to a persistent Agent —
// which an earlier test showed does NOT happen for an external client.
//
// Two-turn conversation: the caller asks for a booking, the agent (per our
// own persona's rule) reads the details back for confirmation, the caller
// confirms, and ONLY THEN should log_booking actually fire. A one-turn test
// would never see the tool call — that's correct behavior, not a bug.
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

function log(ok, label, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = getConfig();
  const defs = buildToolDefs(config);
  const host = process.env.PUBLIC_HOST;
  const inlineTools = defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.input_schema,
    endpoint: `https://${host}/webhooks/tools/${d.name}`,
  }));

  const url = `${(process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/^http/, "ws")}/v1/omni?format=pcm16&rate=24000&session_label=${config.agent_id}`;
  const ws = new WebSocket(url, [`pyai-key.${process.env.PYAI_API_KEY}`]);
  ws.binaryType = "arraybuffer";

  let keepLineOpen = true;
  let audioSinceLastSend = 0;
  const timeout = setTimeout(() => finish(1, "timed out after 55s"), 55000);

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

  async function runConversation() {
    await holdLineOpen(6500); // let the greeting finish
    audioSinceLastSend = 0;
    await streamUtterance(CALLER_LINE, "the booking request");
    await holdLineOpen(6000); // let the agent's read-back reply finish
    log(audioSinceLastSend > 0, "assistant replied with audio after turn 1", `${audioSinceLastSend} bytes`);

    audioSinceLastSend = 0;
    await streamUtterance(CONFIRM_LINE, "confirming the details");
    await holdLineOpen(6000); // let any closing reply finish
    log(audioSinceLastSend > 0, "assistant replied with audio after turn 2", `${audioSinceLastSend} bytes`);
  }

  ws.addEventListener("open", () => {
    log(true, "websocket upgraded — sending tools INLINE");
    const configureFrame = new TextEncoder().encode(
      JSON.stringify({
        type: "configure",
        persona: config.behavior_role || "You are a restaurant receptionist.",
        greeting: config.greeting || "Thanks for calling!",
        tools: inlineTools,
      })
    );
    const frame = new Uint8Array(configureFrame.length + 1);
    frame[0] = TAG.CONTROL;
    frame.set(configureFrame, 1);
    ws.send(frame);
  });

  ws.addEventListener("message", (ev) => {
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
        runConversation().then(() => pollAndFinish());
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
    } else if (tag === TAG.AUDIO) {
      audioSinceLastSend += buf.length - 1;
    }
  });

  ws.addEventListener("error", (err) => console.error("websocket error", err.message || err));
  ws.addEventListener("close", (ev) => console.log(`   [close] code=${ev.code} reason=${ev.reason}`));

  async function pollForBooking() {
    for (let i = 0; i < 6; i++) {
      await sleep(1500);
      try {
        const res = await fetch("http://localhost:" + (process.env.PORT || 8080) + "/api/actions/bookings");
        const { bookings } = await res.json();
        if (bookings.length > 0) return bookings[0];
      } catch {}
    }
    return null;
  }

  async function pollAndFinish() {
    const booking = await pollForBooking();
    if (booking) {
      log(true, "REAL booking row appeared via live tool call", JSON.stringify(booking));
      finish(0);
    } else {
      log(false, "no booking row appeared");
      finish(1);
    }
  }

  function finish(code, note) {
    keepLineOpen = false;
    clearTimeout(timeout);
    console.log("\n--- Summary ---");
    if (note) console.log(note);
    try {
      ws.close();
    } catch {}
    process.exit(code);
  }
}

main().catch((err) => {
  console.error("inline-tools-test failed:", err.message || err);
  process.exit(1);
});
