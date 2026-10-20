const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { PREFIX, DAY, validateProfile, validateRecord, signature, assess, saveProfile, saveRecord, getWorkspace } = require('./lib/cucumber.cjs');
const now = Date.parse('2026-10-18T16:00:00Z');
function profile(overrides = {}) {
  const p = validateProfile({ crop: 'cucumber', medium: 'coco', area: 'Synthetic cucumber bay', cultivar: 'Test cultivar', stage: 'fruiting', system: 'drain-to-waste', plantCount: 100, containerLiters: 10, ...overrides }, now);
  return { ...p, revision: 1, fingerprint: signature(p) };
}
function reading(overrides = {}, p = profile()) {
  return { ...validateRecord({ crop: 'cucumber', medium: 'coco', id: 'synthetic-cucumber-001', kind: 'observation', occurredAt: new Date(now).toISOString(), airTempF: 82, rh: 65, feedEc: 2, drainEc: 2.5, feedPh: 5.8, meterChecked: true,
    appliedLiters: 10, drainedLiters: 2, measuredPlants: 4, sameGroup: true, collectionComplete: true,
    periodStart: new Date(now - DAY).toISOString(), periodEnd: new Date(now).toISOString(), ...overrides }, now), profile: p };
}
const rules = result => result.cards.map(c => c.rule);

test('cucumber scope is explicit; unknown values stay unknown and units/types are validated', () => {
  const r = reading({ feedEc: null, drainedLiters: null }); assert.equal(r.feedEc, null); assert.equal(r.drainedLiters, null);
  for (const changes of [{ crop: 'other' }, { medium: 'soil' }, { feedEc: '2000' }, { feedEc: Infinity }, { feedPh: -1 }, { measuredPlants: 1.5 }, { occurredAt: '2026-10-18T12:00:00' }, { periodStart: new Date(now + DAY).toISOString() }]) assert.throws(() => reading(changes));
  assert.throws(() => profile({ crop: 'other' })); assert.throws(() => profile({ stage: 'invented' }));
});
test('reference checks distinguish dripper, drainage and spot climate and cite their sources', () => {
  const r = assess(profile(), [reading({ feedPh: 7, feedEc: 3.2, drainEc: 4, rh: 80, airTempF: 99, drainedLiters: 0.5 })], now);
  for (const rule of ['feed-ph', 'feed-ec', 'drain-ec', 'humidity', 'temperature', 'drainage']) assert(rules(r).includes(rule));
  assert.equal(r.metrics.drainagePercent, 5); assert.equal(r.metrics.appliedLitersPerMeasuredPlant, 2.5);
  assert(r.cards.filter(c => c.level === 'review').every(c => r.sources.some(s => s.id === c.source)));
  assert(!JSON.stringify(r.cards).includes('increase by'));
});
test('fresh calibrated readings at reference boundaries do not trigger range flags', () => {
  for (const [feedEc, drainEc, feedPh, drainedLiters] of [[1.5, 2, 5.5, 1], [2.5, 3, 6, 2.5]]) {
    const r = assess(profile(), [reading({ feedEc, drainEc, feedPh, drainedLiters })], now);
    assert.deepEqual(rules(r), ['no-flags']);
  }
});
test('calibration, stage, recirculation and unknown setup gate chemistry and irrigation guidance', () => {
  const unchecked = assess(profile(), [reading({ meterChecked: false, feedEc: 8, feedPh: 8, drainEc: 8 })], now);
  assert(rules(unchecked).includes('meter')); assert(!rules(unchecked).includes('feed-ph')); assert(!rules(unchecked).includes('feed-ec'));
  for (const changes of [{ stage: 'seedling' }, { stage: 'unknown' }, { system: 'recirculating' }, { system: 'unknown' }]) {
    const p = profile(changes), r = assess(p, [reading({ feedEc: 8, drainEc: 8, drainedLiters: 0 }, p)], now);
    assert(rules(r).includes('context')); assert(!rules(r).some(x => ['feed-ec', 'drain-ec', 'drainage'].includes(x)));
  }
});
test('daily drainage needs complete matched totals; partial periods, zeros and excess drainage are not doses', () => {
  for (const changes of [{ sameGroup: false }, { collectionComplete: false }, { measuredPlants: null }, { drainedLiters: null }, { appliedLiters: 0 }, { periodStart: new Date(now - 3600000).toISOString() }]) {
    const r = assess(profile(), [reading(changes)], now); assert(!rules(r).includes('drainage')); assert(rules(r).includes('water-scope'));
  }
  const r = assess(profile(), [reading({ drainedLiters: 11 })], now);
  assert(rules(r).includes('water-balance')); assert(!rules(r).includes('drainage'));
});
test('old climate, chemistry and collection periods cannot drive current adjustments', () => {
  const old = reading({ occurredAt: new Date(now - 2 * DAY).toISOString(), feedEc: 8, feedPh: 8, drainEc: 8, rh: 90, airTempF: 100,
    periodStart: new Date(now - 3 * DAY).toISOString(), periodEnd: new Date(now - 2 * DAY).toISOString(), drainedLiters: 0 });
  const r = assess(profile(), [old], now);
  assert(rules(r).includes('stale')); assert(rules(r).includes('water-age')); assert(rules(r).includes('climate-age'));
  assert(!rules(r).some(x => ['feed-ph', 'feed-ec', 'drain-ec', 'humidity', 'temperature', 'drainage'].includes(x)));
});
test('manual comparison history does not mix setup revisions, other crops, sensor origins or future readings', () => {
  const p = profile(), r = reading(), earlier = reading({ id: 'synthetic-cucumber-002', occurredAt: new Date(now - 1000).toISOString(), feedEc: 2.5 });
  const result = assess(p, [r, earlier, { ...r, crop: 'other' }, { ...r, source: 'sensor' }, { ...r, profile: profile({ area: 'Different bay' }) }, { ...r, occurredAt: new Date(now + DAY).toISOString() }], now);
  assert.equal(result.baseline.daysWithReadings, 1); assert.equal(result.baseline.samples, 2); assert.equal(result.history[0].median, 2.25);
  assert.equal(assess(null, [r], now).baseline.samples, 0);
});

