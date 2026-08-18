const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const headerStatus = document.getElementById("header-status");

// When this page is reached via the marketing site's "?business_key=..."
// redirect, every API call needs to operate on THAT business's own
// persistent row (src/db.js: businesses table) instead of this builder's
// original singleton config - otherwise the page silently falls back to the
// singleton and shows whatever step/data IT happens to be in (the original
// bug: landing here always showed the singleton's stale wizard step,
// completely ignoring the business_key in the URL). Threaded centrally here
// in the one shared api() helper rather than at every call site - routes
// that don't yet accept business_key (Customize/Actions/Analytics tabs)
// just ignore the extra field/param, which is the correct fallback.
const BUSINESS_KEY = new URLSearchParams(location.search).get("business_key");

function toast(msg, type = "ok") {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
  toastEl.style.display = "block";
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.style.display = "none"), 3500);
}

async function api(path, opts = {}) {
  let finalPath = path;
  let finalBody = opts.body;
  if (BUSINESS_KEY) {
    if (finalBody && !(finalBody instanceof FormData) && typeof finalBody === "object") {
      finalBody = { ...finalBody, business_key: BUSINESS_KEY };
    } else if (!finalBody || finalBody instanceof FormData) {
      const sep = finalPath.includes("?") ? "&" : "?";
      finalPath = `${finalPath}${sep}business_key=${encodeURIComponent(BUSINESS_KEY)}`;
    }
  }
  const res = await fetch(finalPath, {
    ...opts,
    headers: finalBody && !(finalBody instanceof FormData) ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
    body: finalBody && !(finalBody instanceof FormData) ? JSON.stringify(finalBody) : finalBody,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function refreshHeader() {
  try {
    const { config } = await api("/api/config");
    const name = config.ai_name || "Your AI";
    headerStatus.textContent = config.phone_number
      ? `${name} is on the clock — ${config.phone_number}`
      : config.agent_id
      ? `${name} is hired — no phone number yet`
      : "Not hired yet";
  } catch {
    headerStatus.textContent = "";
  }
}

/* =========================================================================
   QUICK START — the zero-friction path. Three screens, one at a time, each
   with a single obvious next action. This is the front door; Customize (the
   original 6-tab builder) is for people who already have a working agent
   and want to tweak it.
   ========================================================================= */

// The "meet your AI" hiring frame: Quick Start isn't "configure a bot," it's
// "hire and onboard someone" — meet the candidate, show them around on their
// first day, then watch their first shift. Same 3 screens/APIs underneath;
// only the words change, but the words are the point.
const SUGGESTED_AI_NAMES = ["Sam", "Alex", "Jamie", "Riley", "Morgan", "Casey"];

function wizardShell(stepIndex, bodyHtml) {
  const steps = ["Meet your AI", "Their first day", "First shift"];
  app.innerHTML = "";
  app.appendChild(
    el(`<div>
      <div class="wizard-steps">
        ${steps.map((s, i) => `<div class="ws ${i === stepIndex ? "active" : i < stepIndex ? "done" : ""}">${i + 1}. ${s}</div>`).join("")}
      </div>
      <div class="card">${bodyHtml}</div>
    </div>`)
  );
}

async function renderQuickStart() {
  const { config } = await api("/api/config");
  const step = config.setup_step === "live" ? 2 : config.setup_step === "knowledge" ? 1 : 0;
  if (step === 0) return renderWizardStep1(config);
  if (step === 1) return renderWizardStep2(config);
  return renderWizardStep3(config);
}

async function renderWizardStep1(config) {
  const { templates } = await api("/api/templates");
  const byIndustry = {};
  templates.forEach((t) => (byIndustry[t.industryLabel] = byIndustry[t.industryLabel] || []).push(t));

  wizardShell(
    0,
    `<div class="big-question">Meet your new hire</div>
     <p class="hint">You're not configuring software — you're bringing someone on. Give them a name, tell us where they're working, and what the job is.</p>
     <label>Their name</label>
     <input type="text" id="qs-ai-name" placeholder="e.g. Sam" value="${config.ai_name || ""}" />
     <div class="name-chip-row" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
       ${SUGGESTED_AI_NAMES.map((n) => `<button type="button" class="name-chip" data-name="${n}">${n}</button>`).join("")}
     </div>
     <label style="margin-top:18px">Where are they working?</label>
     <input type="text" id="qs-business-name" placeholder="e.g. Piazza Verde" value="${config.business_name && config.business_name !== "My Business" ? config.business_name : ""}" />
     <div style="margin-top:18px">
       <label style="margin-bottom:8px">What's the job?</label>
       ${Object.entries(byIndustry)
         .map(
           ([industryLabel, tpls]) => `
         <div style="margin-bottom:14px">
           <label style="margin-bottom:8px;font-weight:normal" class="hint">${industryLabel}</label>
           <div class="template-grid">
             ${tpls.map((t) => `<div class="template-card" data-key="${t.key}"><strong>${t.label}</strong></div>`).join("")}
           </div>
         </div>`
         )
         .join("")}
     </div>`
  );

  let selectedKey = null;
  app.querySelectorAll(".template-card").forEach((c) =>
    c.addEventListener("click", () => {
      app.querySelectorAll(".template-card").forEach((x) => x.classList.remove("selected"));
      c.classList.add("selected");
      selectedKey = c.dataset.key;
      maybeContinue();
    })
  );
  const nameInput = document.getElementById("qs-business-name");
  const aiNameInput = document.getElementById("qs-ai-name");
  nameInput.addEventListener("input", maybeContinue);
  aiNameInput.addEventListener("input", maybeContinue);
  app.querySelectorAll(".name-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      aiNameInput.value = chip.dataset.name;
      maybeContinue();
    })
  );

  function maybeContinue() {
    const existing = document.getElementById("qs-continue");
    if (existing) existing.remove();
    if (!selectedKey || !nameInput.value.trim() || !aiNameInput.value.trim()) return;
    const btn = el(`<button class="primary" id="qs-continue" style="margin-top:18px">Hire ${aiNameInput.value.trim()} →</button>`);
    app.querySelector(".card").appendChild(btn);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Onboarding…";
      try {
        await api("/api/config/template", {
          method: "POST",
          body: { template_key: selectedKey, business_name: nameInput.value.trim(), ai_name: aiNameInput.value.trim() },
        });
        renderQuickStart();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.textContent = `Hire ${aiNameInput.value.trim()} →`;
      }
    });
  }
}

