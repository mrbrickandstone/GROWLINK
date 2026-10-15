"use strict";
const $ = (s) => document.querySelector(s),
  esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const date = (x) =>
  x
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(x))
    : "Not recorded";
const utc = (x) => new Date(x).toISOString().slice(0, 19),
  ms = (x) => new Date(x + "Z").getTime(),
  mb = (x) => (x / 1000000).toFixed(1) + " MB";
let session,
  data,
  view = "overview",
  selected = "ring-1",
  currentTimeline,
  exportResult;
const titles = {
  overview: "Security overview",
  playback: "Recordings",
  evidence: "Evidence & investigation holds",
  access: "Inspector access requests",
  records: "Inspections & backup power",
  audit: "Audit history",
};
async function api(url, body) {
  const r = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body
      ? {
          "Content-Type": "application/json",
          "X-CSRF-Token": session?.user?.csrf || "",
        }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || "REQUEST_FAILED");
  return j;
}
function fail(e) {
  $("#error").hidden = false;
  $("#error").textContent = e.message
    .replaceAll("_", " ")
    .replaceAll(",", " · ");
}
function allowed(action) {
  const u = session?.user;
  if (!u || u.readOnly) return false;
  const map = {
    configure: ["owner", "technician"],
    export: ["owner", "operator", "inspector"],
    hold: ["owner", "operator"],
    release: ["owner"],
    grant: ["owner"],
    record: ["owner", "operator", "technician"],
    delete: ["owner"],
  };
  return map[action]?.includes(u.role);
}
const locked = (action) => (allowed(action) ? "" : "disabled");
const options = () =>
  data.cameras
    .map(
      (c) =>
        `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)} · ${esc(c.room)}</option>`,
    )
    .join("");
