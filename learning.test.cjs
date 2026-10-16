const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const cfg = require('./config.cjs');
const { PREFIX, LEGACY, SLOT, DAY, recordCapture, analyze, validateEvent, saveEvent,
  saveDailyReport, getStatus, phaseAt, makeStore } = require('./lib/learning.cjs');
const now = Date.parse('2026-10-16T16:00:00Z');
const snapshot = (at, moisture = 40, missing = false) => ({ at: new Date(at).toISOString(),
  samples: cfg.sensors.filter((s, i) => !missing || i !== 0).map(([id, name, group]) => ({ id,
    value: name === 'Moisture' ? moisture + group : name === 'EC' ? 3 : 50,
    timestamp: new Date(at).toISOString(), unit: name === 'Moisture' ? '%' : '' })) });

test('coverage deduplicates time buckets, excludes future/stale values and exposes real gaps', () => {
  const old = snapshot(now - 2 * SLOT), recent = snapshot(now), stale = snapshot(now - SLOT);
  stale.samples[0].timestamp = new Date(now - DAY).toISOString();
  const report = analyze({ snapshots: [old, old, stale, recent, snapshot(now + SLOT)], now });
  assert.equal(report.coverage.captured, 3);
  assert.equal(report.coverage.complete, 2);
  assert(report.coverage.percent < 1);
  assert(report.coverage.longestGapMs > 23 * 3600000);
  assert.equal(report.observations[0].count, 2);
  assert(report.limitations.some(x => x.includes('Incomplete')));
  assert.deepEqual(report.recommendations, []);
});
test('drying calculations stop at gaps and distinguish a rise from a logged irrigation event', () => {
  const start = Date.parse('2026-10-16T17:00:00Z'); // Scheduled lights off in NY.
  const rows = [snapshot(start, 50), snapshot(start + SLOT, 48), snapshot(start + 4 * SLOT, 45), snapshot(start + 5 * SLOT, 46)];
  const report = analyze({ snapshots: rows, now: start + 6 * SLOT });
  const p = report.probes[0];
  assert.equal(p.lightsOffSegments.length, 2);
  assert.equal(p.lightsOffSegments[0].moistureDropPoints, 2);
  assert.equal(p.moistureRises.length, 1);
  assert.equal(report.events.length, 0);
  assert.equal(p.eventResponses.length, 0);
  assert.equal(report.probeComparison.meanMoistureSpreadPoints, 2);
});
test('logged responses require nearby readings; missing data is never interpolated', () => {
  const event = { id: 'synthetic-event-123', kind: 'irrigation', occurredAt: new Date(now - SLOT).toISOString(), probe: 1 };
  let r = analyze({ snapshots: [snapshot(now - 2 * SLOT, 30), snapshot(now, 35)], events: [event], now });
  assert.equal(r.probes[0].eventResponses[0].changePoints, 5);
  r = analyze({ snapshots: [snapshot(now - DAY / 2), snapshot(now)], events: [event], now });
  assert.equal(r.probes[0].eventResponses[0].changePoints, null);
  assert.equal(r.probes[1].eventResponses.length, 0);
});
test('scheduled phases use New York across DST, not browser or server local time', () => {
  assert.equal(phaseAt(Date.parse('2026-10-16T14:59:00Z')), 'scheduled lights on');
  assert.equal(phaseAt(Date.parse('2026-10-16T15:00:00Z')), 'scheduled lights off');
  assert.equal(phaseAt(Date.parse('2026-11-16T15:59:00Z')), 'scheduled lights on');
  assert.equal(phaseAt(Date.parse('2026-11-16T16:00:00Z')), 'scheduled lights off');
});
test('event validation preserves unknown amounts and rejects invalid scopes, clocks and inputs', () => {
  const valid = { id: 'synthetic-event-123', kind: 'irrigation', occurredAt: new Date(now).toISOString(), probe: null };
  assert.equal(validateEvent(valid, now).volumeLiters, null);
  for (const delta of [{ probe: 99 }, { volumeLiters: -1 }, { durationSeconds: '60' },
    { occurredAt: '2026-10-16T12:00:00' }, { occurredAt: new Date(now + DAY).toISOString() }, { kind: 'change' }, { note: 'x'.repeat(1001) }]) {
    assert.throws(() => validateEvent({ ...valid, ...delta }, now));
  }
});
test('learning API rejects unauthorized and cross-origin writes before any storage calls', async () => {
  const handler = require('./api/learning.js'), previous = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = 'fixture-password';
  const response = () => ({ setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  try {
    let res = response(); await handler({ method: 'GET', headers: {} }, res); assert.equal(res.code, 401);
    res = response(); await handler({ method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('farber:fixture-password').toString('base64'),
      'content-type': 'application/json', origin: 'https://unrelated.example', host: 'farber.example' }, body: {} }, res); assert.equal(res.code, 403);
  } finally { if (previous === undefined) delete process.env.DASHBOARD_PASSWORD; else process.env.DASHBOARD_PASSWORD = previous; }
});
test('storage credentials stay server-side and invalid destinations fail closed', async () => {
  assert.throws(() => makeStore({ KV_REST_API_URL: 'https://example.com', KV_REST_API_TOKEN: 'test' }));
  const command = makeStore({ KV_REST_API_URL: 'https://fixture.upstash.io', KV_REST_API_TOKEN: 'fixture-token' }, async (url, options) => {
    assert.equal(url, 'https://fixture.upstash.io'); assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return { ok: true, json: async () => ({ result: 'OK' }) };
  });
  assert.equal(await command(['PING']), 'OK');
});

const pythonEnv = { ...process.env, PYTHONPATH: process.env.LEARNING_REDIS_TEST_PATH || process.env.PYTHONPATH || '' };
const hasRedis = spawnSync('python3', ['-c', 'import fakeredis; import lupa'], { env: pythonEnv }).status === 0;
function fixture(t) {
  const child = spawn('python3', ['-u', 'tests/redis-fixture.py'], { env: pythonEnv, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = []; createInterface({ input: child.stdout }).on('line', line => {
    const p = pending.shift(), result = JSON.parse(line); if (result.error) p.reject(new Error(result.error)); else p.resolve(result.result);
  });
  child.on('error', error => { for (const p of pending.splice(0)) p.reject(error); });
  t.after(() => child.kill());
  return command => new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(command) + '\n'); });
}
const integration = (name, fn) => test(name, { skip: !hasRedis && "Install optional fakeredis[lua] for Redis/Lua contract tests" }, fn);
integration('Redis/Lua: new baseline archives legacy data, survives retries and freezes after seven days', async t => {
  const command = fixture(t);
  await command(['SET', `${LEGACY}:state`, JSON.stringify({ learning: { captures: 34 } })]);
  await command(['RPUSH', `${LEGACY}:baseline`, JSON.stringify(snapshot(now - DAY))]);
  let m = await recordCapture({ command, snapshot: snapshot(now, 40, true), valid: false, now });
  assert.equal(m.startedAt, null);
  m = await recordCapture({ command, snapshot: snapshot(now), valid: true, now });
  assert.equal(m.captures, 1); assert.equal(m.startedAt, now); assert.equal(m.endsAt, now + 7 * DAY);
  m = await recordCapture({ command, snapshot: snapshot(now + 1000), valid: true, now: now + 1000 });
  assert.equal(m.captures, 1); assert.equal(await command(['HLEN', `${PREFIX}:baseline`]), 1);
  const archive = JSON.parse(await command(['GET', `${PREFIX}:legacy`]));
  assert.equal(JSON.parse(archive.state).learning.captures, 34); assert.equal(archive.baseline.length, 1);
  const archived = await command(['GET', `${PREFIX}:legacy`]);
  m = await recordCapture({ command, snapshot: snapshot(now + 7 * DAY + SLOT), valid: true, now: now + 7 * DAY + SLOT });
  assert.equal(m.captures, 1); assert.equal(m.totalCaptures, 2); assert.equal(await command(['HLEN', `${PREFIX}:baseline`]), 1);
  assert.equal(await command(['GET', `${PREFIX}:legacy`]), archived);
  const status = await getStatus(command, now + 7 * DAY + 4 * SLOT); assert.equal(status.baseline.stale, true);
});
integration('Redis/Lua: event retries cannot duplicate entries or silently overwrite a different event', async t => {
  const command = fixture(t), input = { id: 'synthetic-event-123', kind: 'irrigation', occurredAt: new Date(now).toISOString(), volumeLiters: 5 };
  assert.equal((await saveEvent(command, validateEvent(input, now))).saved, true);
  assert.equal((await saveEvent(command, validateEvent(input, now + 1000))).duplicate, true);
  await assert.rejects(saveEvent(command, validateEvent({ ...input, volumeLiters: 6 }, now)), /already used/);
  assert.equal(await command(['HLEN', `${PREFIX}:events`]), 1);
});
integration('Redis/Lua: daily reports persist once per New York date and use real stored samples', async t => {
  const command = fixture(t);
  let m;
  for (let i = 0; i < 3; i++) m = await recordCapture({ command, snapshot: snapshot(now + i * SLOT, 40 - i), valid: true, now: now + i * SLOT });
  const result = await saveDailyReport(command, now + 2 * SLOT, m); assert.equal(result.saved, true);
  assert.equal((await saveDailyReport(command, now + 3 * SLOT, m)).saved, false);
  const status = await getStatus(command, now + 2 * SLOT);
  assert.equal(status.latestReport.coverage.complete, 3); assert.equal(status.baseline.completeCaptures, 3);
  assert.equal(status.latestReport.probes[0].moisture.first, 41); assert.equal(status.latestReport.probes[0].moisture.last, 39);
  assert.equal(status.legacyArchived, true);
});