async function renderWizardStep2(config) {
  const { documents, knowledge_label } = await api("/api/knowledge");
  const name = config.ai_name || "Your new hire";
  wizardShell(
    1,
    `<div class="big-question">${name}'s first day</div>
     <p class="hint">Show ${config.ai_name || "them"} around like you would any new employee: hand over the ${(knowledge_label || "menu / info sheet").toLowerCase()}. ${config.ai_name || "They"} will only ever speak from what you give here — never guesses, and says so instead when something's not in it. No website needed.</p>
     <div class="knowledge-source-tabs">
       <button data-src="upload" class="active">Upload a file</button>
       <button data-src="url">Paste a link</button>
       <button data-src="text">Just type it in</button>
     </div>
     <div id="qs-source-body"></div>
     <div id="qs-doc-list" style="margin-top:16px"></div>
     <div style="margin-top:18px;display:flex;gap:14px;align-items:center">
       <button class="primary" id="qs-continue-2">Continue →</button>
       <button class="skip-link" id="qs-skip-2">Skip for now — I'll add this later</button>
     </div>`
  );
  renderKnowledgeSourceBody("upload");
  renderQsDocList(documents);

  app.querySelectorAll(".knowledge-source-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      app.querySelectorAll(".knowledge-source-tabs button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      renderKnowledgeSourceBody(b.dataset.src);
    })
  );
  document.getElementById("qs-continue-2").addEventListener("click", () => renderWizardStep3ViaFinish());
  document.getElementById("qs-skip-2").addEventListener("click", () => renderWizardStep3ViaFinish());
}

function renderQsDocList(documents) {
  const box = document.getElementById("qs-doc-list");
  if (!box) return;
  box.innerHTML = documents.length
    ? documents.map((d) => `<div class="doc-row"><div>${d.filename}</div><span class="pill ${d.status}">${d.status}</span></div>`).join("")
    : "";
}

