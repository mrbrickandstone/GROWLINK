const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('./config.cjs');
const { inspect, transition, readSettings, runMonitor } = require('./lib/monitor.cjs');
const now = Date.parse('2026-10-08T05:00:00Z');
const fresh = time => ({ sensorData: cfg.sensors.map(s => ({ sensorId: s[0], value: 40,
  timestamp: new Date(time).toISOString(), suffix: '%' })) });
const env = { CRON_SECRET: 'mock-cron', GROWLINK_API_KEY: 'mock-growlink',
  UPSTASH_REDIS_REST_URL: 'https://test.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'mock-redis',
  RESEND_API_KEY: 'mock-resend', ALERT_FROM: 'Monitor <monitor@example.com>', ALERT_TO: 'recipient@example.com' };

test('freshness handles missing data, invalid values, future clocks, and UTC timestamps', () => {
  const data = fresh(now);
  assert.equal(inspect(data, {}, now).issues.length, 0);
  data.sensorData[0].timestamp = '2026-10-08T04:00:00';
  data.sensorData[1].value = '40';
  data.sensorData[2].timestamp = new Date(now + 120000).toISOString();
  data.sensorData.pop();
  const result = inspect(data, {}, now);
  assert.equal(result.issues.length, 4);
  assert.equal(result.snapshot.phase, 'lights-on schedule');
  assert.equal(result.snapshot.samples.length, 16);
});

test('limits require valid allowlisted sensor ranges; defaults do not invent targets', () => {
  assert.deepEqual(readSettings(env).ranges, {});
  assert.throws(() => readSettings({ ...env, MONITOR_RANGES_JSON: '{"unknown":{"min":1,"max":2}}' }));
  assert.throws(() => readSettings({ ...env, UPSTASH_REDIS_REST_URL: 'https://example.com' }));
  const ranges = { [cfg.sensors[0][0]]: { min: 41, max: 50 } };
  assert.equal(inspect(fresh(now), ranges, now).issues[0].code, `${cfg.sensors[0][0]}:low`);
});

test('alerts and recoveries require persistence; duplicate calls do not advance confirmation', () => {
  const issues = [{ code: 'sensor:stale', message: 'Sensor stale' }];
  let state = transition(null, issues, now);
  for (let i = 0; i < 10; i++) state = transition(state, issues, now);
  assert.equal(state.pending, undefined);
  state = transition(state, issues, now + 300000);
  assert.match(state.pending.text, /ALERT: Sensor stale/);
  delete state.pending;
  state = transition(state, issues, now + 600000);
  assert.equal(state.pending, undefined);
  state = transition(state, [], now + 900000);
  assert.equal(state.pending, undefined);
  state = transition(state, [], now + 1200000);
  assert.match(state.pending.text, /RECOVERED: Sensor stale/);
});

test('upstream outage cannot clear sensor incidents or count as recovery observation', () => {
  let state = transition(null, [{ code: 'sensor:stale', message: 'Sensor stale' }], now);
  state = transition(state, [{ code: 'sensor:stale', message: 'Sensor stale' }], now + 300000);
  delete state.pending;
  state = transition(state, [], now + 600000);
  state = transition(state, [{ code: 'upstream', message: 'Unavailable' }], now + 900000, false);
  state = transition(state, [], now + 1200000);
  assert.equal(state.incidents['sensor:stale'].active, true);
  assert.equal(state.pending, undefined);
});

function harness() {
  const keys = new Map(), emails = [], snapshots = [];
  let data = fresh(now), failMail = false;
  const ok = body => ({ ok: true, json: async () => body });
  async function fetcher(url, options) {
    if (url === env.UPSTASH_REDIS_REST_URL) {
      const [op, key, ...args] = JSON.parse(options.body);
      if (op === 'GET') return ok({ result: keys.get(key) || null });
      if (op === 'SET') {
        if (args.includes('NX') && keys.has(key)) return ok({ result: null });
        keys.set(key, args[0]);
        return ok({ result: 'OK' });
      }
      if (op === 'EVAL') {
        const [count, name, value] = args;
        assert.equal(count, '1');
        if (key.includes('RPUSH')) snapshots.push(JSON.parse(value));
        else if (keys.get(name) === value) keys.delete(name);
        return ok({ result: 1 });
      }
      throw new Error(`Unexpected Redis command ${op}`);
    }
    if (url.startsWith('https://api.developer.growlink.com/')) {
      assert.equal(options.headers['Gl-Api-Key'], 'mock-growlink');
      assert.equal(JSON.parse(options.body).sensorIds.length, 16);
      return ok(data);
    }
    if (url === 'https://api.resend.com/emails') {
      emails.push({ key: options.headers['Idempotency-Key'], body: options.body });
      if (failMail) return { ok: false };
      return ok({ id: 'mock-email' });
    }
    throw new Error('Unexpected host');
  }
  return { keys, emails, snapshots, fetcher, setData: value => { data = value; },
    failMail: value => { failMail = value; } };
}

test('persisted pending email retries with identical body/key and subsequent run avoids duplicates', async () => {
  const h = harness();
  h.setData({ sensorData: [] });
  await runMonitor({ env, fetcher: h.fetcher, now });
  h.failMail(true);
  await assert.rejects(runMonitor({ env, fetcher: h.fetcher, now: now + 300000 }));
  h.failMail(false);
  await runMonitor({ env, fetcher: h.fetcher, now: now + 600000 });
  assert.equal(h.emails.length, 2);
  assert.deepEqual(h.emails[0], h.emails[1]);
  assert(!h.emails[0].body.includes('mock-growlink'));
  await runMonitor({ env, fetcher: h.fetcher, now: now + 900000 });
  assert.equal(h.emails.length, 2);
  assert.equal(h.snapshots.length, 4);
});

test('distributed lock blocks overlap before any telemetry/email operations', async () => {
  const h = harness();
  h.keys.set('growlink:farber:monitor:v1:lock', 'other-run');
  const result = await runMonitor({ env, fetcher: h.fetcher, now });
  assert.equal(result.skipped, 'already running');
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.emails.length, 0);
});

test('unauthorized monitor requests cannot run; configured endpoint stays disabled by default', async () => {
  const handler = require('./api/monitor.js');
  const original = process.env.CRON_SECRET, enabled = process.env.MONITOR_ENABLED;
  process.env.CRON_SECRET = 'mock-cron';
  delete process.env.MONITOR_ENABLED;
  const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; },
    json(body) { this.body = body; return this; } });
  try {
    let res = response();
    await handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.code, 401);
    res = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer mock-cron' } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { enabled: false });
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
    if (enabled === undefined) delete process.env.MONITOR_ENABLED; else process.env.MONITOR_ENABLED = enabled;
  }
});
