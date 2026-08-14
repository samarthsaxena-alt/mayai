/* =========================================================================
   Web calling — "Talk to {name} right here," modeled on JustCall's own AIVA
   "Talk to Mia" widget: a floating card, a live scrolling transcript, an
   avatar/name/timer bar, and a hang-up button that lands you on a call
   summary.

   Connects DIRECTLY to PyAI's Omni WebSocket — no relay through our own
   server for the realtime audio path. We first POST /api/webcall/token
   (src/routes/webcall.js), a stateless request that mints a short-lived,
   origin-locked session token; PYAI_API_KEY itself never reaches this file.
   That token-mint endpoint is the only piece that needs a server at all,
   which is why this works on a plain serverless host — nothing here needs a
   long-lived connection held open by our own backend.

   Sends no inline `configure` frame — session_label alone (baked into the
   `url` the token endpoint returns) auto-loads this agent's real greeting/
   persona/KB/tools binding, confirmed by direct testing, same as native
   telephony and the Twilio bridge.

   Wire protocol is PyAI's own tag-framed binary format now (previously our
   server unwrapped/rewrapped this; the browser does it directly):
     - tag 0x01 AUDIO: raw PCM16 mono @ 24kHz, no other framing
     - tag 0x02 TRANSCRIPT: JSON text, {role, text, final}
     - tag 0x03 CONTROL: JSON text, {event: "session_end", ...} etc.
   ========================================================================= */
