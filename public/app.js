const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const headerStatus = document.getElementById("header-status");

function toast(msg, type = "ok") {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
  toastEl.style.display = "block";
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.style.display = "none"), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
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
    headerStatus.textContent = config.phone_number
      ? `Live on ${config.phone_number}`
      : config.agent_id
      ? "Agent created — no phone number yet"
      : "Not set up yet";
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

function wizardShell(stepIndex, bodyHtml) {
  const steps = ["What kind of business?", "What do you offer?", "Go live"];
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
    `<div class="big-question">What kind of business is this?</div>
     <p class="hint">Pick the closest match — everything below is fully editable later, this just gets you a sensible starting point instead of a blank page.</p>
     <label>Business name</label>
     <input type="text" id="qs-business-name" placeholder="e.g. Piazza Verde" value="${config.business_name && config.business_name !== "My Business" ? config.business_name : ""}" />
     <div style="margin-top:18px">
       ${Object.entries(byIndustry)
         .map(
           ([industryLabel, tpls]) => `
         <div style="margin-bottom:14px">
           <label style="margin-bottom:8px">${industryLabel}</label>
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
  nameInput.addEventListener("input", maybeContinue);

  function maybeContinue() {
    if (document.getElementById("qs-continue")) return;
    if (!selectedKey || !nameInput.value.trim()) return;
    const btn = el(`<button class="primary" id="qs-continue" style="margin-top:18px">Continue →</button>`);
    app.querySelector(".card").appendChild(btn);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Setting up…";
      try {
        await api("/api/config/template", { method: "POST", body: { template_key: selectedKey, business_name: nameInput.value.trim() } });
        renderQuickStart();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "Continue →";
      }
    });
  }
}

async function renderWizardStep2(config) {
  const { documents, knowledge_label } = await api("/api/knowledge");
  wizardShell(
    1,
    `<div class="big-question">What do you offer?</div>
     <p class="hint">${knowledge_label || "Menu / info sheet"} — the agent only answers from this, never guesses. Pick whichever is easiest, no website needed.</p>
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
  wizardShell(2, `<div class="big-question">Going live…</div><p class="hint">Setting up your agent.</p>`);
  try {
    await api("/api/config/finish-setup", { method: "POST" });
  } catch (err) {
    toast(err.message, "error");
  }
  renderQuickStart();
}

async function renderWizardStep3(config) {
  wizardShell(
    2,
    `<div class="big-question">You're set up.</div>
     <p class="hint">Your agent is real and configured. Last step is a phone number — that's the only part with a real cost, so nothing happens here without you clicking it.</p>
     <div id="qs-numbers"></div>
     <div style="margin-top:18px"><a href="#" id="qs-customize-link">Want to fine-tune what it says? Go to Customize →</a></div>`
  );
  await renderPhoneNumberBlock(document.getElementById("qs-numbers"));
  document.getElementById("qs-customize-link").addEventListener("click", (e) => {
    e.preventDefault();
    switchMode("customize");
  });
}

/* =========================================================================
   Shared: phone number block (used in both Quick Start step 3 and Advanced)
   ========================================================================= */
async function renderPhoneNumberBlock(container) {
  const { config } = await api("/api/config");
  container.innerHTML = `<p class="muted">Current: ${config.phone_number || "none yet"}</p>
    <button class="secondary" id="pn-list-btn">List my PyAI numbers</button>
    <div id="pn-list" style="margin-top:10px"></div>`;
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
    <div class="table-scroll"><table>
      <thead><tr><th>Started</th><th>Status</th><th>Reason</th><th>${booking_label || "Bookings"}</th><th>Q&amp;A</th><th>${note_label || "Notes"}</th><th></th></tr></thead>
      <tbody id="calls-body"></tbody>
    </table></div>
  </div>`);
  app.appendChild(card);
  const body = card.querySelector("#calls-body");
  if (calls.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="muted">No calls yet.</td></tr>`;
  }
  calls.forEach((c) => {
    const tr = el(`<tr>
      <td>${new Date(c.started_at * 1000).toLocaleString()}</td>
      <td><span class="pill ${c.status}">${c.status}</span></td>
      <td class="muted">${c.status_reason || ""}</td>
      <td>${c.booking_count}</td>
      <td>${c.qa_count}</td>
      <td>${c.note_count}</td>
      <td><button class="secondary detail-btn" data-id="${c.id}">Details</button></td>
    </tr>`);
    body.appendChild(tr);
  });
  body.querySelectorAll(".detail-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const existing = document.getElementById(`detail-${btn.dataset.id}`);
      if (existing) return existing.remove();
      const d = await api(`/api/actions/calls/${btn.dataset.id}`);
      const tr = el(`<tr id="detail-${btn.dataset.id}"><td colspan="7">
        <div class="call-detail">
          <strong>Transcript</strong>
          ${d.transcript.map((l) => `<div class="transcript-line"><span class="role">${l.role}:</span> ${l.text}</div>`).join("") || '<div class="muted">No transcript captured.</div>'}
          <div style="margin-top:8px"><strong>Tool calls</strong></div>
          ${d.tool_invocations.map((t) => `<div class="transcript-line">${t.tool_name} — ${t.args_json}</div>`).join("") || '<div class="muted">None.</div>'}
        </div>
      </td></tr>`);
      btn.closest("tr").after(tr);
    })
  );
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
    <label><input type="checkbox" id="recordings_enabled" ${config.recordings_enabled ? "checked" : ""} style="width:auto;margin-right:6px" />Recordings enabled</label>
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
          recordings_enabled: document.getElementById("recordings_enabled").checked,
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

/* =========================================================================
   Router
   ========================================================================= */
const tabRenderers = {
  templates: renderTemplates,
  behavior: renderBehavior,
  knowledge: renderKnowledge,
  callflow: renderCallFlow,
  actions: renderActions,
  advanced: renderAdvanced,
};

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  tabRenderers[btn.dataset.tab]();
});

function switchMode(mode) {
  document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("tabs").style.display = mode === "customize" ? "flex" : "none";
  if (mode === "quickstart") {
    renderQuickStart();
  } else {
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "templates"));
    renderTemplates();
  }
}

document.getElementById("modes").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  switchMode(btn.dataset.mode);
});

refreshHeader();
renderQuickStart();
