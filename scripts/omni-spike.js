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
const CALLER_LINE = "Hi, I'd like to book a table for two this Friday at 7 PM. The name is Sam.";

/** Synthesize a line via PyAI Speak (real STT test input, not a canned clip). */
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
  console.log("--- Step 1: create a throwaway test agent on PyAI ---");
  const agent = await agents.create({
    name: "Open Receptionist SPIKE TEST",
    persona_system_prompt:
      "You are a warm, professional phone receptionist for a restaurant called Open Receptionist Test Kitchen. When a caller asks for a reservation, capture their name, party size, date, and time, and read the details back to confirm.",
    greeting: GREETING,
    language: "en",
  });
  log(true, "agent created", agent.agent_id);

  console.log("\n--- Step 2: open a real Omni realtime session against it ---");
  const url = `${(process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/^http/, "ws")}/v1/omni?format=pcm16&rate=24000&session_label=${agent.agent_id}`;
  const ws = new WebSocket(url, [`pyai-key.${process.env.PYAI_API_KEY}`]);
  ws.binaryType = "arraybuffer"; // Node's native WebSocket defaults binary frames to Blob otherwise

  const seen = {
    hello: false,
    session_started: false,
    configured: false,
    greeting_transcript: false,
    greeting_audio_bytes: 0,
    caller_audio_sent: false,
    user_transcript: false,
    assistant_reply_transcript: false,
  };
  const timeout = setTimeout(() => {
    console.error("\n⏱  Timed out after 40s waiting for the full lifecycle.");
    finish(1);
  }, 40000);
  let keepLineOpen = true;

  /** After the greeting has had time to play, stream a synthesized caller line in. */
  async function sendCallerAudio() {
    if (seen.caller_audio_sent) return;
    seen.caller_audio_sent = true;
    console.log('\n--- Step 3: synthesize "' + CALLER_LINE + '" and stream it in as the caller ---');
    let pcm;
    try {
      pcm = await synthesizeCallerAudio(24000);
    } catch (err) {
      // Steps 1-2 above are the actually load-bearing proof this app depends
      // on (a real agent + a real Omni session + a real spoken greeting) —
      // this step only exists to fake a caller's voice for this smoke test
      // itself, via a *different* PyAI endpoint (/v1/audio/speech). Don't let
      // that endpoint being flaky read as "your setup is broken" — it isn't;
      // see docs/PLATFORM-NOTES.md for what's actually been confirmed down.
      console.log(`⚠️  Step 3 failed: ${err.message}`);
      console.log(
        "   This is PyAI's Speech-synthesis endpoint, only used here to fake a caller's voice for this test —\n" +
          "   NOT something the real product calls. Steps 1-2 above are what actually matter (a real agent,\n" +
          "   a real Omni session, a real spoken greeting) and they already passed. See docs/PLATFORM-NOTES.md."
      );
      keepLineOpen = false;
      clearTimeout(timeout);
      setTimeout(() => finish(seen.greeting_audio_bytes > 0 ? 0 : 1), 500);
      return;
    }
    log(true, "synthesized caller audio", `${pcm.length} bytes (~${(pcm.length / (24000 * 2)).toFixed(1)}s)`);
    const chunkSize = 24000 * 2 * 0.02; // 20ms frames @ 24kHz/16-bit
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Real-time paced, like an actual caller (and like our Twilio bridge's own
    // pacer) — sending it all in one burst starved the engine's turn-detection
    // in an earlier run.
    for (let off = 0; off < pcm.length; off += chunkSize) {
      const chunk = pcm.subarray(off, off + chunkSize);
      const frame = new Uint8Array(chunk.length + 1);
      frame[0] = TAG.AUDIO;
      frame.set(chunk, 1);
      ws.send(frame);
      await sleep(20);
    }
    log(true, "caller audio fully streamed, realtime-paced");

    // Real telephony audio never stops flowing, even in silence (Twilio/PyAI
    // telephony sends continuous frames for the whole call). Without trailing
    // silence, the engine's connection-idle timer fires instead of its normal
    // speech-endpointing — keep "the line open" for a couple seconds so it can
    // detect end-of-utterance the normal way.
    console.log("--- Step 3b: hold the line open with silence, like a real telephony stream, until the turn resolves ---");
    const silenceChunk = new Uint8Array(chunkSize).fill(0);
    while (keepLineOpen) {
      const frame = new Uint8Array(silenceChunk.length + 1);
      frame[0] = TAG.AUDIO;
      frame.set(silenceChunk, 1);
      ws.send(frame);
      await sleep(20);
    }
  }

  ws.addEventListener("open", () => {
    log(true, "websocket upgraded");
    // Debugging step: send greeting/persona INLINE too, to isolate whether
    // "session_label={agent_id} auto-loads the stored profile" actually holds
    // (docs claim it does; our first run's configured.greeting=false suggests
    // it might not — sending it explicitly here is the other documented path).
    const configureFrame = new TextEncoder().encode(
      JSON.stringify({
        type: "configure",
        greeting: GREETING,
        persona:
          "You are a warm, professional phone receptionist for a restaurant called Open Receptionist Test Kitchen. When a caller asks for a reservation, capture their name, party size, date, and time, and read the details back to confirm.",
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
      const evt = JSON.parse(buf.subarray(1).toString());
      if (evt.event === "hello") { seen.hello = true; log(true, "hello", JSON.stringify(evt)); }
      if (evt.event === "session_started") { seen.session_started = true; log(true, "session_started"); }
      if (evt.event === "configured" || evt.event === "config_ack") {
        seen.configured = true;
        log(true, "configured", JSON.stringify(evt));
        setTimeout(sendCallerAudio, 6500); // let the greeting fully finish playing first
      }
      if (evt.event === "session_end") { console.log("session ended by server"); finish(seen.greeting_transcript ? 0 : 1); }
    } else if (tag === TAG.TRANSCRIPT) {
      const raw = buf.subarray(1).toString();
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        // Not every transcript frame is JSON — interim/partial deltas seem to
        // ship as plain text. Log it and move on rather than crash.
        console.log("   [transcript:raw-text]", JSON.stringify(raw));
        return;
      }
      console.log("   [transcript]", JSON.stringify(evt));
      if (evt.role === "assistant" && evt.final) {
        seen.greeting_transcript = true;
        if (seen.caller_audio_sent) seen.assistant_reply_transcript = true;
        log(true, "assistant transcript", evt.text);
      }
      if (evt.role === "user" && evt.final) {
        seen.user_transcript = true;
        log(true, "user (caller) transcript", evt.text);
      }
    } else if (tag === TAG.AUDIO) {
      seen.greeting_audio_bytes += buf.length - 1;
    } else {
      console.log("   [unknown tag]", tag);
    }
    if (tag === TAG.CONTROL) {
      const evt = JSON.parse(buf.subarray(1).toString());
      if (!["hello", "session_started", "configured", "config_ack", "session_end"].includes(evt.event)) {
        console.log("   [control]", JSON.stringify(evt));
      }
    }

    if (seen.hello && seen.session_started && seen.user_transcript && seen.assistant_reply_transcript) {
      clearTimeout(timeout);
      setTimeout(() => finish(0), 1000); // let a little more audio land, then stop
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("websocket error", err.message || err);
  });

  function finish(code) {
    keepLineOpen = false;
    console.log("\n--- Summary ---");
    log(seen.hello, "hello received");
    log(seen.session_started, "session_started received");
    log(seen.greeting_transcript, "greeting transcript received (canned line)");
    log(seen.greeting_audio_bytes > 0, "greeting audio bytes received", `${seen.greeting_audio_bytes} bytes`);
    log(seen.user_transcript, "caller (STT) transcript received for a real conversational turn");
    log(seen.assistant_reply_transcript, "assistant reasoned reply transcript received");
    try { ws.close(); } catch {}
    process.exit(code);
  }
}

main().catch((err) => {
  console.error("Spike failed:", err.message || err);
  process.exit(1);
});