const pythonEnv = { ...process.env, PYTHONPATH: process.env.LEARNING_REDIS_TEST_PATH || process.env.PYTHONPATH || '' };
const hasRedis = spawnSync('python3', ['-c', 'import fakeredis; import lupa'], { env: pythonEnv }).status === 0;
function fixture(t) {
  const child = spawn('python3', ['-u', 'tests/redis-fixture.py'], { env: pythonEnv, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = []; createInterface({ input: child.stdout }).on('line', line => { const p = pending.shift(), r = JSON.parse(line); if (r.error) p.reject(new Error(r.error)); else p.resolve(r.result); });
  t.after(() => child.kill()); return command => new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(command) + '\n'); });
}
const integration = (name, fn) => test(name, { skip: !hasRedis && 'Optional fakeredis[lua] is unavailable' }, fn);
integration('cucumber Redis/Lua: profile revisions, record retries, follow-ups and namespaces persist correctly', async t => {
  const command = fixture(t), p = await saveProfile(command, profile(), 0);
  assert.equal(p.revision, 1); await assert.rejects(saveProfile(command, profile({ area: 'Lost edit' }), 0), /another session/);
  const original = reading({}, p); delete original.profile;
  assert.equal((await saveRecord(command, original, 1)).saved, true);
  assert.equal((await saveRecord(command, { ...original, recordedAt: new Date(now + 1000).toISOString() }, 1)).duplicate, true);
  await assert.rejects(saveRecord(command, { ...original, feedEc: 4 }, 1), /different entry/);
  const follow = validateRecord({ crop: 'cucumber', medium: 'coco', id: 'synthetic-followup-001', kind: 'followup', occurredAt: new Date(now).toISOString(), relatedId: original.id, note: 'Rechecked emitter collection' }, now);
  await saveRecord(command, follow, 1);
  const updated = await saveProfile(command, profile({ area: 'Another cucumber bay' }), 1);
  assert.equal((await saveRecord(command, original, 1)).duplicate, true); // Response lost before a setup change.
  const view = await getWorkspace(command, now); assert.equal(view.records.length, 2); assert.equal(view.assessment.baseline.samples, 0);
  assert.equal(view.records.find(r => r.kind === 'observation').profile.area, p.area);
  await assert.rejects(saveRecord(command, { ...follow, id: 'synthetic-followup-002' }, updated.revision), /current cucumber setup/);
  assert((await command(['KEYS', '*'])).every(key => key.startsWith(PREFIX + ':')));
});
integration('cucumber API: authentication, same-origin writes, stored setup and measurements round trip', async t => {
  const command = fixture(t), handler = require('./api/cucumber.js'), keys = ['DASHBOARD_PASSWORD', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]])), oldFetch = global.fetch;
  Object.assign(process.env, { DASHBOARD_PASSWORD: 'synthetic-password', UPSTASH_REDIS_REST_URL: 'https://fixture.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'synthetic-token' });
  let calls = 0;
  global.fetch = async (url, options) => { calls++; assert.equal(url, 'https://fixture.upstash.io'); return { ok: true, json: async () => ({ result: await command(JSON.parse(options.body)) }) }; };
  const headers = { authorization: 'Basic ' + Buffer.from('cucumber:synthetic-password').toString('base64'), host: 'cucumber.example', origin: 'https://cucumber.example', 'content-type': 'application/json' };
  const response = () => ({ setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
  async function call(method, body, overrides = {}) { const res = response(); await handler({ method, body, headers: { ...headers, ...overrides } }, res); return res; }
  try {
    assert.equal((await call('GET', null, { authorization: '' })).code, 401); assert.equal(calls, 0);
    assert.equal((await call('POST', {}, { origin: 'https://other.example' })).code, 403); assert.equal(calls, 0);
    assert.equal((await call('POST', { action: 'profile', revision: 0, profile: { ...profile(), crop: 'other' } })).code, 400);
    assert.equal((await call('POST', { action: 'profile', revision: 0, profile: profile() })).code, 200);
    const record = reading(); delete record.profile;
    assert.equal((await call('POST', { action: 'record', revision: 1, record })).code, 201);
    assert.equal((await call('POST', { action: 'record', revision: 1, record })).body.duplicate, true);
    const result = await call('GET'); assert.equal(result.code, 200); assert.equal(result.body.records.length, 1); assert.equal(result.body.assessment.latest.feedEc, 2);
  } finally { global.fetch = oldFetch; for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
});
