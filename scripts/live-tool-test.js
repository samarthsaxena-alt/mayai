// The real test: open a real Omni session against the ACTUAL configured
// agent (tools + KB already bound via /api/config/finish-setup, webhooks
// pointed at a real public URL), stream in a synthesized booking request,
// and check whether PyAI's engine actually calls our live webhook —
// end-to-end, not a unit test of our own handler.
//
// Prereqs: PUBLIC_HOST set to a real reachable tunnel, our own server running
// on that tunnel, and an agent already configured (npm run dev + apply a
// template + finish-setup first).
//
// Run: node --env-file=.env scripts/live-tool-test.js

const TAG = { AUDIO: 0x01, TRANSCRIPT: 0x02, CONTROL: 0x03 };
const CALLER_LINE = "Hi, I'd like to book a table for two this Friday at 7 PM. The name is Sam.";

async function synthesizeCallerAudio(rate) {
  const res = await fetch(`${process.env.PYAI_BASE_URL || "https://api.pyai.com"}/v1/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PYAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: CALLER_LINE, response_format: "pcm", sample_rate: rate }),
  });
  if (!res.ok) throw new Error(`Speak API failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function log(ok, label, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
}

async function main() {
  const configRes = await fetch("http://localhost:" + (process.env.PORT || 8080) + "/api/config");
  const { config } = await configRes.json();
  if (!config.agent_id) throw new Error("No agent configured yet — apply a template and finish-setup first.");
  log(true, "using configured agent", config.agent_id);

  const url = `${(process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/^http/, "ws")}/v1/omni?format=pcm16&rate=24000&session_label=${config.agent_id}`;
  const ws = new WebSocket(url, [`pyai-key.${process.env.PYAI_API_KEY}`]);
  ws.binaryType = "arraybuffer";

  const seen = { configured: false, caller_audio_sent: false };
  let keepLineOpen = true;
  const timeout = setTimeout(() => finish(1, "timed out after 45s"), 45000);

  async function sendCallerAudio() {
    if (seen.caller_audio_sent) return;
    seen.caller_audio_sent = true;
    console.log(`\n--- streaming caller line: "${CALLER_LINE}" ---`);
    const pcm = await synthesizeCallerAudio(24000);
    const chunkSize = 24000 * 2 * 0.02;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let off = 0; off < pcm.length; off += chunkSize) {
      const frame = new Uint8Array(chunkSize + 1);
      frame[0] = TAG.AUDIO;
      frame.set(pcm.subarray(off, off + chunkSize), 1);
      ws.send(frame);
      await sleep(20);
    }
    log(true, "caller audio streamed, holding line open with silence");
    const silence = new Uint8Array(chunkSize).fill(0);
    while (keepLineOpen) {
      const frame = new Uint8Array(silence.length + 1);
      frame[0] = TAG.AUDIO;
      frame.set(silence, 1);
      ws.send(frame);
      await sleep(20);
    }
  }

  ws.addEventListener("open", () => {
    log(true, "websocket upgraded — NOT sending persona/greeting inline, using the agent's stored config");
    const frame = new TextEncoder().encode(JSON.stringify({ type: "configure" }));
    const buf = new Uint8Array(frame.length + 1);
    buf[0] = TAG.CONTROL;
    buf.set(frame, 1);
    ws.send(buf);
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
        seen.configured = true;
        log(true, "configured", JSON.stringify(evt));
        setTimeout(sendCallerAudio, 6500);
      } else if (evt.event !== "hello" && evt.event !== "session_started" && !evt.type) {
        console.log("   [control]", JSON.stringify(evt));
      }
    } else if (tag === TAG.TRANSCRIPT) {
      const raw = buf.subarray(1).toString();
      try {
        const evt = JSON.parse(raw);
        console.log("   [transcript]", JSON.stringify(evt));
      } catch {
        console.log("   [transcript:partial]", JSON.stringify(raw));
      }
    }
  });

  ws.addEventListener("error", (err) => console.error("websocket error", err.message || err));

  async function pollForBooking() {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch("http://localhost:" + (process.env.PORT || 8080) + "/api/actions/bookings");
        const { bookings } = await res.json();
        if (bookings.length > 0) return bookings[0];
      } catch {}
    }
    return null;
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

  // Poll our own DB in parallel — this is the actual thing we're testing for:
  // did PyAI's engine really call our webhook and write a real row.
  pollForBooking().then((booking) => {
    if (booking) {
      log(true, "REAL booking row appeared via live tool call", JSON.stringify(booking));
      finish(0);
    } else {
      log(false, "no booking row appeared after 20s of polling");
      finish(1);
    }
  });
}

main().catch((err) => {
  console.error("live-tool-test failed:", err.message || err);
  process.exit(1);
});