(function () {
  const SAMPLE_RATE = 24000;
  const TAG = { AUDIO: 0x01, TRANSCRIPT: 0x02, CONTROL: 0x03 };

  /** Linear-interpolation resample — good enough for a live voice demo, not
   * broadcast-quality (no anti-aliasing filter), but cheap and dependency-free. */
  function resample(float32, fromRate, toRate) {
    if (fromRate === toRate) return float32;
    const ratio = fromRate / toRate;
    const outLen = Math.round(float32.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, float32.length - 1);
      const frac = srcPos - i0;
      out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
    }
    return out;
  }

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function pcm16ToFloat32(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    return out;
  }

  function buildWidget(name) {
    const overlay = document.createElement("div");
    overlay.className = "webcall-overlay";
    overlay.innerHTML = `
      <div class="webcall-card">
        <div class="webcall-header">
          <div>
            <div class="webcall-title">Talk to ${name}</div>
            <div class="webcall-subtitle">A real, live call — right here in your browser, no phone needed.</div>
          </div>
          <button type="button" class="webcall-close" aria-label="Close">✕</button>
        </div>
        <div class="webcall-transcript" id="webcall-transcript">
          <div class="webcall-status" id="webcall-status">Asking for microphone access…</div>
        </div>
        <div class="webcall-bar" id="webcall-bar">
          <div class="webcall-avatar">🎙️</div>
          <div class="webcall-bar-info">
            <div class="webcall-bar-name">${name}</div>
            <div class="webcall-bar-timer" id="webcall-timer">00:00</div>
          </div>
          <button type="button" class="webcall-hangup" id="webcall-hangup" aria-label="Hang up">📞</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function buildSummary(overlay, name, lines, durationLabel) {
    const card = overlay.querySelector(".webcall-card");
    card.innerHTML = `
      <div class="webcall-header">
        <div>
          <div class="webcall-title">Call with ${name} ended</div>
          <div class="webcall-subtitle">${durationLabel} — here's what was actually said.</div>
        </div>
        <button type="button" class="webcall-close" aria-label="Close">✕</button>
      </div>
      <div class="webcall-summary">
        <div class="webcall-summary-label">Transcript</div>
        ${
          lines.length
            ? lines.map((l) => `<div class="webcall-line"><b>${l.role}:</b> ${l.text}</div>`).join("")
            : '<div class="muted">No speech was captured this call.</div>'
        }
        <p class="hint" style="margin-top:14px">This call is also being processed the same way a real phone call would be — check the Actions screen in a moment for the logged outcome.</p>
      </div>`;
    card.querySelector(".webcall-close").addEventListener("click", () => overlay.remove());
  }

  window.openWebCallWidget = async function openWebCallWidget(aiName) {
    const name = aiName || "your AI";
    const overlay = buildWidget(name);
    const transcriptEl = overlay.querySelector("#webcall-transcript");
    const statusEl = overlay.querySelector("#webcall-status");
    const timerEl = overlay.querySelector("#webcall-timer");
    const closeBtn = overlay.querySelector(".webcall-close");
    const hangupBtn = overlay.querySelector("#webcall-hangup");

    const lines = [];
    let ws = null;
    let stream = null;
    let audioCtx = null;
    let playbackCtx = null;
    let nextPlayTime = 0;
    let timerHandle = null;
    let startedAt = null;
    let ended = false;

    function appendLine(role, text) {
      lines.push({ role, text });
      const row = document.createElement("div");
      row.className = "webcall-line";
      row.innerHTML = `<b>${role}:</b> ${text}`;
      transcriptEl.appendChild(row);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    function formatDuration(sec) {
      const m = String(Math.floor(sec / 60)).padStart(2, "0");
      const s = String(sec % 60).padStart(2, "0");
      return `${m}:${s}`;
    }

    function endCall(reason) {
      if (ended) return;
      ended = true;
      clearInterval(timerHandle);
      const durSec = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
      try {
        stream?.getTracks().forEach((t) => t.stop());
      } catch {}
      try {
        audioCtx?.close();
      } catch {}
      try {
        playbackCtx?.close();
      } catch {}
      try {
        ws?.close();
      } catch {}
      buildSummary(overlay, name, lines, `Call lasted ${formatDuration(durSec)}`);
    }

    closeBtn.addEventListener("click", () => endCall("closed"));
    hangupBtn.addEventListener("click", () => endCall("hangup"));

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      statusEl.textContent = "Couldn't get microphone access — check your browser's permission prompt and try again.";
      return;
    }

    statusEl.textContent = "Connecting…";
    let session;
    try {
      const res = await fetch("/api/webcall/token", { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "token request failed");
      session = await res.json();
    } catch (err) {
      statusEl.textContent = "Couldn't start the call — try again in a moment.";
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
      return;
    }

    // Connects straight to PyAI, not our own server — the token above is the
    // one-time credential, presented as the WS subprotocol since browsers
    // can't set custom headers on a WebSocket handshake.
    ws = new WebSocket(session.url, [`pyai-key.${session.token}`]);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated in favor of AudioWorklet, but needs
      // no separate module file to load — the simpler option given this is a
      // live demo widget, not a production audio pipeline.
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const resampled = resample(input, audioCtx.sampleRate, SAMPLE_RATE);
        const pcm16 = floatTo16BitPCM(resampled);
        // PyAI's tag-framed protocol: one leading byte, then raw PCM16.
        const framed = new Uint8Array(pcm16.buffer.byteLength + 1);
        framed[0] = TAG.AUDIO;
        framed.set(new Uint8Array(pcm16.buffer), 1);
        ws.send(framed.buffer);
      };
      source.connect(processor);
      // Output left silent (never populated) — connecting to destination is
      // still required in most browsers for onaudioprocess to actually fire.
      processor.connect(audioCtx.destination);

      playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
      nextPlayTime = playbackCtx.currentTime;

      startedAt = Date.now();
      timerHandle = setInterval(() => {
        timerEl.textContent = formatDuration(Math.round((Date.now() - startedAt) / 1000));
      }, 1000);
      statusEl.textContent = `${name} is listening — go ahead and talk.`;
    });

    ws.addEventListener("message", (ev) => {
      // Every message is PyAI's own tag-framed format now: one leading byte,
      // then either raw PCM16 (audio) or JSON text (transcript/control).
      const buf = new Uint8Array(ev.data);
      if (buf.length === 0) return;
      const tag = buf[0];
      const payload = buf.subarray(1);

      if (tag === TAG.AUDIO) {
        if (!playbackCtx) return;
        // subarray() keeps sharing the original buffer, which is exactly
        // sized to include the tag byte — copy out just the audio bytes
        // first so Int16Array's byteOffset/length line up on an even
        // boundary regardless of that leading byte.
        const audioBytes = payload.slice();
        const int16 = new Int16Array(audioBytes.buffer);
        const float32 = pcm16ToFloat32(int16);
        const buffer = playbackCtx.createBuffer(1, float32.length, SAMPLE_RATE);
        buffer.copyToChannel(float32, 0);
        const src = playbackCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(playbackCtx.destination);
        const startAt = Math.max(nextPlayTime, playbackCtx.currentTime);
        src.start(startAt);
        nextPlayTime = startAt + buffer.duration;
        return;
      }

      const text = new TextDecoder().decode(payload);
      let evt;
      try {
        evt = JSON.parse(text);
      } catch {
        return; // interim/partial deltas aren't always JSON
      }

      if (tag === TAG.TRANSCRIPT) {
        if (evt.final && evt.text) appendLine(evt.role === "assistant" ? name : "You", evt.text);
      } else if (tag === TAG.CONTROL) {
        if (evt.event === "session_end") endCall("session_end");
      }
    });

    ws.addEventListener("close", () => endCall("connection closed"));
    ws.addEventListener("error", () => {
      statusEl.textContent = "Connection error — the call couldn't be established.";
    });
  };
})();