integration('Redis/Lua: real monitor capture starts the fresh baseline and saves the first report without replacing legacy learning state', async t => {
  const command = fixture(t), { runMonitor } = require('./lib/monitor.cjs');
  await command(['SET', `${LEGACY}:state`, JSON.stringify({ incidents: {}, learning: { captures: 34, startedAt: now - DAY } })]);
  const env = { MONITOR_MODE: 'learn', CRON_SECRET: 'fixture-cron', GROWLINK_API_KEY: 'fixture-key',
    UPSTASH_REDIS_REST_URL: 'https://fixture.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'fixture-token' };
  const fetcher = async (url, options) => {
    if (url === env.UPSTASH_REDIS_REST_URL) return { ok: true, json: async () => ({ result: await command(JSON.parse(options.body)) }) };
    if (url.startsWith('https://api.developer.growlink.com/')) return { ok: true, json: async () => ({ sensorData: snapshot(now).samples.map(s => ({ sensorId: s.id, ...s, suffix: s.unit })) }) };
    throw new Error('Unexpected test host');
  };
  const result = await runMonitor({ env, fetcher, now });
  assert.equal(result.learning.version, 2); assert.equal(result.learning.captures, 1); assert.equal(result.report.saved, true);
  assert.equal(JSON.parse(await command(['GET', `${LEGACY}:state`])).learning.captures, 34);
  const status = await getStatus(command, now); assert.equal(status.latestReport.coverage.complete, 1);
  assert.equal(await command(['GET', `${LEGACY}:lock`]), null);
});
