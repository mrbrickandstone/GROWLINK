const crypto = require('node:crypto');
const cfg = require('../config.cjs');
const PREFIX = 'growlink:farber:learning:v2';
const LEGACY = 'growlink:farber:monitor:v1';
const SLOT = 300000, DAY = 86400000;

function makeStore(env, fetcher = fetch) {
  const endpoint = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!endpoint || !token) throw new Error('Learning storage is not configured');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid storage endpoint');
  return async command => {
    const res = await fetcher(url.origin, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('Learning storage unavailable');
    const body = await res.json();
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error('Learning storage unavailable');
    return body.result;
  };
}

// Runs under the monitor lock. Archive legacy observations once, then atomically
// start and append a separate baseline. Duplicate five-minute buckets do not count twice.
const CAPTURE = `
local p=KEYS[1]
if redis.call('EXISTS',p..':legacy')==0 then
 redis.call('SET',p..':legacy',cjson.encode({state=redis.call('GET',KEYS[2]..':state'),baseline=redis.call('LRANGE',KEYS[2]..':baseline',0,-1),samples=redis.call('LRANGE',KEYS[2]..':samples',0,-1),archivedAt=ARGV[1]}))
end
local raw=redis.call('GET',p..':meta')
local now=tonumber(ARGV[1]); local bucket=ARGV[3]; local valid=ARGV[2]=='1'
local m
if raw then m=cjson.decode(raw) elseif valid then
 m={startedAt=now,endsAt=now+604800000,captures=0,completeCaptures=0,totalCaptures=0,longestGapMs=0,version=2}
else return cjson.encode({startedAt=cjson.null,waitingForFreshData=true}) end
local added=redis.call('HSETNX',p..':samples',bucket,ARGV[4])
redis.call('ZADD',p..':index',tonumber(bucket),bucket)
if added==1 then
 m.totalCaptures=m.totalCaptures+1
 if m.lastObservedAt then m.longestGapMs=math.max(m.longestGapMs,now-m.lastObservedAt) end
 m.lastObservedAt=now
 if valid then m.lastCompleteAt=now end
 if now<m.endsAt then
  redis.call('HSET',p..':baseline',bucket,ARGV[4]); m.captures=m.captures+1
  if valid then m.completeCaptures=m.completeCaptures+1 end
 end
end
local old=redis.call('ZRANGEBYSCORE',p..':index','-inf',tonumber(bucket)-8640)
for _,b in ipairs(old) do redis.call('HDEL',p..':samples',b); redis.call('ZREM',p..':index',b) end
redis.call('SET',p..':meta',cjson.encode(m))
return cjson.encode(m)`;

