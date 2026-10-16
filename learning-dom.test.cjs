const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { TextEncoder } = require('node:util');
const { JSDOM } = require('jsdom');
const { analyze, SLOT, DAY } = require('./lib/learning.cjs');
const cfg = require('./config.cjs');

function fixture(t, fetcher) {
  const html = fs.readFileSync('index.html', 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://dashboard.example', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  dom.window.fetch = fetcher;
  dom.window.TextEncoder = TextEncoder;
  const run = code => { const script = dom.window.document.createElement('script'); script.textContent = code; dom.window.document.body.append(script); };
  run(fs.readFileSync('learning.js', 'utf8') + '\nwindow.fixturePanel = learningPanel;');
  return { window: dom.window, doc: dom.window.document, panel: dom.window.fixturePanel, run };
}
function data() {
  const now = Date.now();
  const baseline = { startedAt: now - DAY, endsAt: now + 6 * DAY, completeCaptures: 120, expectedCaptures: 289, coveragePercent: 41.5, longestGapMs: SLOT, lastCompleteAt: now, stale: false };
  const snapshots = Array.from({ length: 120 }, (_, i) => {
    const at = new Date(now - (119 - i) * SLOT).toISOString();
    return { at, samples: cfg.sensors.map(([id]) => ({ id, value: 40, timestamp: at, unit: '%' })) };
  });
  return { baseline, legacyArchived: true, sensorCount: 13, latestReport: analyze({ snapshots, now, baseline }), events: [] };
}
const response = body => ({ ok: true, json: async () => body });

test('dashboard DOM: report rendering, retry-safe event entry, plain-text notes and signout', async t => {
  const status = data(), posts = [];
  let failOnce = true;
  const { window, doc, panel } = fixture(t, async (url, options = {}) => {
    if (options.method === 'POST') {
      const entry = JSON.parse(options.body); posts.push(entry);
      if (!status.events.length) status.events.push(entry);
      if (failOnce) { failOnce = false; throw new Error('Synthetic network timeout'); }
      return response({ duplicate: true, event: entry });
    }
    return response(url.includes('preview') ? { ...status, currentAnalysis: status.latestReport } : status);
  });
  await panel.load('Basic fixture-only');
  assert.equal(doc.querySelectorAll('#learningReport tbody tr').length, 13);
  assert.equal(doc.getElementById('eventForm').hidden, false);
  assert.match(doc.getElementById('learningStats').textContent, /41.5%/);
  doc.getElementById('eventDuration').value = '45';
  doc.getElementById('eventVolume').value = '2.5';
  doc.getElementById('eventNote').value = '<img src=x onerror=alert(1)>';
  const submit = () => doc.getElementById('eventForm').onsubmit({ preventDefault() {} });
  await submit(); assert.match(doc.getElementById('eventMessage').textContent, /timeout/);
  await submit();
  assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]);
  assert.equal(posts[0].durationSeconds, 45); assert.equal(posts[0].volumeLiters, 2.5); assert.equal(posts[0].feedEc, null);
  assert.match(doc.getElementById('eventMessage').textContent, /No duplicate/);
  assert.match(doc.getElementById('irrigationEvents').textContent, /<img src=x/);
  assert.equal(doc.querySelector('#irrigationEvents img'), null);
  assert.match(doc.getElementById('learningReport').textContent, /Current 24-hour analysis/);
  assert.equal(window.localStorage.length, 0);
  panel.reset();
  assert.equal(doc.getElementById('eventForm').hidden, true);
  assert.equal(doc.getElementById('learningReport').textContent, '');
  assert.equal(doc.getElementById('irrigationEvents').textContent, '');
  assert.ok(doc.getElementById('eventAt').value);
});

test('dashboard DOM: a late authenticated response cannot repopulate the panel after signout', async t => {
  let release;
  const { doc, panel } = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = panel.load('Basic fixture-only');
  panel.reset(); release(response(data())); await pending;
  assert.equal(doc.getElementById('learningReport').textContent, '');
  assert.equal(doc.getElementById('eventForm').hidden, true);
});

test('dashboard DOM: existing app loads the new panel after login and resets it on signout', async t => {
  const status = data();
  const { doc, run } = fixture(t, async (url, options = {}) => {
    if (url.startsWith('/api/learning')) return response(status);
    if (url.startsWith('/api/ring')) return response({ linked: false, devices: [] });
    if (!options.headers?.Authorization) return { status: 401, ok: false, json: async () => ({ error: 'Unauthorized' }) };
    if (url.includes('mode=live')) return response({ sensors: cfg.sensors, fetchedAt: new Date().toISOString(), data: { sensorData: cfg.sensors.map(([sensorId]) => ({ sensorId, value: 40, timestamp: new Date().toISOString() })) } });
    return response({ data: { series: [{ data: [] }] } });
  });
  run(fs.readFileSync('app.js', 'utf8'));
  run(fs.readFileSync('ring.js', 'utf8'));
  doc.getElementById('password').value = 'fixture-only';
  doc.getElementById('login').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.getElementById('eventForm').hidden, false);
  assert.equal(doc.getElementById('password').value, '');
  doc.getElementById('signout').click();
  assert.equal(doc.getElementById('eventForm').hidden, true);
});
