(() => {
  const $ = id => document.getElementById(id), fields = form => $(form).elements;
  let auth = '', workspace = null, generation = 0, loading = false, loadedRevision = 0;
  const pending = new Map();
  const label = { airTempF: 'Air °F', rh: 'RH %', feedEc: 'Feed EC', drainEc: 'Drain EC', feedPh: 'Feed pH', appliedLiters: 'Applied L', drainedLiters: 'Drained L', measuredPlants: 'Plants measured' };
  const num = n => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
  const date = value => value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : 'Not recorded';
  const node = (tag, value, cls) => { const n = document.createElement(tag); if (value !== undefined) n.textContent = value; if (cls) n.className = cls; return n; };
  function nowLocal() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  function defaults() { for (const f of ['observationForm', 'followupForm']) fields(f).occurredAt.value = nowLocal(); }
  function reset() {
    generation++; auth = ''; workspace = null; loading = false; loadedRevision = 0; pending.clear();
    $('workspace').hidden = true; $('connection').hidden = false; $('refresh').hidden = $('signout').hidden = true;
    for (const id of ['summary', 'recommendations', 'waterMetrics', 'history', 'sources', 'records', 'limitations']) $(id).replaceChildren();
    for (const id of ['profileForm', 'observationForm', 'followupForm']) $(id).reset();
    for (const id of ['profileMessage', 'observationMessage', 'followupMessage', 'message']) $(id).textContent = '';
    $('readingFields').disabled = $('followupFields').disabled = true; $('password').value = ''; defaults();
  }
  async function request(payload) {
    const response = await fetch('/api/cucumber', { method: payload ? 'POST' : 'GET', cache: 'no-store', headers: { Authorization: auth, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'Workspace request failed'); error.status = response.status; throw error; }
    return result;
  }
  function stat(parent, heading, value, description) { const n = node('div', undefined, 'stat'); n.append(node('small', heading), node('strong', value), node('small', description)); parent.append(n); }
  function followup(id) {
    fields('followupForm').relatedId.value = id; fields('followupForm').occurredAt.value = nowLocal(); pending.delete('followupForm');
    $('followupForm').scrollIntoView?.({ behavior: 'smooth', block: 'center' }); fields('followupForm').note.focus();
  }
  function render(data, updateProfile = false) {
    workspace = data; const { profile, assessment: a, records } = data;
    if (updateProfile) loadedRevision = profile?.revision || 0;
    const setupChanged = (profile?.revision || 0) !== loadedRevision;
    $('workspace').hidden = false; $('connection').hidden = true; $('refresh').hidden = $('signout').hidden = false;
    $('readingFields').disabled = !profile || setupChanged;
    $('refresh').textContent = setupChanged ? 'Reload setup' : 'Refresh checks';
    $('summary').replaceChildren(); stat($('summary'), 'GROWING AREA', profile?.area || 'Setup needed', 'Cucumbers · coco');
    stat($('summary'), 'DAYS LOGGED · LAST 7', `${a.baseline.daysWithReadings} / 7`, `${a.baseline.samples} manual entries · same setup`);
    stat($('summary'), 'LATEST READING', date(a.latest?.occurredAt), 'Manual observations · no connected sensors');
    $('generated').textContent = `Checks generated ${date(a.generatedAt)}`;
    if (updateProfile) for (const key of ['area', 'cultivar', 'stage', 'system', 'plantCount', 'containerLiters']) fields('profileForm')[key].value = profile?.[key] ?? (['stage', 'system'].includes(key) ? 'unknown' : '');
    $('recommendations').replaceChildren();
    for (const card of a.cards) {
      const n = node('article', undefined, 'card ' + card.level);
      n.append(node('h3', card.title), node('p', card.detail), node('p', card.action, 'action'));
      const source = a.sources.find(s => s.id === card.source);
      if (source) { const link = node('a', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; n.append(link); }
      if (card.observationId) { const b = node('button', 'Record follow-up'); b.type = 'button'; b.onclick = () => followup(card.observationId); n.append(b); }
      $('recommendations').append(n);
    }
    $('waterMetrics').replaceChildren();
    for (const [name, value] of [['Drainage fraction', Number.isFinite(a.metrics.drainagePercent) ? num(a.metrics.drainagePercent) + '%' : 'Not enough matched data'], ['Applied per measured plant', Number.isFinite(a.metrics.appliedLitersPerMeasuredPlant) ? num(a.metrics.appliedLitersPerMeasuredPlant) + ' L' : 'Not available'], ['Collection duration', Number.isFinite(a.metrics.collectionHours) ? num(a.metrics.collectionHours) + ' hours' : 'Not recorded']]) {
      const n = node('div', undefined, 'metric'); n.append(node('small', name), node('strong', value)); $('waterMetrics').append(n);
    }
    const wrap = node('div', undefined, 'table-wrap'), table = node('table'), tr = node('tr');
    for (const name of ['Reading', 'Median', 'Min–max', 'Samples']) tr.append(node('th', name)); const thead = node('thead'); thead.append(tr); table.append(thead); const body = node('tbody');
    for (const h of a.history) { const row = node('tr'); for (const value of [label[h.field], num(h.median), `${num(h.min)}–${num(h.max)}`, String(h.count)]) row.append(node('td', value)); body.append(row); }
    table.append(body); wrap.append(table); $('history').replaceChildren(wrap);
    $('sources').replaceChildren();
    for (const source of a.sources) { const n = node('div', undefined, 'source'), link = node('a', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; n.append(link, node('p', source.scope)); $('sources').append(n); }
    $('limitations').replaceChildren(); for (const limit of a.limitations) $('limitations').append(node('li', limit));
    const selected = fields('followupForm').relatedId.value, select = fields('followupForm').relatedId; select.replaceChildren(); const blank = node('option', 'Choose a reading'); blank.value = ''; select.append(blank);
    const currentReadings = records.filter(r => r.kind === 'observation' && r.profile?.fingerprint === profile?.fingerprint);
    for (const r of currentReadings) { const o = node('option', `${date(r.occurredAt)} · ${r.note.slice(0, 30)}`); o.value = r.id; select.append(o); }
    if (currentReadings.some(r => r.id === selected)) select.value = selected;
    $('followupFields').disabled = !currentReadings.length || setupChanged;
    $('records').replaceChildren();
    if (!records.length) $('records').append(node('p', 'No records yet. Your first measurements will appear here.'));
    for (const r of records) {
      const n = node('article', undefined, 'record'); n.append(node('strong', `${date(r.occurredAt)} · ${r.kind === 'followup' ? 'Follow-up' : 'Reading'} · ${r.profile.area}`), node('small', `Setup ${r.profile.revision} · ${r.profile.stage} · ${r.profile.system} · ID ${r.id}`));
      if (r.kind === 'observation') {
        const values = Object.entries(label).filter(([key]) => r[key] !== null).map(([key, name]) => `${name}: ${num(r[key])}`); n.append(node('p', values.join(' · ')));
        if (r.periodStart) n.append(node('p', `Collection ${date(r.periodStart)}–${date(r.periodEnd)} · same group ${r.sameGroup ? 'confirmed' : 'not confirmed'} · complete ${r.collectionComplete ? 'yes' : 'not confirmed'}`));
        if (r.profile.fingerprint === profile?.fingerprint) { const b = node('button', 'Add follow-up'); b.onclick = () => followup(r.id); n.append(b); }
      } else n.append(node('small', `Related reading: ${r.relatedId}`));
      if (r.note) n.append(node('p', r.note)); $('records').append(n);
    }
    if (setupChanged) $('message').textContent = 'Setup changed in another session. Reload setup before entering more measurements.';
  }
  async function load(updateProfile = false) {
    if (!auth || loading) return; loading = true; const current = generation; $('refresh').disabled = true;
    try { const data = await request(); if (current === generation) { $('message').textContent = ''; render(data, updateProfile); } }
    catch (error) { if (current === generation) { if (error.status === 401) reset(); $('message').textContent = error.message; } }
    finally { if (current === generation) { loading = false; $('refresh').disabled = false; } }
  }
  const numeric = (f, name) => f[name].value === '' ? null : Number(f[name].value);
  const iso = value => { if (!value || !Number.isFinite(Date.parse(value))) throw new Error('Choose a valid measurement / collection time'); return new Date(value).toISOString(); };
  function profilePayload() {
    const f = fields('profileForm'); return { action: 'profile', revision: loadedRevision, profile: { crop: 'cucumber', medium: 'coco', area: f.area.value, cultivar: f.cultivar.value, stage: f.stage.value, system: f.system.value, plantCount: numeric(f, 'plantCount'), containerLiters: numeric(f, 'containerLiters') } };
  }
  function recordPayload(formId) {
    const f = fields(formId), record = { id: crypto.randomUUID(), crop: 'cucumber', medium: 'coco', kind: formId === 'followupForm' ? 'followup' : 'observation', occurredAt: iso(f.occurredAt.value), note: f.note.value };
    if (record.kind === 'followup') record.relatedId = f.relatedId.value;
    else {
      for (const name of Object.keys(label)) record[name] = numeric(f, name);
      for (const name of ['meterChecked', 'sameGroup', 'collectionComplete']) record[name] = f[name].checked;
      if (record.appliedLiters !== null || record.drainedLiters !== null) { record.periodStart = iso(f.periodStart.value); record.periodEnd = iso(f.periodEnd.value); }
    }
    return { action: 'record', revision: loadedRevision, record };
  }
  for (const [formId, messageId] of [['profileForm', 'profileMessage'], ['observationForm', 'observationMessage'], ['followupForm', 'followupMessage']]) {
    const form = $(formId); form.addEventListener('input', () => pending.delete(formId)); form.addEventListener('change', () => pending.delete(formId));
    form.onsubmit = async event => {
      event.preventDefault(); if (!auth || !form.reportValidity()) return; const current = generation;
      let payload;
      try { payload = pending.get(formId) || (formId === 'profileForm' ? profilePayload() : recordPayload(formId)); pending.set(formId, payload); }
      catch (error) { $(messageId).textContent = error.message; return; }
      const controls = [...form.querySelectorAll('input,select,textarea,button')]; const disabled = controls.map(c => c.disabled); controls.forEach(c => { c.disabled = true; });
      $(messageId).textContent = 'Saving…';
      try {
        const result = await request(payload); if (current !== generation) return;
        pending.delete(formId); $(messageId).textContent = result.duplicate ? 'Already saved. No duplicate added.' : 'Saved.';
        if (formId !== 'profileForm') { form.reset(); fields(formId).occurredAt.value = nowLocal(); }
        else { for (const id of ['observationForm', 'followupForm']) { $(id).reset(); pending.delete(id); } defaults(); }
        await load(formId === 'profileForm');
      } catch (error) { if (current === generation) { if (error.status === 401) reset(); else if (error.status === 409) pending.delete(formId); $(messageId).textContent = error.message; } }
      finally { controls.forEach((c, i) => { c.disabled = disabled[i]; }); }
    };
  }
  $('login').onsubmit = async event => {
    event.preventDefault(); const bytes = new TextEncoder().encode('cucumber:' + $('password').value); auth = 'Basic ' + btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')); $('password').value = ''; await load(true);
  };
  $('refresh').onclick = () => load(true); $('signout').onclick = reset;
  $('download').onclick = () => {
    if (!workspace) return;
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...workspace }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = 'cucumber-coco-records.json'; a.click(); URL.revokeObjectURL(url);
  };
  $('timeHelp').textContent = `Entry times use your device timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}); records display in New York time. EC is mS/cm, not ppm or probe bulk EC.`;
  defaults(); setInterval(() => { if (auth && !document.hidden) load(); }, 90000);
})();