function renderKnowledgeSourceBody(src) {
  const box = document.getElementById("qs-source-body");
  if (src === "upload") {
    box.innerHTML = `<input type="file" id="qs-pdf-input" accept="application/pdf" /> <button class="primary" id="qs-upload-btn" style="margin-left:8px">Upload</button>`;
    document.getElementById("qs-upload-btn").addEventListener("click", async () => {
      const input = document.getElementById("qs-pdf-input");
      if (!input.files[0]) return toast("Choose a file first.", "error");
      const form = new FormData();
      form.append("file", input.files[0]);
      try {
        toast("Uploading…");
        await api("/api/knowledge/upload", { method: "POST", body: form });
        toast("Uploaded — indexing now.");
        const { documents } = await api("/api/knowledge");
        renderQsDocList(documents);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  } else if (src === "url") {
    box.innerHTML = `<input type="text" id="qs-url-input" placeholder="https://www.google.com/maps/place/... or your Facebook Page" /> <button class="primary" id="qs-url-btn" style="margin-left:8px">Add</button>`;
    document.getElementById("qs-url-btn").addEventListener("click", async () => {
      const url = document.getElementById("qs-url-input").value.trim();
      if (!url) return toast("Paste a link first.", "error");
      try {
        await api("/api/knowledge/url", { method: "POST", body: { url } });
        toast("Added — indexing now.");
        const { documents } = await api("/api/knowledge");
        renderQsDocList(documents);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  } else {
    box.innerHTML = `<textarea id="qs-text-input" placeholder="e.g. We offer: haircuts $45, color $120... Open Tue-Sun 9am-6pm. We use ammonia-free color..." style="min-height:120px"></textarea>
      <button class="primary" id="qs-text-btn" style="margin-top:8px">Add</button>`;
    document.getElementById("qs-text-btn").addEventListener("click", async () => {
      const text = document.getElementById("qs-text-input").value.trim();
      if (!text) return toast("Type something first.", "error");
      try {
        await api("/api/knowledge/text", { method: "POST", body: { text } });
        toast("Added — indexing now.");
        const { documents } = await api("/api/knowledge");
        renderQsDocList(documents);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
}

async function renderWizardStep3ViaFinish() {
  wizardShell(2, `<div class="big-question">Getting ready…</div><p class="hint">Onboarding is finishing up.</p>`);
  try {
    await api("/api/config/finish-setup", { method: "POST" });
  } catch (err) {
    toast(err.message, "error");
  }
  renderQuickStart();
}

async function renderWizardStep3(config) {
  const name = config.ai_name || "Your new hire";
  wizardShell(
    2,
    `<div class="big-question">${name} is ready for their first shift</div>
     <p class="hint">${name} is real and on the clock. Last step is a phone number so people can actually call in — that's the only part with a real cost, so nothing happens here without you clicking it. Once it's live, call in yourself and listen to their first shift.</p>
     <div id="qs-numbers"></div>
     <div style="margin-top:18px"><a href="#" id="qs-customize-link">Want to fine-tune how ${name} talks? Go to Customize →</a></div>`
  );
  await renderPhoneNumberBlock(document.getElementById("qs-numbers"));
  document.getElementById("qs-customize-link").addEventListener("click", (e) => {
    e.preventDefault();
    switchMode("customize");
  });
}

/* =========================================================================
   Dialpad — modeled directly on JustCall's own softphone dialer (the actual
   product this whole thing sits alongside): a rounded card, a live digit
   display, a standard 3-wide T9 keypad with sub-letters, and a circular call
   button — just recolored into MayAI's warm terracotta/cream brand instead of
   JustCall's blue/green. Deliberately plain HTML buttons in a CSS grid, not
   an illustration or custom geometry — that's what actually stayed reliable
   across the earlier attempts at this widget.
   ========================================================================= */
const DIALPAD_KEYS = [
  { d: "1", l: "" },
  { d: "2", l: "ABC" },
  { d: "3", l: "DEF" },
  { d: "4", l: "GHI" },
  { d: "5", l: "JKL" },
  { d: "6", l: "MNO" },
  { d: "7", l: "PQRS" },
  { d: "8", l: "TUV" },
  { d: "9", l: "WXYZ" },
  { d: "*", l: "" },
  { d: "0", l: "+" },
  { d: "#", l: "" },
];

// Strips everything but digits — nothing else. Deliberately NOT stripping a
// leading "1": an earlier version special-cased "drop a US country code,"
// which quietly broke the moment the assigned number wasn't a US number (a
// UK number's leading 44 isn't a thing to drop the same way, and country-
// specific exceptions like that don't belong in a helper meant to work for
// whatever country PyAI actually provisioned). The target to match is always the
// FULL number exactly as PyAI gave it to us, country code included — so
// typing/pasting it back in any formatted form ("+1 (779) 278-8816", "779
// 278 8816" without the code, etc.) is compared against that same full
// digit string, with no country assumptions baked in on either side.
function normalizePhoneDigits(raw) {
  return (raw || "").replace(/\D/g, "");
}

function buildRotaryDialWidget(phoneNumber, aiName) {
  const digits = normalizePhoneDigits(phoneNumber).split("");
  const name = aiName || "your AI";

  const wrap = el(`<div class="dialpad-card">
    <input type="text" class="dialpad-display" id="dialpad-display" placeholder="Enter number"
           inputmode="tel" autocomplete="off" />
    <div class="dialpad-header">Dial ${name}'s line to hear their first shift</div>
    <div class="dialpad-grid">
      ${DIALPAD_KEYS.map(
        (k) =>
          `<button type="button" class="dialpad-key" data-key="${k.d}" ${k.d === "*" || k.d === "#" ? "disabled" : ""}>
        <span class="dialpad-digit">${k.d}</span><span class="dialpad-letters">${k.l}</span>
      </button>`
      ).join("")}
    </div>
    <div class="dialpad-actions">
      <button type="button" class="dialpad-backspace" id="dialpad-backspace" aria-label="Backspace">⌫</button>
      <button type="button" class="dialpad-call" id="dialpad-call" aria-label="Call">📞</button>
    </div>
    <div class="dialpad-hint" id="dialpad-hint">Type on your keyboard or tap the keys below to dial ${name}'s real number</div>
  </div>`);

  // The display is a REAL <input> — not just a styled div — specifically so
  // clicking into it and typing on a keyboard works, same as any normal text
  // field. The dialpad buttons below are a second way to enter the same
  // value, not the only way; typed digits sync in both directions off
  // display.value as the single source of truth (no separate array to drift
  // out of sync with what's actually in the field).
  const display = wrap.querySelector("#dialpad-display");
  const call = wrap.querySelector("#dialpad-call");
  const hint = wrap.querySelector("#dialpad-hint");

  function render() {
    const typed = display.value;
    const matches = typed.length === digits.length && typed === digits.join("");
    call.classList.toggle("ready", matches);
    hint.textContent = matches
      ? `📞 That's it — tap call to talk to ${name}`
      : `Type on your keyboard or tap the keys below to dial ${name}'s real number`;
  }
  render();

  // Keyboard typing (or paste) directly into the field — strip anything that
  // isn't a digit and clamp to the target length as the user types.
  display.addEventListener("input", () => {
    display.value = normalizePhoneDigits(display.value).slice(0, digits.length);
    render();
  });

  wrap.querySelectorAll(".dialpad-key:not([disabled])").forEach((key) =>
    key.addEventListener("click", () => {
      if (display.value.length >= digits.length) return;
      display.value += key.dataset.key;
      display.focus();
      render();
    })
  );

  wrap.querySelector("#dialpad-backspace").addEventListener("click", () => {
    display.value = display.value.slice(0, -1);
    display.focus();
    render();
  });

  // One call mechanism, not a tel: link that hands off to FaceTime/Phone —
  // dialing the real number correctly here starts the same real PyAI web
  // call as the standalone "Talk to X" trigger used to, just gated behind
  // actually typing the number first (the little "prove you know it" beat).
  call.addEventListener("click", () => {
    if (!call.classList.contains("ready")) return;
    window.openWebCallWidget(name);
  });

  return wrap;
}

/* =========================================================================
   Shared: phone number block (used in both Quick Start step 3 and Advanced)
   ========================================================================= */
async function renderPhoneNumberBlock(container) {
  const { config } = await api("/api/config");
  container.innerHTML = "";
  const name = config.ai_name || "your AI";
  // One call mechanism, not two: the dialpad's own call button IS the web
  // call now (see buildRotaryDialWidget) — it used to be a tel: link, which
  // handed off to FaceTime/Phone instead of actually calling PyAI, and
  // having a second standalone "Talk to X" button alongside it was
  // confusing duplication of the same action. Before a real number exists
  // there's nothing to dial yet, so that's the only case the standalone
  // button still earns its place.
  if (config.phone_number) {
    container.appendChild(buildRotaryDialWidget(config.phone_number, config.ai_name));
  } else if (config.agent_id) {
    const webcallBox = el(`<div class="webcall-trigger-box">
      <button class="primary" id="webcall-trigger-btn">🎙️ Talk to ${name} right here</button>
      <p class="hint" style="margin-top:8px">A real, live call in your browser — no phone number needed yet.</p>
    </div>`);
    container.appendChild(webcallBox);
    document.getElementById("webcall-trigger-btn").addEventListener("click", () => window.openWebCallWidget(config.ai_name));
  }
  // Business-key mode (reached via the marketing site) shares ONE real
  // phone number across every business - there's no number to "list and
  // pick", just "put me on it" (go-live rebinds the already-owned number to
  // THIS business's agent, same endpoint the marketing site itself calls).
  // /api/telephony/assign doesn't accept business_key and would silently
  // rebind the SINGLETON's agent instead of this business's - using go-live
  // here is what actually keeps this correct, not just simpler.
  if (BUSINESS_KEY) {
    const goLiveBox = el(`<div>
      <p class="muted">Current: ${config.phone_number || "not yet on the shared number"}</p>
      <button class="primary" id="go-live-btn">Put me on the phone</button>
    </div>`);
    container.appendChild(goLiveBox);
    document.getElementById("go-live-btn").addEventListener("click", async () => {
      try {
        const result = await api("/api/telephony/go-live", { method: "POST", body: {} });
        toast(`Live: ${result.phone_number}`);
        refreshHeader();
        renderPhoneNumberBlock(container);
      } catch (err) {
        toast(err.message, "error");
      }
    });
    return;
  }

  const adminBox = el(`<div>
    <p class="muted">Current: ${config.phone_number || "none yet"}</p>
    <button class="secondary" id="pn-list-btn">List my PyAI numbers</button>
    <div id="pn-list" style="margin-top:10px"></div>
  </div>`);
  container.appendChild(adminBox);
  document.getElementById("pn-list-btn").addEventListener("click", async () => {
    const box = document.getElementById("pn-list");
    try {
      const { data } = await api("/api/telephony/numbers");
      box.innerHTML =
        (data || [])
          .map(
            (n) => `<div class="doc-row"><div>${n.phone_number}</div>
            <button class="secondary assign-btn" data-id="${n.id}" data-number="${n.phone_number}">Assign to this agent</button></div>`
          )
          .join("") || '<p class="muted">No numbers on this account yet — buy one at console.pyai.com, or a live key + POST /api/telephony/provision.</p>';
      box.querySelectorAll(".assign-btn").forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!confirm(`Assign ${btn.dataset.number} to this agent? Calls will start ringing into it.`)) return;
          try {
            await api("/api/telephony/assign", { method: "POST", body: { number_id: btn.dataset.id, phone_number: btn.dataset.number } });
            toast("Assigned.");
            refreshHeader();
            renderPhoneNumberBlock(container);
          } catch (err) {
            toast(err.message, "error");
          }
        })
      );
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  });
}

/* =========================================================================
   CUSTOMIZE — the full 6-tab builder, generalized across industries.
   ========================================================================= */

async function renderTemplates() {
  const { templates } = await api("/api/templates");
  const { config } = await api("/api/config");
  app.innerHTML = "";
  const byIndustry = {};
  templates.forEach((t) => (byIndustry[t.industryLabel] = byIndustry[t.industryLabel] || []).push(t));
  app.appendChild(
    el(`<div class="card">
      <h2>Pick a starting point</h2>
      <p class="hint">Loads a real default persona + call-flow policy below. Everything stays editable afterward.</p>
      ${Object.entries(byIndustry)
        .map(
          ([industryLabel, tpls]) => `
        <div style="margin-bottom:16px">
          <label style="margin-bottom:8px">${industryLabel}</label>
          <div class="template-grid">
            ${tpls
              .map(
                (t) => `<div class="template-card ${t.key === config.template_key ? "selected" : ""}" data-key="${t.key}"><strong>${t.label}</strong></div>`
              )
              .join("")}
          </div>
        </div>`
        )
        .join("")}
    </div>`)
  );
  app.querySelectorAll(".template-card").forEach((cardEl) =>
    cardEl.addEventListener("click", async () => {
      try {
        await api("/api/config/template", { method: "POST", body: { template_key: cardEl.dataset.key } });
        toast(`Applied "${cardEl.querySelector("strong").textContent}" — persona and call flow updated on the live agent.`);
        renderTemplates();
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
}

async function renderBehavior() {
  const { config } = await api("/api/config");
  app.innerHTML = "";
  app.appendChild(
    el(`<div class="card">
      <h2>Behavior</h2>
      <p class="hint">These fields ARE the system prompt sent to the live agent. Save to push the change to the next call.</p>
      <label>Their name</label>
      <p class="hint" style="margin-top:-2px">What the AI calls itself on calls — "Hi, this is ${config.ai_name || "Sam"}!" instead of a generic IVR greeting.</p>
      <input type="text" id="ai_name" value="${config.ai_name || ""}" />
      <label>Business name</label>
      <input type="text" id="business_name" value="${config.business_name || ""}" />
      <label>Greeting variants</label>
      <p class="hint" style="margin-top:-2px">A real receptionist doesn't say the exact same line every call. Add a few — PyAI rotates between them per call. The first one also serves as the fallback.</p>
      <div id="greeting-variants"></div>
      <button class="secondary" id="add-greeting" style="margin-top:6px">+ Add another opening line</button>
      <label>Role</label>
      <textarea id="behavior_role">${config.behavior_role || ""}</textarea>
      <label>Personality</label>
      <textarea id="behavior_personality">${config.behavior_personality || ""}</textarea>
      <label>Conversation style</label>
      <textarea id="behavior_style">${config.behavior_style || ""}</textarea>
      <div style="margin-top:14px"><button class="primary" id="save-behavior">Save</button></div>
    </div>`)
  );

  const variantsBox = document.getElementById("greeting-variants");
  let variants = [];
  try {
    variants = config.greeting_variants ? JSON.parse(config.greeting_variants) : config.greeting ? [config.greeting] : [""];
  } catch {
    variants = config.greeting ? [config.greeting] : [""];
  }
  function renderVariantRows() {
    variantsBox.innerHTML = "";
    variants.forEach((v, i) => {
      const row = el(`<div style="display:flex;gap:6px;margin-bottom:6px">
        <input type="text" class="greeting-variant" value="${(v || "").replace(/"/g, "&quot;")}" style="flex:1" />
        ${variants.length > 1 ? `<button class="secondary remove-variant" data-i="${i}">✕</button>` : ""}
      </div>`);
      row.querySelector(".remove-variant")?.addEventListener("click", () => {
        variants.splice(i, 1);
        renderVariantRows();
      });
      variantsBox.appendChild(row);
    });
  }
  renderVariantRows();
  document.getElementById("add-greeting").addEventListener("click", () => {
    if (variants.length >= 15) return toast("PyAI supports up to 15 greeting variants.", "error");
    variants.push("");
    renderVariantRows();
  });

  document.getElementById("save-behavior").addEventListener("click", async () => {
    const finalVariants = Array.from(variantsBox.querySelectorAll(".greeting-variant"))
      .map((i) => i.value.trim())
      .filter(Boolean);
    try {
      await api("/api/config/behavior", {
        method: "POST",
        body: {
          business_name: document.getElementById("business_name").value,
          ai_name: document.getElementById("ai_name").value,
          greeting: finalVariants[0] || "",
          greeting_variants: finalVariants,
          behavior_role: document.getElementById("behavior_role").value,
          behavior_personality: document.getElementById("behavior_personality").value,
          behavior_style: document.getElementById("behavior_style").value,
        },
      });
      toast("Saved — pushed to the live agent.");
      refreshHeader();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function renderKnowledge() {
  const { documents, knowledge_label } = await api("/api/knowledge");
  app.innerHTML = "";
  const card = el(`<div class="card">
    <h2>Knowledge</h2>
    <p class="hint">${knowledge_label || "Info sheet"} — actually parsed and indexed by PyAI, and grounds every answer. Nothing uploaded yet = the agent says it doesn't have that info.</p>
    <div class="knowledge-source-tabs">
      <button data-src="upload" class="active">Upload a file</button>
      <button data-src="url">Paste a link</button>
      <button data-src="text">Just type it in</button>
    </div>
    <div id="kb-source-body"></div>
    <div id="doc-list" style="margin-top:16px"></div>
  </div>`);
  app.appendChild(card);

  function renderList() {
    const list = card.querySelector("#doc-list");
    list.innerHTML = documents.length ? "" : `<p class="muted">No documents added yet.</p>`;
    documents.forEach((d) => {
      const row = el(`<div class="doc-row">
        <div>${d.filename} <span class="pill ${d.status}">${d.status}</span>
          ${d.fail_reason ? `<div class="muted">${d.fail_reason}</div>` : ""}
        </div>
        ${d.can_retry ? `<button class="secondary retry-btn" data-id="${d.id}">Retry (${d.retry_count}/2 used)</button>` : ""}
      </div>`);
      list.appendChild(row);
    });
    list.querySelectorAll(".retry-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/knowledge/${btn.dataset.id}/retry`, { method: "POST" });
          toast("Retry queued.");
          renderKnowledge();
        } catch (err) {
          toast(err.message, "error");
        }
      })
    );
  }
  renderList();

  function renderSourceBody(src) {
    const box = card.querySelector("#kb-source-body");
    if (src === "upload") {
      box.innerHTML = `<input type="file" id="pdf-input" accept="application/pdf" /> <button class="primary" id="upload-btn" style="margin-left:8px">Upload</button>`;
      box.querySelector("#upload-btn").addEventListener("click", async () => {
        const input = box.querySelector("#pdf-input");
        if (!input.files[0]) return toast("Choose a file first.", "error");
        const form = new FormData();
        form.append("file", input.files[0]);
        try {
          toast("Uploading…");
          await api("/api/knowledge/upload", { method: "POST", body: form });
          toast("Uploaded — indexing now.");
          renderKnowledge();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    } else if (src === "url") {
      box.innerHTML = `<input type="text" id="url-input" placeholder="https://www.google.com/maps/place/... or your Facebook Page" /> <button class="primary" id="url-btn" style="margin-left:8px">Add</button>`;
      box.querySelector("#url-btn").addEventListener("click", async () => {
        const url = box.querySelector("#url-input").value.trim();
        if (!url) return toast("Paste a link first.", "error");
        try {
          await api("/api/knowledge/url", { method: "POST", body: { url } });
          toast("Added — indexing now.");
          renderKnowledge();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    } else {
      box.innerHTML = `<textarea id="text-input" placeholder="Type what you offer, prices, hours, common questions..." style="min-height:120px"></textarea>
        <button class="primary" id="text-btn" style="margin-top:8px">Add</button>`;
      box.querySelector("#text-btn").addEventListener("click", async () => {
        const text = box.querySelector("#text-input").value.trim();
        if (!text) return toast("Type something first.", "error");
        try {
          await api("/api/knowledge/text", { method: "POST", body: { text } });
          toast("Added — indexing now.");
          renderKnowledge();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }
  }
  renderSourceBody("upload");
  card.querySelectorAll(".knowledge-source-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      card.querySelectorAll(".knowledge-source-tabs button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      renderSourceBody(b.dataset.src);
    })
  );
}

async function renderCallFlow() {
  const { config } = await api("/api/config");
  let qaIntents = [];
  try {
    qaIntents = JSON.parse(config.callflow_qa_intents_json || "[]");
  } catch {}
  app.innerHTML = "";
  const card = el(`<div class="card">
    <h2>Call Flow</h2>
    <p class="hint">This is the real routing logic the live agent runs for its intents + fallback — not a diagram of it.</p>
    <label>1) Bookings</label>
    <textarea id="cf-booking">${config.callflow_booking_policy || ""}</textarea>
    ${qaIntents
      .map(
        (qa, i) => `<label>${i + 2}) ${qa.label}${qa.hardRule ? " (hard rule)" : ""}</label>
      <textarea class="cf-qa" data-key="${qa.key}">${qa.policy || ""}</textarea>`
      )
      .join("")}
    <label>${qaIntents.length + 2}) Notes</label>
    <textarea id="cf-note">${config.callflow_note_policy || ""}</textarea>
    <label>Fallback</label>
    <textarea id="cf-fallback">${config.callflow_fallback_policy || ""}</textarea>
    <div style="margin-top:14px"><button class="primary" id="save-callflow">Save</button></div>
  </div>`);
  app.appendChild(card);
  document.getElementById("save-callflow").addEventListener("click", async () => {
    const qa_policies = {};
    card.querySelectorAll(".cf-qa").forEach((t) => (qa_policies[t.dataset.key] = t.value));
    try {
      await api("/api/config/callflow", {
        method: "POST",
        body: {
          callflow_booking_policy: document.getElementById("cf-booking").value,
          qa_policies,
          callflow_note_policy: document.getElementById("cf-note").value,
          callflow_fallback_policy: document.getElementById("cf-fallback").value,
        },
      });
      toast("Saved — pushed to the live agent.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function renderActions() {
  const { calls, booking_label, note_label } = await api("/api/actions/calls");
  app.innerHTML = "";
  const card = el(`<div class="card">
    <h2>Actions — call log</h2>
    <p class="hint">Every row is a real call. Status is derived from which tool the live agent actually called (or didn't) before the call ended.</p>
    <p class="hint">"Backfilled" means PyAI's live tool-calling didn't fire (known platform bug) and this row was reconstructed from the ended call's transcript instead — see the Details panel for what actually happened.</p>
    <div class="table-scroll"><table>
      <thead><tr><th>Started</th><th>Status</th><th>Reason</th><th>${booking_label || "Bookings"}</th><th>Q&amp;A</th><th>${note_label || "Notes"}</th><th>Source</th><th></th></tr></thead>
      <tbody id="calls-body"></tbody>
    </table></div>
  </div>`);
  app.appendChild(card);
  const body = card.querySelector("#calls-body");
  if (calls.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="muted">No calls yet.</td></tr>`;
  }
  calls.forEach((c) => {
    const tr = el(`<tr>
      <td>${new Date(c.started_at * 1000).toLocaleString()}</td>
      <td><span class="pill ${c.status}">${c.status}</span></td>
      <td class="muted">${c.status_reason || ""}</td>
      <td>${c.booking_count}</td>
      <td>${c.qa_count}</td>
      <td>${c.note_count}</td>
      <td>${extractionBadge(c.extraction_status)}</td>
      <td>
        <button class="secondary detail-btn" data-id="${c.id}">Details</button>
        ${c.extraction_status === "failed" ? `<button class="secondary reprocess-btn" data-id="${c.id}" style="margin-left:4px">Retry</button>` : ""}
      </td>
    </tr>`);
    body.appendChild(tr);
  });
  body.querySelectorAll(".detail-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const existing = document.getElementById(`detail-${btn.dataset.id}`);
      if (existing) return existing.remove();
      const d = await api(`/api/actions/calls/${btn.dataset.id}`);
      const tr = el(`<tr id="detail-${btn.dataset.id}"><td colspan="8">
        <div class="call-detail">
          <strong>Transcript</strong>
          ${d.transcript.map((l) => `<div class="transcript-line"><span class="role">${l.role}:</span> ${l.text}</div>`).join("") || '<div class="muted">No transcript captured.</div>'}
          <div style="margin-top:8px"><strong>Tool calls</strong></div>
          ${d.tool_invocations.map((t) => `<div class="transcript-line">${t.tool_name} — ${t.args_json} <span class="muted">(${t.source})</span></div>`).join("") || '<div class="muted">None.</div>'}
          ${d.call.extraction_status === "failed" ? `<div class="muted" style="margin-top:8px">Backfill failed: ${d.call.extraction_error || "unknown error"}</div>` : ""}
        </div>
      </td></tr>`);
      btn.closest("tr").after(tr);
    })
  );
  body.querySelectorAll(".reprocess-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Retrying…";
      try {
        await api(`/api/actions/calls/${btn.dataset.id}/reprocess`, { method: "POST" });
        toast("Reprocessed — refreshing.");
        renderActions();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "Retry";
      }
    })
  );
}

function extractionBadge(status) {
  const labels = {
    not_applicable: '<span class="muted">live</span>',
    pending: '<span class="pill in_progress">backfilling…</span>',
    success: '<span class="muted">backfilled</span>',
    failed: '<span class="pill escalated">backfill failed</span>',
    skipped: '<span class="muted" title="ANTHROPIC_API_KEY not set">skipped</span>',
  };
  return labels[status] || '<span class="muted">—</span>';
}

async function renderAdvanced() {
  const { config } = await api("/api/config");
  let voices = [];
  try {
    voices = (await api("/api/voices")).data || [];
  } catch {}
  app.innerHTML = "";
  const card = el(`<div class="card">
    <h2>Advanced</h2>
    <p class="hint">Only real, working switches the platform exposes — nothing hand-rolled.</p>
    <label>Voice — sorted by fit for a phone receptionist, real bios from PyAI's voice catalog</label>
    <div class="voice-grid" id="voice-grid"></div>
    <div class="row">
      <div>
        <label>Language</label>
        <select id="language">
          ${["en", "hi", "es", "fr", "de"]
            .map((l) => `<option value="${l}" ${l === config.language ? "selected" : ""}>${l}</option>`)
            .join("")}
        </select>
        <p class="hint" style="margin-top:4px">PyAI's agent-level language field supports en/hi/es/fr/de today — no Mandarin. See README.</p>
      </div>
    </div>
    <div class="row">
      <div>
        <label>Barge sensitivity</label>
        <select id="barge_sensitivity">
          ${["low", "normal", "high"].map((v) => `<option value="${v}" ${v === config.barge_sensitivity ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Idle check-in</label>
        <select id="idle_check_in">
          ${["auto", "patient", "off"].map((v) => `<option value="${v}" ${v === config.idle_check_in ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </div>
    </div>
    <label>Conversational acknowledgments</label>
    <select id="ack_mode">
      ${["auto", "minimal", "off"].map((v) => `<option value="${v}" ${v === config.ack_mode ? "selected" : ""}>${v}</option>`).join("")}
    </select>
    <p class="hint" style="margin-top:4px">Small backchannel sounds ("mm-hmm", "got it") while listening — this is what stops the agent feeling like a form. "auto" is the humane default.</p>
    <label>Consent line (recording disclosure, optional)</label>
    <input type="text" id="consent_line" value="${config.consent_line || ""}" />
    <div class="toggle-row">
      <button type="button" class="toggle ${config.recordings_enabled ? "on" : ""}" id="recordings_enabled" aria-label="Recordings enabled"></button>
      <span class="toggle-label">Recordings enabled</span>
    </div>
    <div style="margin-top:14px"><button class="primary" id="save-advanced">Save</button></div>
  </div>
  <div class="card">
    <h2>Finish setup</h2>
    <p class="hint">Creates/updates the real PyAI agent with everything above, and binds your uploaded knowledge base + the four tools.</p>
    <button class="primary" id="finish-setup">Finish setup</button>
    <span id="setup-status" class="muted" style="margin-left:10px"></span>
  </div>
  <div class="card">
    <h2>Phone number</h2>
    <p class="hint">Provisioning a real number costs money on your PyAI account — this app never buys one without you clicking below.</p>
    <div id="advanced-numbers"></div>
  </div>`);
  app.appendChild(card);

  let selectedVoice = config.voice_id || "";
  const grid = card.querySelector("#voice-grid");
  function renderVoiceGrid() {
    grid.innerHTML = "";
    grid.appendChild(
      el(`<div class="voice-card ${selectedVoice === "" ? "selected" : ""}" data-voice=""><strong>Agent default</strong><div class="muted">No preference — PyAI picks.</div></div>`)
    );
    voices.slice(0, 12).forEach((v) => {
      const c = el(`<div class="voice-card ${selectedVoice === v.voice_id ? "selected" : ""}" data-voice="${v.voice_id}">
        <strong>${v.name}</strong> <span class="muted">${v.accent || v.region || ""}</span>
        <div class="muted">${v.tone || ""}</div>
        ${v.use_cases?.includes("receptionist / front desk") ? '<span class="pill completed" style="margin-top:4px">receptionist fit</span>' : ""}
        ${v.preview_url ? `<div style="margin-top:6px"><audio controls src="${v.preview_url}" style="width:100%;height:28px"></audio></div>` : ""}
      </div>`);
      c.addEventListener("click", (e) => {
        if (e.target.tagName === "AUDIO") return;
        selectedVoice = v.voice_id;
        renderVoiceGrid();
      });
      grid.appendChild(c);
    });
  }
  renderVoiceGrid();

  document.getElementById("recordings_enabled").addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("on");
  });

  document.getElementById("save-advanced").addEventListener("click", async () => {
    try {
      await api("/api/config/advanced", {
        method: "POST",
        body: {
          voice_id: selectedVoice || null,
          language: document.getElementById("language").value,
          barge_sensitivity: document.getElementById("barge_sensitivity").value,
          ack_mode: document.getElementById("ack_mode").value,
          idle_check_in: document.getElementById("idle_check_in").value,
          consent_line: document.getElementById("consent_line").value,
          recordings_enabled: document.getElementById("recordings_enabled").classList.contains("on"),
        },
      });
      toast("Saved — pushed to the live agent.");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  document.getElementById("finish-setup").addEventListener("click", async () => {
    const status = document.getElementById("setup-status");
    status.textContent = "Working…";
    try {
      const { config } = await api("/api/config/finish-setup", { method: "POST" });
      status.textContent = `Agent live: ${config.agent_id}`;
      toast("Setup complete.");
      refreshHeader();
    } catch (err) {
      status.textContent = "Failed.";
      toast(err.message, "error");
    }
  });

  await renderPhoneNumberBlock(document.getElementById("advanced-numbers"));
}

// ----------------------------------------------------------------- Outcomes
// A dedicated top-level page for the exact metrics MayAI is priced on — split
// out of Analytics (which still shows its own copy of the same top card,
// alongside the more operational call-volume/status metrics) so this is the
// first thing anyone clicks when they want "did the AI actually do anything
// useful," not a scroll-down inside a denser ops dashboard.
async function renderOutcomes() {
  const a = await api("/api/analytics/summary");
  app.innerHTML = "";
  const groundingPct = a.grounding_rate == null ? null : Math.round(a.grounding_rate * 100);

  const wrap = el(`<div>
  <div class="card">
    <h2>Outcomes</h2>
    <p class="hint">This is what MayAI is actually priced on — real logged actions from real calls, not usage minutes. Zero calls yet = honest zeros here, not a demo chart.</p>
    <div class="outcome-row">
      <div class="outcome-tile">
        <div class="outcome-icon bookings">📅</div>
        <div><div class="outcome-num">${a.booking_count}</div><div class="outcome-label">${a.booking_label}s made</div></div>
      </div>
      <div class="outcome-tile">
        <div class="outcome-icon grounded">💬</div>
        <div><div class="outcome-num">${a.qa_total}</div><div class="outcome-label">Questions answered</div></div>
      </div>
      <div class="outcome-tile">
        <div class="outcome-icon notes">📝</div>
        <div><div class="outcome-num">${a.note_count}</div><div class="outcome-label">${a.note_label}s captured</div></div>
      </div>
      <div class="outcome-tile">
        <div class="outcome-icon escalated">☎️</div>
        <div><div class="outcome-num">${a.status_breakdown.escalated || 0}</div><div class="outcome-label">Escalations handled</div></div>
      </div>
    </div>
  </div>

  <div class="card gauge-card">
    <div class="gauge-ring" style="--pct:${groundingPct ?? 0}">
      <div class="gauge-ring-label">
        <div class="gauge-ring-num">${groundingPct === null ? "—" : groundingPct + "%"}</div>
        <div class="gauge-ring-sub">grounded</div>
      </div>
    </div>
    <div>
      <h2 style="margin-bottom:4px">Grounded answer rate</h2>
      <p class="hint" style="margin-top:0">The needle-mover metric (see README) — the share of answers that actually traced to real uploaded knowledge instead of being guessed. ${a.total_calls} total calls so far, averaging ${a.avg_call_duration_s ? Math.round(a.avg_call_duration_s) + "s" : "—"} each.</p>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 12px">Recent calls</h3>
    <p class="hint" style="margin-top:0">Full turn-by-turn detail, including per-call summaries, lives on the <a href="#" id="outcomes-actions-link">Actions</a> screen.</p>
  </div>
  </div>`);
  app.appendChild(wrap);
  wrap.querySelector("#outcomes-actions-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector('#sidenav button[data-tab="actions"]')?.click();
  });
}

// ---------------------------------------------------------------- Analytics
async function renderAnalytics() {
  const a = await api("/api/analytics/summary");
  app.innerHTML = "";

  const groundingPct = a.grounding_rate == null ? null : Math.round(a.grounding_rate * 100);
  const maxDaily = Math.max(1, ...a.daily_volume.map((d) => d.calls));
  const totalStatus = Object.values(a.status_breakdown).reduce((s, n) => s + n, 0);

  const wrap = el(`<div>
  <div class="card">
    <h2>Outcomes</h2>
    <p class="hint">This is what MayAI is actually priced on — real logged actions from real calls, not usage minutes. Zero calls yet = honest zeros here, not a demo chart.</p>
    <div class="outcome-row">
      <div class="outcome-tile">
        <div class="outcome-icon bookings">📅</div>
        <div><div class="outcome-num">${a.booking_count}</div><div class="outcome-label">${a.booking_label}s made</div></div>
      </div>
      <div class="outcome-tile">
        <div class="outcome-icon grounded">💬</div>
        <div><div class="outcome-num">${a.qa_total}</div><div class="outcome-label">Questions answered</div></div>
      </div>
      <div class="outcome-tile">
        <div class="outcome-icon notes">📝</div>
        <div><div class="outcome-num">${a.note_count}</div><div class="outcome-label">${a.note_label}s captured</div></div>
      </div>
      <div class="outcome-tile">
        <div class="outcome-icon escalated">☎️</div>
        <div><div class="outcome-num">${a.status_breakdown.escalated || 0}</div><div class="outcome-label">Escalations handled</div></div>
      </div>
    </div>
  </div>

  <div class="card gauge-card">
    <div class="gauge-ring" style="--pct:${groundingPct ?? 0}">
      <div class="gauge-ring-label">
        <div class="gauge-ring-num">${groundingPct === null ? "—" : groundingPct + "%"}</div>
        <div class="gauge-ring-sub">grounded</div>
      </div>
    </div>
    <div>
      <h2 style="margin-bottom:4px">Grounded answer rate</h2>
      <p class="hint" style="margin-top:0">The needle-mover metric (see README) — the share of answers that actually traced to real uploaded knowledge instead of being guessed. ${a.total_calls} total calls so far, averaging ${a.avg_call_duration_s ? Math.round(a.avg_call_duration_s) + "s" : "—"} each.</p>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 12px">Call status breakdown</h3>
    ${
      totalStatus === 0
        ? '<p class="muted">No calls yet.</p>'
        : `<div class="status-bars">
        ${["completed", "partial", "escalated", "in_progress"]
          .filter((s) => a.status_breakdown[s] > 0)
          .map((s) => {
            const pct = Math.round((a.status_breakdown[s] / totalStatus) * 100);
            return `<div class="status-bar-row">
              <span class="pill ${s}" style="width:90px;text-align:center">${s}</span>
              <div class="status-bar-track"><div class="status-bar-fill ${s}" style="width:${pct}%"></div></div>
              <span class="muted" style="width:60px;text-align:right">${a.status_breakdown[s]} (${pct}%)</span>
            </div>`;
          })
          .join("")}
      </div>`
    }
  </div>

  <div class="card">
    <h3 style="margin:0 0 12px">Calls, last 14 days</h3>
    <div class="daily-chart">
      ${a.daily_volume
        .map(
          (d) =>
            `<div class="daily-bar-col" title="${d.date}: ${d.calls} calls">
              <div class="daily-bar" style="height:${Math.max(2, (d.calls / maxDaily) * 80)}px"></div>
              <div class="daily-bar-label">${d.date.slice(8)}</div>
            </div>`
        )
        .join("")}
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 12px">Questions by type</h3>
    ${
      a.qa_by_intent.length === 0
        ? '<p class="muted">No questions logged yet.</p>'
        : `<table>
        <thead><tr><th>Intent</th><th>Asked</th><th>Grounded</th></tr></thead>
        <tbody>
          ${a.qa_by_intent
            .map((q) => `<tr><td>${q.intent}</td><td>${q.count}</td><td>${q.grounded}/${q.count}</td></tr>`)
            .join("")}
        </tbody>
      </table>`
    }
  </div>
  </div>`);
  app.appendChild(wrap);
}

/* =========================================================================
   Router
   ========================================================================= */
const tabRenderers = {
  templates: renderTemplates,
  behavior: renderBehavior,
  knowledge: renderKnowledge,
  callflow: renderCallFlow,
  actions: renderActions,
  outcomes: renderOutcomes,
  analytics: renderAnalytics,
  advanced: renderAdvanced,
};

const pageTitle = document.getElementById("page-title");
const TAB_TITLES = {
  templates: "Templates",
  behavior: "Behavior",
  knowledge: "Knowledge",
  callflow: "Call Flow",
  actions: "Actions",
  outcomes: "Outcomes",
  analytics: "Analytics",
  advanced: "Advanced",
};

document.getElementById("sidenav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  document.querySelectorAll("#sidenav button[data-mode]").forEach((b) => b.classList.toggle("active", b === btn));
  if (btn.dataset.mode === "quickstart") {
    pageTitle.textContent = "Quick Start";
    renderQuickStart();
  } else {
    pageTitle.textContent = TAB_TITLES[btn.dataset.tab] || "Customize";
    tabRenderers[btn.dataset.tab]();
  }
});

// Kept as a plain function (rather than folded into the click handler above)
// since a few flows navigate here programmatically — e.g. the Quick Start
// wizard's "fine-tune in Customize" link — not just a direct sidebar click.
function switchMode(mode) {
  const targetTab = mode === "customize" ? "templates" : "";
  document.querySelectorAll("#sidenav button[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode && (mode !== "customize" || b.dataset.tab === targetTab));
  });
  if (mode === "quickstart") {
    pageTitle.textContent = "Quick Start";
    renderQuickStart();
  } else {
    pageTitle.textContent = "Templates";
    renderTemplates();
  }
}

refreshHeader();
renderQuickStart();