async function recordCapture({ command, snapshot, valid, now }) {
  return JSON.parse(await command(['EVAL', CAPTURE, '2', PREFIX, LEGACY,
    String(now), valid ? '1' : '0', String(Math.floor(now / SLOT)), JSON.stringify(snapshot)]));
}
function localParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const v = type => parts.find(p => p.type === type).value;
  return { date: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')) };
}
function phaseAt(now) { const h = localParts(now).hour; return h >= 23 || h < 11 ? 'scheduled lights on' : 'scheduled lights off'; }
function parseRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap(row => { try { return [typeof row === 'string' ? JSON.parse(row) : row]; } catch { return []; } });
}
async function readSnapshots(command, start, end) {
  const keys = await command(['ZRANGEBYSCORE', `${PREFIX}:index`, String(Math.floor(start / SLOT)), String(Math.floor(end / SLOT))]);
  const current = keys.length ? parseRows(await command(['HMGET', `${PREFIX}:samples`, ...keys])) : [];
  const legacyRaw = await command(['GET', `${PREFIX}:legacy`]);
  const legacy = legacyRaw ? JSON.parse(legacyRaw) : {};
  return [...parseRows(legacy.samples), ...current].filter(x => x && Date.parse(x.at) >= start && Date.parse(x.at) <= end);
}
function sensorPoints(rows, id) {
  return rows.flatMap(row => {
    const sample = row.samples?.find(s => s.id === id), t = Date.parse(sample?.timestamp), at = Date.parse(row.at);
    return typeof sample?.value === 'number' && Number.isFinite(sample.value) && Number.isFinite(t) &&
      at - t <= SLOT && t - at <= 60000 ? [{ at, t, value: sample.value, unit: sample.unit || '' }] : [];
  });
}
function summary(points) {
  if (!points.length) return { count: 0, min: null, max: null, sampleMean: null, first: null, last: null, unit: '' };
  const values = points.map(p => p.value);
  return { count: points.length, min: Math.min(...values), max: Math.max(...values),
    sampleMean: values.reduce((a, b) => a + b, 0) / values.length,
    first: points[0].value, last: points.at(-1).value, unit: points.at(-1).unit };
}
function normalizeSnapshots(raw, start, end) {
  const map = new Map();
  for (const row of raw) {
    const at = Date.parse(row?.at);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const b = Math.floor(at / SLOT), previous = map.get(b);
    if (!previous || Date.parse(previous.at) < at) map.set(b, row);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function phaseDryback(points) {
  const intervals = [];
  let current = null;
  for (const p of points) {
    const phase = phaseAt(p.at);
    if (!current || p.at - current.last.at > 2 * SLOT || phase !== current.phase) {
      if (current) intervals.push(current);
      current = { phase, first: p, last: p, points: 1 };
    } else { current.last = p; current.points++; }
  }
  if (current) intervals.push(current);
  return intervals.filter(x => x.phase === 'scheduled lights off' && x.points >= 2).map(x => ({
    start: new Date(x.first.at).toISOString(), end: new Date(x.last.at).toISOString(),
    durationHours: (x.last.at - x.first.at) / 3600000,
    moistureDropPoints: x.first.value - x.last.value,
    pointsPerHour: (x.first.value - x.last.value) / ((x.last.at - x.first.at) / 3600000),
    samples: x.points, interpretation: 'Observed net moisture change; watering during this segment can affect it.'
  }));
}
function analyze({ snapshots, events = [], now, baseline }) {
  const start = now - DAY, rows = normalizeSnapshots(snapshots, start, now);
  const expected = Math.floor(now / SLOT) - Math.floor(start / SLOT) + 1;
  const complete = rows.filter(row => cfg.sensors.every(s => sensorPoints([row], s[0]).length === 1));
  const times = rows.map(r => Date.parse(r.at));
  const boundaries = [start, ...times, now];
  const longestGapMs = Math.max(...boundaries.slice(1).map((t, i) => t - boundaries[i]));
  const coverage = Math.min(100, complete.length / expected * 100);
  const observations = cfg.sensors.map(([id, name, group]) => ({ id, name, group, ...summary(sensorPoints(rows, id)) }));
  const probes = [...new Set(cfg.sensors.map(s => s[2]).filter(Number.isInteger))].map(probe => {
    const spec = name => cfg.sensors.find(s => s[2] === probe && s[1] === name);
    const moisture = sensorPoints(rows, spec('Moisture')[0]), ec = sensorPoints(rows, spec('EC')[0]);
    const rises = moisture.slice(1).flatMap((p, i) => {
      const previous = moisture[i], change = p.value - previous.value;
      return p.at - previous.at <= 2 * SLOT && change >= 0.5 ? [{ at: new Date(p.at).toISOString(), changePoints: change,
        interpretation: 'Moisture rise; irrigation is unconfirmed unless logged.' }] : [];
    });
    const responses = events.filter(e => (e.probe === null || e.probe === probe) && e.kind === 'irrigation').map(e => {
      const t = Date.parse(e.occurredAt);
      const before = moisture.filter(p => p.at <= t && t - p.at <= 2 * SLOT).at(-1);
      const after = moisture.find(p => p.at > t && p.at - t <= 3 * SLOT);
      return { eventId: e.id, at: e.occurredAt, before: before?.value ?? null, after: after?.value ?? null,
        changePoints: before && after ? after.value - before.value : null,
        status: before && after ? 'observed association; not proof of cause' : 'insufficient adjacent readings' };
    });
    return { probe, moisture: summary(moisture), ec: summary(ec), lightsOffSegments: phaseDryback(moisture),
      moistureRises: rises.slice(-50), eventResponses: responses };
  });
  const comparisons = rows.flatMap(row => {
    const values = cfg.sensors.filter(s => Number.isInteger(s[2]) && s[1] === 'Moisture').map(s => sensorPoints([row], s[0])[0]?.value);
    return values.length >= 2 && values.every(Number.isFinite) ? [Math.max(...values) - Math.min(...values)] : [];
  });
  const limits = ['Report describes recorded samples; it does not infer applied water volume, runoff, plant uptake, yield, or causation.',
    'Substrate EC is the sensor reading; calibration and pore-water EC conversion are not verified.',
    'Light-phase labels follow the 11 p.m.–11 a.m. New York schedule, not verified equipment state.',
    'Earlier sampling gaps are not filled or interpolated.'];
  if (coverage < 90) limits.unshift('Incomplete 24-hour coverage: sample means and extrema may not represent the full day.');
  if (!events.length) limits.unshift('No irrigation or change events were logged for this period; log them to compare responses.');
  const ageHours = baseline?.startedAt ? (now - baseline.startedAt) / 3600000 : 0;
  const findings = [`${complete.length} complete captures out of ${expected} expected in the last 24 hours (${coverage.toFixed(1)}% coverage).`];
  for (const p of probes) {
    if (p.ec.count >= 2) findings.push(`Probe ${p.probe}: recorded EC changed from ${p.ec.first.toFixed(2)} to ${p.ec.last.toFixed(2)} between the first and last available readings; this is not a feed-EC measurement.`);
    for (const segment of p.lightsOffSegments.slice(-1)) findings.push(`Probe ${p.probe}: the latest continuous scheduled-lights-off segment shows a ${segment.moistureDropPoints.toFixed(2)}-point net moisture drop over ${segment.durationHours.toFixed(2)} hours.`);
  }
  const environmentByPhase = ['scheduled lights on', 'scheduled lights off'].map(phase => ({ phase,
    readings: cfg.sensors.filter(s => s[2] === 'climate').map(([id, name]) => ({ name,
      ...summary(sensorPoints(rows.filter(row => phaseAt(Date.parse(row.at)) === phase), id)) })) }));
  return { version: 1, generatedAt: new Date(now).toISOString(), date: localParts(now).date,
    period: { start: new Date(start).toISOString(), end: new Date(now).toISOString(), hours: 24 },
    coverage: { expected, captured: rows.length, complete: complete.length, percent: coverage, longestGapMs,
      firstCaptureAt: rows[0]?.at || null, lastCaptureAt: rows.at(-1)?.at || null },
    readiness: ageHours < 48 ? 'Collecting baseline — preliminary comparisons need at least 48 hours.' :
      coverage < 90 ? 'Coverage needs review before drawing conclusions.' :
      ageHours < 168 ? 'Preliminary descriptive trends available; seven-day baseline is still collecting.' : 'Seven-day window elapsed; review full baseline coverage before recommendations.',
    baseline, observations, environmentByPhase, findings, probes, events,
    probeComparison: { simultaneousSamples: comparisons.length,
      meanMoistureSpreadPoints: comparisons.length ? comparisons.reduce((a, b) => a + b, 0) / comparisons.length : null,
      maxMoistureSpreadPoints: comparisons.length ? Math.max(...comparisons) : null },
    limitations: limits, recommendations: [], method: 'Descriptive calculations from stored readings; no AI model or equipment controls.' };
}

async function eventsBetween(command, start, end) {
  const ids = await command(['ZRANGEBYSCORE', `${PREFIX}:event-index`, String(start), String(end)]);
  return ids.length ? parseRows(await command(['HMGET', `${PREFIX}:events`, ...ids])) : [];
}
async function buildReport(command, now, baseline) {
  const [snapshots, events] = await Promise.all([readSnapshots(command, now - DAY, now), eventsBetween(command, now - DAY, now)]);
  return analyze({ snapshots, events, now, baseline });
}
async function saveDailyReport(command, now, baseline) {
  const local = localParts(now);
  if (local.hour < 7) return { saved: false, reason: 'before daily report hour' };
  const key = `${PREFIX}:report:${local.date}`;
  if (await command(['EXISTS', key])) return { saved: false, reason: 'already saved today' };
  const report = await buildReport(command, now, baseline);
  const saved = await command(['EVAL', `if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',7776000) then redis.call('SET',KEYS[2],ARGV[1]); return 1 else return 0 end`,
    '2', key, `${PREFIX}:latest-report`, JSON.stringify(report)]);
  const stored = JSON.parse(await command(['GET', key]) || 'null');
  if (!stored || stored.date !== local.date || (saved === 1 && stored.generatedAt !== report.generatedAt)) throw new Error('Report persistence verification failed');
  return { saved: saved === 1, verified: true, date: local.date, complete: stored.coverage.complete, coveragePercent: stored.coverage.percent };
}
function validateEvent(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid event');
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(input.id || '')) throw new Error('A valid event ID is required');
  if (!['irrigation', 'change'].includes(input.kind)) throw new Error('Choose irrigation or change');
  const at = Date.parse(input.occurredAt);
  if (!Number.isFinite(at) || !/[zZ]$|[+-]\d\d:\d\d$/.test(input.occurredAt) || at > now + 60000 || at < now - 30 * DAY) throw new Error('Choose an event time within the past 30 days, with a timezone');
  const probe = input.probe === null || input.probe === undefined || input.probe === '' ? null : Number(input.probe);
  if (probe !== null && !cfg.sensors.some(s => s[2] === probe)) throw new Error('Choose a configured probe or the whole room');
  const numeric = (key, max) => {
    const v = input[key];
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error(`Invalid ${key}`);
    return v;
  };
  const note = input.note || '';
  if (typeof note !== 'string' || note.length > 1000) throw new Error('Notes must be 1,000 characters or fewer');
  if (input.kind === 'change' && !note.trim()) throw new Error('Describe the change');
  return { id: input.id, kind: input.kind, occurredAt: new Date(at).toISOString(), probe,
    durationSeconds: numeric('durationSeconds', 86400), volumeLiters: numeric('volumeLiters', 1000000),
    feedEc: numeric('feedEc', 100), runoffLiters: numeric('runoffLiters', 1000000),
    note: note.trim(), source: 'manual entry', recordedAt: new Date(now).toISOString() };
}
async function saveEvent(command, event) {
  const payload = JSON.stringify(event);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...event, recordedAt: null })).digest('hex');
  const result = await command(['EVAL', `local previous=redis.call('HGET',KEYS[1],ARGV[1]); if previous then if previous==ARGV[4] then return 0 else return -1 end end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[4]); redis.call('HSET',KEYS[2],ARGV[1],ARGV[2]); redis.call('ZADD',KEYS[3],ARGV[3],ARGV[1]); return 1`,
    '3', `${PREFIX}:event-hashes`, `${PREFIX}:events`, `${PREFIX}:event-index`, event.id, payload, String(Date.parse(event.occurredAt)), fingerprint]);
  if (result === -1) { const error = new Error('This event ID is already used for a different entry'); error.status = 409; throw error; }
  const stored = result === 0 ? JSON.parse(await command(['HGET', `${PREFIX}:events`, event.id])) : event;
  return { saved: result === 1, duplicate: result === 0, event: stored };
}
async function getStatus(command, now) {
  const raw = await command(['GET', `${PREFIX}:meta`]);
  const baseline = raw ? JSON.parse(raw) : null;
  if (baseline) {
    baseline.expectedCaptures = Math.max(1, Math.floor(Math.min(now, baseline.endsAt - 1) / SLOT) - Math.floor(baseline.startedAt / SLOT) + 1);
    baseline.coveragePercent = Math.min(100, baseline.completeCaptures / baseline.expectedCaptures * 100);
    baseline.windowElapsed = now >= baseline.endsAt;
    baseline.lastCaptureAgeMs = baseline.lastObservedAt ? now - baseline.lastObservedAt : null;
    baseline.stale = !baseline.lastCompleteAt || now - baseline.lastCompleteAt > 2 * SLOT || baseline.lastCompleteAt > now + 60000;
  }
  return { baseline, latestReport: JSON.parse(await command(['GET', `${PREFIX}:latest-report`]) || 'null'),
    events: (await eventsBetween(command, now - 30 * DAY, now)).slice(-100).reverse(),
    legacyArchived: !!(await command(['EXISTS', `${PREFIX}:legacy`])),
    fetchedAt: new Date(now).toISOString(), sensorCount: cfg.sensors.length };
}
module.exports = { PREFIX, LEGACY, SLOT, DAY, makeStore, recordCapture, localParts, phaseAt,
  analyze, validateEvent, saveEvent, getStatus, buildReport, saveDailyReport };
