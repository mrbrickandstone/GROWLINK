const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { TextEncoder } = require('node:util');
const { JSDOM } = require('jsdom');
const { assess, validateProfile, validateRecord, signature } = require('./lib/cucumber.cjs');
function data() {
  const now = Date.now(), p = validateProfile({ crop: 'cucumber', medium: 'coco', area: 'Synthetic cucumber bay', cultivar: 'Test', stage: 'fruiting', system: 'drain-to-waste', plantCount: 20, containerLiters: 10 });
  const profile = { ...p, revision: 1, fingerprint: signature(p) };
  return { profile, records: [], assessment: assess(profile, [], now) };
}
function fixture(t, fetcher) {
  const dom = new JSDOM(fs.readFileSync('cucumber/index.html', 'utf8'), { url: 'https://cucumber.example/cucumber/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close()); dom.window.fetch = fetcher; dom.window.TextEncoder = TextEncoder;
  let interval; dom.window.setInterval = callback => { interval = callback; return 1; };
  dom.window.eval(fs.readFileSync('cucumber/app.js', 'utf8'));
  return { window: dom.window, doc: dom.window.document, tick: () => interval() };
}
const response = body => ({ ok: true, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function login(doc) { doc.getElementById('password').value = 'synthetic-password'; await doc.getElementById('login').onsubmit({ preventDefault() {} }); }
test('cucumber DOM: manual readings survive timeout retries, render evidence and escape notes', async t => {
  const state = data(), posts = []; let fail = true;
  const { doc, window } = fixture(t, async (url, options) => {
    assert.equal(url, '/api/cucumber');
    if (options.method === 'POST') {
      const payload = JSON.parse(options.body); posts.push(payload);
      if (!state.records.length) state.records.push({ ...validateRecord(payload.record), profile: state.profile });
      if (fail) { fail = false; throw new Error('Synthetic timeout'); }
      state.assessment = assess(state.profile, state.records); return response({ duplicate: true });
    }
    return response(state);
  });
  await login(doc); assert.equal(doc.getElementById('workspace').hidden, false); assert.equal(doc.getElementById('password').value, '');
  const form = doc.getElementById('observationForm'); form.elements.airTempF.value = '100'; form.elements.rh.value = '80'; form.elements.note.value = '<img src=x onerror=alert(1)>';
  await form.onsubmit({ preventDefault() {} }); assert.match(doc.getElementById('observationMessage').textContent, /timeout/);
  await form.onsubmit({ preventDefault() {} }); assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]);
  assert.equal(posts[0].record.feedEc, null); assert.equal(posts[0].record.crop, 'cucumber');
  assert.match(doc.getElementById('recommendations').textContent, /temperature/);
  assert.equal(doc.querySelector('#records img'), null); assert.match(doc.getElementById('records').textContent, /<img/);
  assert.equal(window.localStorage.length, 0);
  doc.querySelector('#recommendations button').click(); assert.equal(doc.getElementById('followupForm').elements.relatedId.value, state.records[0].id);
  doc.getElementById('signout').click(); assert.equal(doc.getElementById('workspace').hidden, true); assert.equal(doc.getElementById('records').textContent, '');
});
test('cucumber DOM: setup fields stay explicit and unknown readings are never manufactured', async t => {
  const state = { profile: null, records: [], assessment: assess(null, []) }, posts = [];
  const { doc } = fixture(t, async (url, options) => {
    if (options.method === 'POST') { const payload = JSON.parse(options.body); posts.push(payload); const p = validateProfile(payload.profile); state.profile = { ...p, revision: 1, fingerprint: signature(p) }; state.assessment = assess(state.profile, []); return response({ profile: state.profile }); }
    return response(state);
  });
  await login(doc); assert.equal(doc.getElementById('readingFields').disabled, true);
  const form = doc.getElementById('profileForm'); form.elements.area.value = 'New cucumber bay';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts[0].profile.stage, 'unknown'); assert.equal(posts[0].profile.plantCount, null); assert.equal(posts[0].profile.containerLiters, null);
  assert.equal(doc.getElementById('readingFields').disabled, false); assert.match(doc.getElementById('recommendations').textContent, /first measurement/);
});
test('cucumber DOM: signout invalidates an outstanding request', async t => {
  let release;
  const { doc } = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = login(doc); doc.getElementById('signout').click(); release(response(data())); await pending; await settle();
  assert.equal(doc.getElementById('workspace').hidden, true); assert.equal(doc.getElementById('recommendations').textContent, '');
});
test('cucumber DOM: background updates cannot silently retag unsaved readings or overwrite newer setup edits', async t => {
  const state = data(), posts = [];
  const { doc, tick } = fixture(t, async (url, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return { ok: false, status: 409, json: async () => ({ error: 'Setup changed. Reload.' }) }; }
    return response(state);
  });
  await login(doc); doc.getElementById('observationForm').elements.airTempF.value = '82';
  state.profile = { ...state.profile, revision: 2, area: 'Other operator edit' }; state.assessment = assess(state.profile, []);
  tick(); await settle();
  assert.equal(doc.getElementById('readingFields').disabled, true);
  assert.match(doc.getElementById('message').textContent, /another session/);
  const form = doc.getElementById('profileForm'); await form.onsubmit({ preventDefault() {} });
  assert.equal(posts[0].revision, 1);
  doc.getElementById('refresh').click(); await settle();
  assert.equal(form.elements.area.value, 'Other operator edit'); assert.equal(doc.getElementById('readingFields').disabled, false);
});
