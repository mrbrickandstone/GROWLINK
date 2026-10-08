const crypto = require('node:crypto');
const cfg = require('../config.cjs');
const PREFIX = 'growlink:farber:monitor:v1';
const CONFIRM_MS = 5 * 60 * 1000;

function timestamp(value) {
  if (typeof value !== 'string' || !value) return NaN;
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z');
}

function readSettings(env) {
  const mode = env.MONITOR_MODE || 'learn';
  const redisEndpoint = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!['learn', 'alerts'].includes(mode)) throw new Error('Invalid monitor mode');
  if (!redisEndpoint || !redisToken) throw new Error('Monitor storage configuration incomplete');
  for (const name of ['CRON_SECRET', 'GROWLINK_API_KEY',
    ...(mode === 'alerts' ? ['RESEND_API_KEY', 'ALERT_FROM', 'ALERT_TO'] : [])]) {
    if (!env[name]) throw new Error('Monitor configuration incomplete');
  }
  const redisUrl = new URL(redisEndpoint);
  if (redisUrl.protocol !== 'https:' || !redisUrl.hostname.endsWith('.upstash.io') ||
    redisUrl.username || redisUrl.password || redisUrl.search || redisUrl.hash || redisUrl.pathname !== '/') {
    throw new Error('Invalid Redis URL');
  }
  if (mode === 'alerts' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ALERT_TO) || /[\r\n]/.test(env.ALERT_FROM))) {
    throw new Error('Invalid email configuration');
  }
  const ranges = JSON.parse(env.MONITOR_RANGES_JSON || '{}');
  if (!ranges || Array.isArray(ranges) || typeof ranges !== 'object') throw new Error('Invalid ranges');
  const ids = new Set(cfg.sensors.map(s => s[0]));
  for (const [id, range] of Object.entries(ranges)) {
    if (!ids.has(id) || !range || Array.isArray(range) ||
      !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max) {
      throw new Error('Invalid sensor range');
    }
  }
  return { mode, redisUrl: redisUrl.origin, redisToken, ranges, to: env.ALERT_TO, from: env.ALERT_FROM };
}

function inspect(data, ranges, now) {
  if (!Array.isArray(data?.sensorData)) throw new Error('Invalid Growlink response');
  const rows = new Map(data.sensorData.map(row => [row.sensorId, row]));
  const issues = [], samples = [];
  for (const [id, name, group] of cfg.sensors) {
    const label = group === 'climate' ? name : `Probe ${group} ${name}`;
    const row = rows.get(id), t = timestamp(row?.timestamp);
    const value = typeof row?.value === 'number' && Number.isFinite(row.value) ? row.value : null;
    samples.push({ id, value, timestamp: Number.isFinite(t) ? new Date(t).toISOString() : null });
    if (value === null || !Number.isFinite(t) || now - t > 300000 || t - now > 60000) {
      issues.push({ code: `${id}:stale`, message: `${label}: missing, stale, or invalid sensor data.` });
      continue;
    }
    const range = ranges[id];
    if (range && (value < range.min || value > range.max)) {
      issues.push({ code: `${id}:${value < range.min ? 'low' : 'high'}`,
        message: `${label}: ${value} ${typeof row.suffix === 'string' ? row.suffix.slice(0, 20) : ''}; configured range ${range.min}–${range.max}.` });
    }
  }
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
  return { issues, snapshot: { at: new Date(now).toISOString(),
    phase: hour >= 23 || hour < 11 ? 'lights-on schedule' : 'lights-off schedule', samples } };
}

// Each incident must remain in the same state for five minutes before notification.
// Repeated invocations at the same time cannot satisfy the persistence check.
function transition(state, issues, now, hasSensorData = true) {
  const next = structuredClone(state || { incidents: {} });
  if (!next.incidents || typeof next.incidents !== 'object') throw new Error('Invalid monitor state');
  if (next.pending) return next;
  const present = new Map(issues.map(issue => [issue.code, issue]));
  const changes = [];
  for (const code of new Set([...Object.keys(next.incidents), ...present.keys()])) {
    if (!hasSensorData && code !== 'upstream') {
      next.incidents[code].interrupted = true;
      continue;
    }
    const desired = present.has(code);
    const previous = next.incidents[code] || { active: false };
    if (previous.desired !== desired || previous.interrupted) {
      previous.desired = desired;
      previous.since = now;
      delete previous.interrupted;
    }
    if (desired) previous.message = present.get(code).message;
    if (previous.active !== desired && now - previous.since >= CONFIRM_MS) {
      previous.active = desired;
      changes.push(`${desired ? 'ALERT' : 'RECOVERED'}: ${previous.message}`);
    }
    next.incidents[code] = previous;
    if (!desired && !previous.active) delete next.incidents[code];
  }
  if (changes.length) next.pending = {
    id: crypto.randomUUID(), createdAt: now,
    subject: 'Farber Growlink monitoring update',
    text: `Farber · INTERM FLOWERING\nObserved ${new Date(now).toISOString()}\n\n${changes.join('\n')}\n\nMonitoring only. No controller settings were changed.`
  };
  next.lastCheckedAt = now;
  return next;
}

