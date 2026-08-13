// Cleanest possible isolation test: declare ONLY the prebuilt `datetime`
// tool inline (no webhook, no auth, no custom code on our side at all —
// PyAI's own hosted implementation), then ask a question only a real tool
// call could answer correctly ("what's today's date?"). If the agent states
// today's actual real date, tool-calling works. If it hedges/guesses/refuses,
// tool-calling isn't firing even for the simplest possible case.
import { getConfig } from "../src/db.js";

const TAG = { AUDIO: 0x01, TRANSCRIPT: 0x02, CONTROL: 0x03 };
const QUESTION = "Quick question — what is today's exact date?";

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
  const url = `${(process.env.PYAI_BASE_URL || "https://api.pyai.com").replace(/^http/, "ws")}/v1/omni?format=pcm16&rate=24000&session_label=${config.agent_id}`;
  const ws = new WebSocket(url, [`pyai-key.${process.env.PYAI_API_KEY}`]);
  ws.binaryType = "arraybuffer";

  let keepLineOpen = true;
  let capturingReply = false;
  const finalTranscripts = [];
  const replyAudioChunks = [];
  const timeout = setTimeout(() => finish(1, "timed out after 35s"), 35000);

  async function streamUtterance(text) {
    console.log(`\n--- Asking: "${text}" ---`);
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

  ws.addEventListener("open", () => {
    log(true, "websocket upgraded — declaring ONLY the prebuilt datetime tool, no webhook needed");
    const configureFrame = new TextEncoder().encode(
      JSON.stringify({
        type: "configure",
        persona: "You are a helpful assistant. When asked about the date or time, use the datetime tool rather than guessing.",
        greeting: "Hi, ask me anything.",
        tools: [
          {
            name: "datetime",
            description: "Current date/time in a timezone.",
            parameters: { type: "object", properties: { timezone: { type: "string", description: "IANA timezone, e.g. America/New_York. Defaults to UTC." } } },
          },
        ],
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
        run();
      } else if (evt.event !== "hello" && evt.event !== "session_started" && evt.type !== "audio_position") {
        console.log("   [control]", JSON.stringify(evt)); // would show tool_call here if the client-loop path fires
      }
    } else if (tag === TAG.TRANSCRIPT) {
      const raw = buf.subarray(1).toString();
      try {
        const evt = JSON.parse(raw);
        console.log("   [transcript]", JSON.stringify(evt));
        if (evt.role === "assistant" && evt.final) finalTranscripts.push(evt.text);
      } catch {
        console.log("   [transcript:partial]", JSON.stringify(raw));
      }
    } else if (tag === TAG.AUDIO && capturingReply) {
      replyAudioChunks.push(Buffer.from(buf.subarray(1)));
    }
  });

  ws.addEventListener("error", (err) => console.error("websocket error", err.message || err));
  ws.addEventListener("close", (ev) => console.log(`   [close] code=${ev.code} reason=${ev.reason}`));

  async function run() {
    await holdLineOpen(4000);
    await streamUtterance(QUESTION);
    capturingReply = true; // start recording whatever the assistant says back
    await holdLineOpen(8000);
    await finish(0);
  }

  // Wrap raw PCM16LE mono @ rate into a minimal WAV container so Hear can
  // transcribe it — the live transcript event has been unreliable for
  // assistant turns all night, so we verify content ourselves instead of
  // trusting it.
  function wavWrap(pcmBuffer, rate) {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([header, pcmBuffer]);
  }

  async function transcribeReply() {
    if (replyAudioChunks.length === 0) return null;
    const pcm = Buffer.concat(replyAudioChunks);
    const wav = wavWrap(pcm, 24000);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "reply.wav");
    form.append("model", "pyai-hear");
    const res = await fetch(`${process.env.PYAI_BASE_URL || "https://api.pyai.com"}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PYAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      console.log("   (transcription of captured reply failed:", res.status, await res.text(), ")");
      return null;
    }
    const data = await res.json();
    return data.text || null;
  }

  async function finish(code, note) {
    keepLineOpen = false;
    clearTimeout(timeout);
    console.log("\n--- Summary ---");
    console.log("Today's real date is 2026-08-13.");
    console.log("Final assistant transcripts (live event):", finalTranscripts.length ? finalTranscripts : "(none captured)");
    console.log(`Captured ${Buffer.concat(replyAudioChunks).length} bytes of reply audio — transcribing it ourselves...`);
    const text = await transcribeReply();
    log(!!text, "what the assistant actually said (via our own Hear pass)", text || "(no audio captured / transcription failed)");
    if (note) console.log(note);
    try {
      ws.close();
    } catch {}
    process.exit(code);
  }
}

main().catch((err) => {
  console.error("prebuilt-tool-test failed:", err.message || err);
  process.exit(1);
});
