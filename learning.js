const learningPanel = (() => {
  const byId = id => document.getElementById(id);
  let credentials = '', loading = false, pendingId = null, pendingPayload = null, generation = 0;
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const date = t => t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not available';
  const num = v => Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
  const stat = (parent, label, value, note) => { const n = node('div', undefined, 'stat'); n.append(node('small', label), node('strong', value), node('small', note)); parent.append(n); };
  async function call(path, options = {}) {
    const r = await fetch('/api/learning' + path, { ...options, cache: 'no-store', headers: { Authorization: credentials, ...options.headers } });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Learning request failed'); return j;
  }
  function render(data) {
    const b = data.baseline, stats = byId('learningStats'); stats.replaceChildren();
    if (!b) { byId('learningStatus').textContent = 'Waiting for the first complete five-minute capture to start the new baseline.'; return; }
    byId('learningStatus').textContent = `${b.stale ? 'Collection needs attention' : 'Collecting fresh readings'} · New baseline ${date(b.startedAt)}–${date(b.endsAt)} · ${data.legacyArchived ? 'Earlier observations preserved' : 'Earlier archive pending'} · Times New York`;
    stat(stats, 'BASELINE COVERAGE', num(b.coveragePercent) + '%', `${b.completeCaptures} complete / ${b.expectedCaptures} expected captures so far`);
    stat(stats, 'LAST COMPLETE CAPTURE', date(b.lastCompleteAt), `${data.sensorCount} configured sensors · five-minute schedule`);
    stat(stats, 'LONGEST NEW GAP', num(b.longestGapMs / 60000) + ' min', 'Earlier gaps remain in the separate archive');
    const report = data.currentAnalysis || data.latestReport;
    const container = byId('learningReport'); container.replaceChildren();
    if (!report) container.append(node('p', 'The first daily report will be saved after a complete capture.'));
    else {
      container.append(node('h3', data.currentAnalysis ? 'Current 24-hour analysis' : 'Saved daily report'),
        node('p', `${date(report.generatedAt)} · ${report.coverage.complete}/${report.coverage.expected} complete captures (${num(report.coverage.percent)}% coverage). Daily reports save after 7 a.m. New York.`, 'muted'),
        node('p', report.readiness));
      if (data.currentAnalysis && data.latestReport) container.append(node('p', `Saved daily report: ${date(data.latestReport.generatedAt)}. Current analysis includes entries and readings recorded since then.`, 'muted'));
      const findings = node('ul'); for (const text of report.findings || []) findings.append(node('li', text)); container.append(findings);
      const wrap = node('div', undefined, 'table-wrap'), table = node('table'), head = node('thead'), tr = node('tr');
      for (const text of ['Reading', 'Minimum', 'Sample mean', 'Maximum', 'Samples']) tr.append(node('th', text));
      head.append(tr); table.append(head); const body = node('tbody');
      for (const s of report.observations) { const row = node('tr'); for (const text of [
        `${s.group === 'climate' ? 'Room' : `Probe ${s.group}`} ${s.name}${s.unit ? ` (${s.unit})` : ''}`,
        num(s.min), num(s.sampleMean), num(s.max), String(s.count)]) row.append(node('td', text)); body.append(row); }
      table.append(body); wrap.append(table); container.append(wrap);
      for (const phase of report.environmentByPhase || []) container.append(node('p', `${phase.phase}: ` + phase.readings.map(s => `${s.name} sample mean ${num(s.sampleMean)} ${s.unit || ''} (${s.count} readings)`).join(' · '), 'muted'));
      const spread = report.probeComparison;
      container.append(node('p', `Between-probe moisture spread: mean ${num(spread.meanMoistureSpreadPoints)} points, maximum ${num(spread.maxMoistureSpreadPoints)} points across ${spread.simultaneousSamples} simultaneous captures.`));
      for (const p of report.probes) {
        const detail = node('details'), label = node('summary', `Probe ${p.probe}: lights-off drying & logged irrigation responses`); detail.append(label);
        if (!p.lightsOffSegments.length) detail.append(node('p', 'Not enough continuous lights-off readings to calculate a drying segment.'));
        for (const s of p.lightsOffSegments) detail.append(node('p', `${date(s.start)}–${date(s.end)}: moisture fell ${num(s.moistureDropPoints)} points over ${num(s.durationHours)} hours (${num(s.pointsPerHour)} points/hour). This is a recorded segment, not necessarily a full overnight period.`));
        detail.append(node('p', `${p.moistureRises.length} unconfirmed moisture rises of at least 0.5 points between adjacent readings. These are not recorded as watering events.`));
        if (!p.eventResponses.length) detail.append(node('p', 'No logged irrigation events to compare.'));
        for (const e of p.eventResponses) detail.append(node('p', `${date(e.at)}: ${e.changePoints === null ? 'Not enough adjacent readings yet' : `moisture change ${num(e.changePoints)} points; association only`}.`));
        container.append(detail);
      }
      const limits = node('ul'); for (const text of report.limitations) limits.append(node('li', text)); container.append(limits);
    }
    const list = byId('irrigationEvents'); list.replaceChildren();
    if (!data.events.length) list.append(node('p', 'No events logged yet.'));
    for (const e of data.events) {
      const item = node('article', undefined, 'event-entry');
      item.append(node('strong', `${date(e.occurredAt)} · ${e.kind === 'irrigation' ? 'Irrigation' : 'Change'} · ${e.probe === null ? 'Whole room' : `Probe ${e.probe}`}`));
      const values = [[e.durationSeconds, 'seconds'], [e.volumeLiters, 'L applied total'], [e.feedEc, 'feed EC (mS/cm)'], [e.runoffLiters, 'L runoff total']].filter(([v]) => v !== null).map(([v, unit]) => `${num(v)} ${unit}`);
      if (values.length) item.append(node('p', values.join(' · ')));
      if (e.note) item.append(node('p', e.note)); list.append(item);
    }
  }
  async function load(auth, preview = false) {
    credentials = auth; if (!auth || loading) return;
    const requestGeneration = generation;
    loading = true; byId('learningRefresh').disabled = true;
    try { const data = await call(preview ? '?view=preview' : ''); if (requestGeneration !== generation) return; render(data); byId('eventForm').hidden = false; }
    catch (error) { if (requestGeneration === generation) byId('learningStatus').textContent = error.message; }
    finally { if (requestGeneration === generation) { loading = false; byId('learningRefresh').disabled = false; } }
  }
  function reset() { generation++; loading = false; credentials = ''; pendingId = pendingPayload = null; byId('learningRefresh').disabled = false; byId('learningStats').replaceChildren(); byId('learningReport').replaceChildren(); byId('irrigationEvents').replaceChildren(); byId('eventForm').hidden = true; byId('eventForm').reset(); setNow(); byId('eventMessage').textContent = ''; byId('learningStatus').textContent = 'Connect your dashboard to view learning and log events.'; }
  function setNow() { const d = new Date(); byId('eventAt').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  setNow(); byId('eventTimezone').textContent = `Event entry uses your device timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Reports display New York time.`;
  byId('learningRefresh').onclick = () => load(credentials, true);
  byId('eventForm').addEventListener('input', () => { pendingId = pendingPayload = null; });
  byId('eventForm').onsubmit = async event => {
    event.preventDefault(); if (!credentials) return;
    const requestGeneration = generation;
    const value = id => byId(id).value === '' ? null : Number(byId(id).value);
    if (!pendingPayload) pendingPayload = { id: pendingId || crypto.randomUUID(), kind: byId('eventKind').value,
      occurredAt: new Date(byId('eventAt').value).toISOString(), probe: value('eventProbe'), durationSeconds: value('eventDuration'),
      volumeLiters: value('eventVolume'), feedEc: value('eventFeed'), runoffLiters: value('eventRunoff'), note: byId('eventNote').value };
    pendingId = pendingPayload.id; byId('eventSave').disabled = true; byId('eventMessage').textContent = 'Saving…';
    try { const result = await call('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pendingPayload) });
      if (requestGeneration !== generation) return;
      byId('eventMessage').textContent = result.duplicate ? 'This event was already saved. No duplicate added.' : 'Event saved.';
      pendingId = pendingPayload = null; byId('eventForm').reset(); setNow(); await load(credentials, true);
    } catch (error) { if (requestGeneration === generation) byId('eventMessage').textContent = error.message; }
    finally { byId('eventSave').disabled = false; }
  };
  return { load, reset };
})();