async function redis(command, env, settings, fetcher) {
  const response = await fetcher(settings.redisUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${settings.redisToken}`,
      'Content-Type': 'application/json' }, body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000), redirect: 'error'
  });
  if (!response.ok) throw new Error('Monitor storage unavailable');
  const data = await response.json();
  if (data.error || !Object.hasOwn(data, 'result')) throw new Error('Monitor storage error');
  return data.result;
}

async function deliver(pending, env, fetcher, now) {
  // Resend keeps idempotency keys for 24 hours; stop automatic retries before expiry.
  if (now - pending.createdAt >= 23 * 3600000) throw new Error('Email delivery requires reconciliation');
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json', 'Idempotency-Key': `growlink/${pending.id}` },
    body: JSON.stringify(pending.payload), signal: AbortSignal.timeout(8000), redirect: 'error'
  });
  if (!response.ok || typeof (await response.json()).id !== 'string') throw new Error('Email delivery unavailable');
}

async function runMonitor({ env = process.env, fetcher = fetch, now = Date.now() } = {}) {
  const settings = readSettings(env), owner = crypto.randomUUID();
  const command = args => redis(args, env, settings, fetcher);
  if (await command(['SET', `${PREFIX}:lock`, owner, 'NX', 'EX', '120']) !== 'OK') {
    return { skipped: 'already running' };
  }
  try {
    const stored = await command(['GET', `${PREFIX}:state`]);
    let state = stored ? JSON.parse(stored) : { incidents: {} };
    let acceptedEmails = 0;
    async function sendPending() {
      if (!state.pending) return;
      await deliver(state.pending, env, fetcher, now);
      delete state.pending;
      await command(['SET', `${PREFIX}:state`, JSON.stringify(state)]);
      acceptedEmails++;
    }
    if (settings.mode === 'alerts') await sendPending();
    let observation, hasSensorData = false;
    try {
      const org = encodeURIComponent(env.GROWLINK_ORG_ID || cfg.orgId);
      const response = await fetcher(`https://api.developer.growlink.com/api/v2/organization/${org}/sensors/data/live`, {
        method: 'POST', headers: { 'Gl-Api-Key': env.GROWLINK_API_KEY, 'Content-Type': 'application/json',
          Accept: 'application/json', 'Uom-Temp': '1', 'Uom-Vpd': '8', 'Uom-Tds': '6', 'Uom-Light': '16', 'Uom-Volume': '42' },
        body: JSON.stringify({ sensorIds: cfg.sensors.map(s => s[0]) }),
        signal: AbortSignal.timeout(15000), redirect: 'error'
      });
      if (!response.ok) throw new Error('Growlink unavailable');
      observation = inspect(await response.json(), settings.ranges, now);
      hasSensorData = true;
    } catch {
      observation = { issues: [{ code: 'upstream', message: 'Growlink could not return valid live data.' }],
        snapshot: { at: new Date(now).toISOString(), unavailable: true } };
    }
    // An atomic append/trim keeps 2,016 recent samples (seven days at five-minute cadence).
    await command(['EVAL', "redis.call('RPUSH',KEYS[1],ARGV[1]); redis.call('LTRIM',KEYS[1],-2016,-1); redis.call('EXPIRE',KEYS[1],604800); return 1", '1', `${PREFIX}:samples`, JSON.stringify(observation.snapshot)]);
    if (settings.mode === 'learn') {
      // The baseline begins on the first capture with all configured sensors fresh.
      // Freeze it after seven elapsed days; keep later readings in the rolling sample list.
      const valid = hasSensorData && !observation.issues.some(issue => issue.code.endsWith(':stale'));
      if (!state.learning && valid) state.learning = { startedAt: now, endsAt: now + 7 * 86400000,
        captures: 0, completeCaptures: 0, longestGapMs: 0, previousCaptureAt: null };
      const learning = state.learning;
      if (learning && now <= learning.endsAt && learning.lastBucket !== Math.floor(now / 300000)) {
        await command(['EVAL', "redis.call('RPUSH',KEYS[1],ARGV[1]); redis.call('LTRIM',KEYS[1],-2500,-1); redis.call('EXPIRE',KEYS[1],2592000); return 1", '1', `${PREFIX}:baseline`, JSON.stringify(observation.snapshot)]);
        learning.captures++;
        if (valid) learning.completeCaptures++;
        if (learning.previousCaptureAt !== null) learning.longestGapMs = Math.max(learning.longestGapMs, now - learning.previousCaptureAt);
        learning.previousCaptureAt = now;
        learning.lastBucket = Math.floor(now / 300000);
      }
      state.lastCheckedAt = now;
      await command(['SET', `${PREFIX}:state`, JSON.stringify(state)]);
      return { mode: 'learn', validData: hasSensorData, issues: observation.issues.length,
        learning: learning ? { ...learning, windowElapsed: now >= learning.endsAt } : { startedAt: null },
        acceptedEmails: 0 };
    }
    state = transition(state, observation.issues, now, hasSensorData);
    if (state.pending) state.pending.payload = {
      from: settings.from, to: [settings.to], subject: state.pending.subject, text: state.pending.text
    };
    // Save the exact email payload before sending, so retries use identical content and key.
    await command(['SET', `${PREFIX}:state`, JSON.stringify(state)]);
    await sendPending();
    return { checked: cfg.sensors.length, validData: hasSensorData,
      activeIncidents: Object.values(state.incidents).filter(i => i.active).length, acceptedEmails };
  } finally {
    await command(['EVAL', "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", '1', `${PREFIX}:lock`, owner]);
  }
}

module.exports = { timestamp, readSettings, inspect, transition, runMonitor };
