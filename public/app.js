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

// ---------------------------------------------------------------- Templates
async function renderTemplates() {
  const { templates } = await api("/api/templates");
  const { config } = await api("/api/config");
  app.innerHTML = "";
  app.appendChild(
    el(`<div class="card">
      <h2>Pick a starting persona</h2>
      <p class="hint">Loads a real default persona + call-flow policy below. Everything stays editable afterward.</p>
      <div class="template-grid">
        ${templates
          .map(
            (t) => `<div class="template-card ${t.key === config.template_key ? "selected" : ""}" data-key="${t.key}">
              <strong>${t.label}</strong>
            </div>`
          )
          .join("")}
      </div>
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

// ----------------------------------------------------------------- Behavior
async function renderBehavior() {
  const { config } = await api("/api/config");
  app.innerHTML = "";
  app.appendChild(
    el(`<div class="card">
      <h2>Behavior</h2>
      <p class="hint">These fields ARE the system prompt sent to the live agent. Save to push the change to the next call.</p>
      <label>Restaurant name</label>
      <input type="text" id="restaurant_name" value="${config.restaurant_name || ""}" />
      <label>Greeting (spoken at the start of every call)</label>
      <input type="text" id="greeting" value="${config.greeting || ""}" />
      <label>Role</label>
      <textarea id="behavior_role">${config.behavior_role || ""}</textarea>
      <label>Personality</label>
      <textarea id="behavior_personality">${config.behavior_personality || ""}</textarea>
      <label>Conversation style</label>
      <textarea id="behavior_style">${config.behavior_style || ""}</textarea>
      <div style="margin-top:14px"><button class="primary" id="save-behavior">Save</button></div>
    </div>`)
  );
  document.getElementById("save-behavior").addEventListener("click", async () => {
    try {
      await api("/api/config/behavior", {
        method: "POST",
        body: {
          restaurant_name: document.getElementById("restaurant_name").value,
          greeting: document.getElementById("greeting").value,
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

// ---------------------------------------------------------------- Knowledge
async function renderKnowledge() {
  const { documents, has_knowledge_base } = await api("/api/knowledge");
  app.innerHTML = "";
  const card = el(`<div class="card">
    <h2>Knowledge</h2>
    <p class="hint">Upload the menu / allergen PDF. It's actually parsed and indexed by PyAI, and grounds the agent's menu and allergy answers. No PDF uploaded yet = the agent says it doesn't have menu info.</p>
    <input type="file" id="pdf-input" accept="application/pdf" />
    <button class="primary" id="upload-btn" style="margin-left:8px">Upload</button>
    <div id="doc-list" style="margin-top:16px"></div>
  </div>`);
  app.appendChild(card);

  const list = card.querySelector("#doc-list");
  if (documents.length === 0) {
    list.innerHTML = `<p class="muted">No documents uploaded yet.</p>`;
  } else {
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

  card.querySelector("#upload-btn").addEventListener("click", async () => {
    const input = card.querySelector("#pdf-input");
    if (!input.files[0]) return toast("Choose a PDF first.", "error");
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
}

// ---------------------------------------------------------------- Call Flow
async function renderCallFlow() {
  const { config } = await api("/api/config");
  const fields = [
    ["callflow_reservation_policy", "1) Reservation — capture name, party size, date, time"],
    ["callflow_menu_policy", "2) Menu questions — grounded in the uploaded PDF only"],
    ["callflow_allergy_policy", "3) Allergy questions — grounded + always include the safety disclaimer"],
    ["callflow_special_policy", "4) Special requests — birthday, proposal, etc."],
    ["callflow_fallback_policy", "Fallback — anything else routes to a human callback"],
  ];
  app.innerHTML = "";
  const card = el(`<div class="card">
    <h2>Call Flow</h2>
    <p class="hint">This is the real routing logic the live agent runs for its four intents + fallback — not a diagram of it.</p>
    ${fields.map(([key, label]) => `<label>${label}</label><textarea id="${key}">${config[key] || ""}</textarea>`).join("")}
    <div style="margin-top:14px"><button class="primary" id="save-callflow">Save</button></div>
  </div>`);
  app.appendChild(card);
  document.getElementById("save-callflow").addEventListener("click", async () => {
    const body = {};
    fields.forEach(([key]) => (body[key] = document.getElementById(key).value));
    try {
      await api("/api/config/callflow", { method: "POST", body });
      toast("Saved — pushed to the live agent.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ------------------------------------------------------------------ Actions
async function renderActions() {
  const { calls } = await api("/api/actions/calls");
  app.innerHTML = "";
  const card = el(`<div class="card">
    <h2>Actions — call log</h2>
    <p class="hint">Every row is a real call. Status is derived from which tool the live agent actually called (or didn't) before the call ended.</p>
    <table>
      <thead><tr><th>Started</th><th>Status</th><th>Reason</th><th>Reservations</th><th>Q&amp;A</th><th>Special</th><th></th></tr></thead>
      <tbody id="calls-body"></tbody>
    </table>
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
      <td>${c.reservation_count}</td>
      <td>${c.qa_count}</td>
      <td>${c.special_request_count}</td>
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

// ----------------------------------------------------------------- Advanced
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
    <div class="row">
      <div>
        <label>Voice</label>
        <select id="voice_id">
          <option value="">(agent default)</option>
          ${voices.map((v) => `<option value="${v.voice_id}" ${v.voice_id === config.voice_id ? "selected" : ""}>${v.name} — ${v.region || ""}</option>`).join("")}
        </select>
      </div>
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
    <p class="hint">Current: ${config.phone_number || "none yet"}. Provisioning a real number costs money on your PyAI account — this app never buys one without you clicking below.</p>
    <button class="secondary" id="list-numbers">List my PyAI numbers</button>
    <div id="numbers-list" style="margin-top:10px"></div>
  </div>`);
  app.appendChild(card);

  document.getElementById("save-advanced").addEventListener("click", async () => {
    try {
      await api("/api/config/advanced", {
        method: "POST",
        body: {
          voice_id: document.getElementById("voice_id").value || null,
          language: document.getElementById("language").value,
          barge_sensitivity: document.getElementById("barge_sensitivity").value,
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

  document.getElementById("list-numbers").addEventListener("click", async () => {
    const box = document.getElementById("numbers-list");
    try {
      const { data } = await api("/api/telephony/numbers");
      box.innerHTML = (data || [])
        .map(
          (n) => `<div class="doc-row"><div>${n.phone_number}</div>
            <button class="secondary assign-btn" data-id="${n.id}" data-number="${n.phone_number}">Assign to this agent</button></div>`
        )
        .join("") || '<p class="muted">No numbers on this account yet — buy one at console.pyai.com or POST /api/telephony/provision.</p>';
      box.querySelectorAll(".assign-btn").forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!confirm(`Assign ${btn.dataset.number} to this agent? Calls will start ringing into it.`)) return;
          try {
            await api("/api/telephony/assign", { method: "POST", body: { number_id: btn.dataset.id, phone_number: btn.dataset.number } });
            toast("Assigned.");
            renderAdvanced();
            refreshHeader();
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

// -------------------------------------------------------------------- Router
const renderers = {
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
  renderers[btn.dataset.tab]();
});

refreshHeader();
renderTemplates();