function scopeFields() {
  const c = data.cameras.find((c) => c.id === selected) || data.cameras[0],
    end = c?.media.latest || Date.now(),
    start = c?.media.earliest || end - 3600000;
  return `<label>Camera<select name="cameraId">${options()}</select></label><label>Request / case reference<input name="requestId" required placeholder="Inspection or investigation reference"></label><label>From (UTC)<input name="start" type="datetime-local" step="1" value="${utc(start)}" required></label><label>To (UTC)<input name="end" type="datetime-local" step="1" value="${utc(Math.ceil(end / 1000) * 1000)}" required></label>`;
}
function writeNote() {
  return session?.user?.readOnly
    ? '<p class="readonly-note">Local review is read-only. Named sign-in is required to save records, grant access or export evidence.</p>'
    : "";
}
function summary() {
  const count = data.cameras.length,
    clips = data.cameras.reduce((n, c) => n + c.media.count, 0),
    bytes = data.cameras.reduce((n, c) => n + c.media.bytes, 0);
  return `<div class="stats"><div class="stat"><label>Camera inventory</label><strong>${count}</strong><small>Ring cameras · owner-assigned rooms</small></div><div class="stat"><label>Verified sample files</label><strong>${clips}</strong><small>${mb(bytes)} · locally preserved footage</small></div><div class="stat"><label>Archive protection</label><strong class="amber">Uncommissioned</strong><small>Independent protection not established</small></div><div class="stat"><label>Retention target</label><strong>90 <span class="muted">days</span></strong><small>60-day minimum · coverage not established</small></div></div>`;
}
function status(c) {
  return ["capture", "archive", "retention", "access"]
    .map(
      (k) =>
        `<div class="status-item"><span>${k[0].toUpperCase() + k.slice(1)}</span><b class="state-${esc(c[k].state)}" title="${esc(c[k].detail)}">${esc(c[k].state[0].toUpperCase() + c[k].state.slice(1))}</b></div>`,
    )
    .join("");
}
function cameraCard(c) {
  return `<article class="camera"><div class="camera-image">${c.media.thumbnailId ? `<img src="/api/media/${c.media.thumbnailId}/thumbnail" alt="Historical sample from ${esc(c.name)}"><span class="label">RECORDED SAMPLE · ${esc(date(c.media.latest))}</span>` : '<div class="empty-image"><span>▧</span>No verified footage imported</div><span class="label">RECORDING UNVERIFIED</span>'}</div><div class="camera-content"><div class="camera-title"><h3>${esc(c.name)}</h3><span class="chip">RING</span></div><div class="camera-location">${esc(c.model || "Model unverified")} · ${esc(c.room)}</div><div class="status-list">${status(c)}</div><button class="secondary" data-camera="${esc(c.id)}">Browse recordings →</button>${allowed("configure") ? `<details class="mapping"><summary>Map room & location</summary><form data-form="mapping"><input name="id" type="hidden" value="${esc(c.id)}"><label>Camera name<input name="name" value="${esc(c.name)}" required></label><label>Location<input name="location" value="${esc(c.location)}" required></label><label>Room<input name="room" value="${esc(c.room)}" required></label><button>Save mapping</button></form></details>` : ""}</div></article>`;
}
function overview() {
  const groups = new Map();
  for (const c of data.cameras) {
    const key = c.location + " / " + c.room;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return (
    summary() +
    [...groups]
      .map(
        ([name, cameras]) =>
          `<div class="section-heading"><h2>${esc(name)}</h2><small>${cameras.length} cameras · capture state reported separately</small></div><div class="camera-grid">${cameras.map(cameraCard).join("")}</div>`,
      )
      .join("") +
    `<div class="columns"><section class="panel"><h2>Commissioning priorities</h2><div class="activity"><div><strong>Recording source qualification</strong><small>Quiet exports, overlap and recovery passed. Native authentication and capture clock remain unresolved.</small></div><span class="badge">OPEN</span></div><div class="activity"><div><strong>Independent archive & retention</strong><small>Versioned storage, readback and holds need a provisioned destination.</small></div><span class="badge">SETUP</span></div><div class="activity"><div><strong>Failure notification delivery</strong><small>Separate watchdog required. Five-minute receipt has not been commissioned.</small></div><span class="badge">SETUP</span></div></section><section class="panel"><h2>Transfer & evidence</h2><div class="activity"><div><strong>${data.jobs.filter((j) => j.state === "complete").length} transfer jobs completed</strong><small>${data.jobs.filter((j) => j.state === "queued" || j.state === "running").length} queued or running · ${data.jobs.filter((j) => j.state === "blocked" || j.state === "failed").length} require attention</small></div><span class="badge">DURABLE JOBS</span></div><div class="activity"><div><strong>${data.holds.filter((h) => h.state !== "released").length} active investigation holds</strong><small>Pending protection blocks deletion, including late-arriving footage.</small></div></div><div class="activity"><div><strong>Originals and playback copies separated</strong><small>SHA-256 verifies received bytes. Camera-origin authenticity remains unverified.</small></div></div></section></div>`
  );
}
function playback() {
  const c = data.cameras.find((c) => c.id === selected) || data.cameras[0];
  if (!c) return "<p>No cameras are authorized.</p>";
  selected = c.id;
  const end = c.media.latest || Date.now(),
    start = c.media.earliest || end - 3600000;
  return `<section class="panel"><form id="timelineForm" class="toolbar"><label>Camera<select name="camera">${options()}</select></label><label>From (UTC)<input type="datetime-local" name="start" step="0.001" value="${new Date(start).toISOString().slice(0, 23)}" required></label><label>To (UTC)<input type="datetime-local" name="end" step="0.001" value="${new Date(end).toISOString().slice(0, 23)}" required></label><button>Find footage</button></form><video id="player" controls playsinline preload="metadata"></video><div class="video-caption"><span id="playing">Choose a verified recording below.</span><span>Playback derivative · original preserved</span></div><div id="timelineResult"></div></section>`;
}
function evidenceView() {
  return (
    writeNote() +
    `<div class="columns"><section class="panel"><h2>Create evidence export</h2><p>Each export includes a signed handling manifest, original hashes and visible gaps. The signature does not establish camera-native authenticity.</p><form data-form="export"><div class="form-grid">${scopeFields()}<label class="wide">Purpose<textarea name="purpose" required placeholder="Why this footage is being requested"></textarea></label></div><button ${locked("export")}>Verify originals & create export</button></form><div id="exportResult"></div><h3>Export requests</h3>${data.exports.map((e) => `<div class="record"><button class="secondary" data-export="${e.id}">${esc(e.requestId)} · ${esc(e.state)}</button></div>`).join("")}</section><section class="panel"><h2>Place investigation hold</h2><p>Holds also apply to footage that arrives later. Protection stays pending until confirmed at the archive and original source.</p><form data-form="hold"><div class="form-grid">${scopeFields()}<label class="wide">Reason<textarea name="reason" required></textarea></label></div><button ${locked("hold")}>Place hold</button></form></section></div><section class="panel"><h2>Investigation holds</h2>${data.holds.length ? data.holds.map((h) => `<div class="record"><strong>${esc(h.caseReference)}</strong> <span class="badge">${esc(h.state)}</span><p>${esc(h.cameraId)} · ${date(h.start)} → ${date(h.end)}</p><p>${esc(h.reason)}</p><small>Native preservation: ${esc(h.nativePreservation)} · Archive: ${esc(h.archiveProtection || "pending")}</small>${h.state !== "released" && allowed("release") ? `<form data-form="release"><input name="id" type="hidden" value="${h.id}"><label>Release reason<input name="reason" required></label><button class="secondary">Release hold</button></form>` : ""}</div>`).join("") : '<div class="empty">No investigation holds recorded.</div>'}</section><section class="panel"><h2>Controlled deletion</h2><p>Required footage has a 60-day floor and 90-day archive target. Active or pending holds, unknown protection, and unresolved Ring policy block deletion. A different named owner must approve.</p><form data-form="delete"><div class="form-grid"><label>Segment ID<input name="segmentId" required></label><label>Reason<input name="reason" required></label></div><button ${locked("delete")} class="secondary">Request deletion</button></form>${data.deletions.map((d) => `<div class="record"><strong>${esc(d.state)}</strong><p class="mono">${esc(d.segmentId)}</p><p>${esc(d.reason)} · ${esc(d.blockers?.join(", "))}</p>${d.state === "requested" && allowed("delete") ? `<button data-approve-delete="${d.id}" class="secondary">Approve as second owner</button>` : ""}</div>`).join("")}</section>`
  );
}
function access() {
  return (
    writeNote() +
    `<section class="panel"><h2>Request-specific inspector access</h2><p>Every request is limited to a named inspector, camera scope, footage window and expiry. Revocation is checked on every request and during active transfers. Already downloaded bytes cannot be revoked. Ring inspector access is blocked until its vendor policy is approved.</p><form data-form="grant"><div class="form-grid">${scopeFields()}<label>Named inspector<select name="userId" required><option value="">Select provisioned inspector</option>${data.users
      .filter((u) => u.role === "inspector" && u.enabled)
      .map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`)
      .join(
        "",
      )}</select></label><label>Access expires (UTC, max 7 days)<input name="expiresAt" type="datetime-local" required></label><label class="wide">Purpose<textarea name="purpose" required></textarea></label></div><button ${locked("grant")}>Record consent & grant access</button></form></section><section class="panel"><h2>Access grants</h2>${data.grants.length ? data.grants.map((g) => `<div class="record"><strong>${esc(g.requestId)}</strong><span class="badge">${g.revokedAt ? "REVOKED" : g.expiresAt < data.now ? "EXPIRED" : "ACTIVE"}</span><p>${esc(g.purpose)}</p><small>${esc(g.cameraIds.join(", "))} · ${date(g.start)} → ${date(g.end)} · expires ${date(g.expiresAt)}</small>${!g.revokedAt && allowed("grant") ? `<p><button class="secondary" data-revoke="${g.id}">Revoke access now</button></p>` : ""}</div>`).join("") : '<div class="empty">No inspector access has been granted.</div>'}</section><section class="panel"><h2>Named users</h2>${data.users.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead><tbody>${data.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.role)}</td><td>${u.enabled ? "Enabled" : "Disabled"}</td></tr>`).join("")}</tbody></table></div>` : "<p>Sign-in provider and named users must be provisioned. The existing shared Growlink password does not authorize security evidence access.</p>"}</section>`
  );
}
function records() {
  return (
    writeNote() +
    `<div class="columns"><section class="panel"><h2>Security inspection</h2><form data-form="inspection"><div class="form-grid"><label>Camera / asset<select name="cameraId">${options()}</select></label><label>Inspection time (UTC)<input name="performedAt" type="datetime-local" required></label><label>Result<select name="result"><option value="incomplete">Incomplete</option><option value="pass">Passed inspection</option><option value="defects">Defects found</option></select></label><label>Evidence reference<input name="evidenceReference" required></label><label class="wide">Findings & corrective work<textarea name="notes" required></textarea></label></div><button ${locked("record")}>Save inspection record</button></form></section><section class="panel"><h2>Backup-power commissioning</h2><form data-form="power"><div class="form-grid"><label>Camera / asset<select name="cameraId">${options()}</select></label><label>Test start (UTC)<input name="performedAt" type="datetime-local" required></label><label>Measured load (watts)<input name="loadWatts" type="number" min="1" required></label><label>Actual runtime (minutes)<input name="runtimeMinutes" type="number" min="0" required></label><label>UPS / generator & equipment<input name="equipment" required></label><label>Evidence reference<input name="evidenceReference" required></label><label class="wide">Results, interruptions & recovery<textarea name="notes" required></textarea></label><label class="wide"><span><input name="continuityVerified" type="checkbox"> Full camera, recorder, network and alarm continuity verified</span></label></div><button ${locked("record")}>Save measured power test</button></form><p class="compact">Eight hours requires an actual 480-minute test with verified continuity. A rating or calculation does not count.</p></section></div><section class="panel"><h2>Commissioning records</h2>${data.records.length ? data.records.map((r) => `<div class="record"><strong>${esc(r.kind)} · ${date(r.performedAt)}</strong><span class="badge">${esc(r.result)}</span><p>${esc(r.notes)}</p><small>${esc(r.evidenceReference)} · ${r.nextDueAt ? "Next inspection " + date(r.nextDueAt) : esc(r.runtimeMinutes) + " min at " + esc(r.loadWatts) + " W"} · Retain through ${date(r.retainUntil)}</small></div>`).join("") : '<div class="empty">No site inspection or power test has been recorded. No commissioning result is assumed.</div>'}</section>`
  );
}
function audit() {
  return `<section class="panel"><h2>Audit integrity</h2><p>${data.auditIntegrity?.valid ? "Local audit chain verified." : "Audit chain needs attention."} Independent audit checkpoint: ${esc(data.auditIntegrity?.externalCheckpoint || "unavailable")}. A local hash chain alone cannot prevent privileged rewriting.</p><p class="mono">Head: ${esc(data.auditIntegrity?.head || "—")}</p></section><section class="panel"><h2>Named actions & access history</h2>${data.audit.length ? `<div class="table-wrap"><table><thead><tr><th>Time (New York)</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${data.audit.map((r) => `<tr><td>${date(r.event.at)}</td><td>${esc(r.event.actor)}</td><td>${esc(r.event.action)}</td><td class="mono">${esc(JSON.stringify(r.event.detail))}</td></tr>`).join("")}</tbody></table></div>` : "<p>Detailed audit history requires an owner or auditor role.</p>"}</section>`;
}
async function render() {
  if (!data) return;
  $("#pageTitle").textContent = titles[view];
  document.querySelectorAll("nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false");
  });
  $("#content").innerHTML = {
    overview,
    playback,
    evidence: evidenceView,
    access,
    records,
    audit,
  }[view]();
  if (view === "playback") await loadTimeline();
  if (view === "evidence" && exportResult) showExport();
}
async function loadTimeline() {
  const f = $("#timelineForm"),
    v = Object.fromEntries(new FormData(f));
  selected = v.camera;
  const start = ms(v.start),
    end = ms(v.end);
  const t = await api(
    `/api/timeline?camera=${encodeURIComponent(selected)}&start=${start}&end=${end}`,
  );
  currentTimeline = t;
  $("#timelineResult").innerHTML =
    `<div class="timeline" aria-label="Verified footage and unverified intervals"></div><div class="timeline-legend"><span>${date(start)}</span><span>Green: verified footage · Hatched: no verified footage</span><span>${date(end)}</span></div><p class="compact">${(t.coveredMs / 1000).toFixed(3)} of ${(t.requestedMs / 1000).toFixed(3)} seconds covered · ${t.gaps.length} unverified intervals</p>${t.gaps.map((g) => `<div class="gap">No verified footage: ${esc(new Date(g.start).toISOString())} → ${esc(new Date(g.end).toISOString())} (${((g.end - g.start) / 1000).toFixed(3)} s)</div>`).join("")}<div class="clip-list">${t.segments.map((s, i) => `<button data-clip="${s.id}" ${s.derivativeReady ? "" : "disabled"}><span>${date(s.start)} → ${date(s.end)}</span><span>${mb(s.bytes)} · ${s.independent ? "archive verified" : "local copy"}</span></button>`).join("")}</div>${!t.segments.length ? '<div class="empty">No verified playback files in this window. Camera online status is not recording evidence.</div>' : ""}`;
  for (const i of t.intervals) {
    const b = document.createElement("span");
    b.className = "interval";
    b.style.left = ((i.start - start) / (end - start)) * 100 + "%";
    b.style.width = ((i.end - i.start) / (end - start)) * 100 + "%";
    $(".timeline").append(b);
  }
  const first = t.segments.find((s) => s.derivativeReady);
  if (first) play(first.id);
  else {
    $("#player").removeAttribute("src");
    $("#player").load();
    $("#player").hidden = true;
    $(".video-caption").hidden = true;
  }
}
function play(id) {
  $("#player").hidden = false;
  $(".video-caption").hidden = false;
  const s = currentTimeline.segments.find((s) => s.id === id);
  $("#player").src = `/api/media/${id}/playback`;
  $("#playing").textContent =
    date(s.start) + " → " + date(s.end) + " · " + s.provenance;
  document
    .querySelectorAll("[data-clip]")
    .forEach((b) => b.classList.toggle("active", b.dataset.clip === id));
}
function showExport() {
  const r = exportResult;
  if (r.state !== "complete") {
    $("#exportResult").innerHTML =
      `<div class="record"><h3>Export ${esc(r.state)}</h3><p>Originals are verified by the durable worker before this export becomes available. ${esc(r.error || "")}</p><button class="secondary" data-export="${r.id}">Refresh export status</button></div>`;
    return;
  }
  const m = JSON.parse(r.manifestText);
  $("#exportResult").innerHTML =
    `<div class="record"><h3>Export verified and recorded</h3><a href="/api/exports/${r.id}">Download signed manifest (.json)</a><div class="export-files">${m.files.map((f) => `<a href="/api/media/${f.segmentId}/original?export=${r.id}">Download original · ${date(f.start)} · ${mb(f.bytes)}</a>`).join("")}</div><p>Camera-native authentication: ${esc(m.cameraNativeAuthentication)}. ${m.coverage.gaps.length} gaps disclosed in manifest.</p></div>`;
}
async function reload() {
  session = await api("/api/session");
  $("#signIn").hidden = !!session.user;
  $("#signOut").hidden = !session.user || session.review;
  $("#notice").textContent = session.review
    ? "LOCAL REVIEW · Real pilot footage, read-only. Independent archive, named sign-in and notification delivery are not commissioned."
    : session.user
      ? `${session.user.name} · ${session.user.role} · Recording-source qualification pending.`
      : session.signInConfigured
        ? "Sign in with your named account to access security footage."
        : "Named sign-in is not configured. No security footage is exposed without authentication.";
  if (!session.user) {
    $("#content").innerHTML =
      '<section class="panel"><h2>Secure access required</h2><p>Connect the configured identity provider and provision a named account.</p></section>';
    return;
  }
  data = await api("/api/overview");
  await render();
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    $("#error").hidden = true;
    if (b.dataset.view) {
      view = b.dataset.view;
      await render();
    }
    if (b.dataset.camera) {
      selected = b.dataset.camera;
      view = "playback";
      await render();
    }
    if (b.dataset.clip) play(b.dataset.clip);
    if (b.dataset.export) {
      exportResult = await api("/api/exports/" + b.dataset.export + "/status");
      showExport();
    }
    if (b.dataset.revoke) {
      await api("/api/grants/revoke", { id: b.dataset.revoke });
      await reload();
    }
    if (b.dataset.approveDelete) {
      await api("/api/deletions/approve", { id: b.dataset.approveDelete });
      await reload();
    }
  } catch (err) {
    fail(err);
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#error").hidden = true;
  const f = e.target,
    button = f.querySelector("button");
  try {
    if (f.id === "timelineForm") return await loadTimeline();
    button.disabled = true;
    const v = Object.fromEntries(new FormData(f)),
      kind = f.dataset.form;
    for (const k of ["start", "end", "performedAt", "expiresAt"])
      if (v[k]) v[k] = ms(v[k]);
    let endpoint;
    if (kind === "mapping") endpoint = "/api/cameras";
    if (kind === "hold") {
      endpoint = "/api/holds";
      v.caseReference = v.requestId;
    }
    if (kind === "release") endpoint = "/api/holds/release";
    if (kind === "grant") {
      endpoint = "/api/grants";
      v.cameraIds = [v.cameraId];
    }
    if (["inspection", "power"].includes(kind)) {
      endpoint = "/api/records";
      v.kind = kind;
      v.cameraIds = [v.cameraId];
      if (kind === "power") {
        v.loadWatts = Number(v.loadWatts);
        v.runtimeMinutes = Number(v.runtimeMinutes);
        v.continuityVerified = f.elements.continuityVerified.checked;
      }
    }
    if (kind === "delete") endpoint = "/api/deletions";
    if (kind === "export") {
      exportResult = await api("/api/exports", v);
      showExport();
      return;
    }
    await api(endpoint, v);
    await reload();
  } catch (err) {
    fail(err);
  } finally {
    if (button && f.dataset.form)
      button.disabled = !allowed(
        {
          mapping: "configure",
          hold: "hold",
          release: "release",
          grant: "grant",
          inspection: "record",
          power: "record",
          delete: "delete",
          export: "export",
        }[f.dataset.form],
      );
  }
});
$("#refresh").onclick = () => reload().catch(fail);
$("#signOut").onclick = async () => {
  try {
    await api("/api/logout", {});
    data = null;
    await reload();
  } catch (e) {
    fail(e);
  }
};
function tick() {
  $("#clock").textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date());
}
tick();
setInterval(tick, 30000);
reload().catch(fail);
