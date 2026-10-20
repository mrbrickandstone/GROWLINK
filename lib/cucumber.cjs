const crypto = require('node:crypto');
const PREFIX = 'horticulture:cucumber:coco:v1';
const DAY = 86400000;
const SOURCES = [
  { id: 'uf', title: 'University of Florida · Greenhouse cucumber handbook', url: 'https://ask.ifas.ufl.edu/publication/CV268', scope: 'Feed pH 5.5–6.0; avoid sustained temperatures below 65°F or above 95°F.' },
  { id: 'nsw', title: 'NSW Local Land Services · Cucumber manual (2019)', url: 'https://soilwealth.com.au/wp-content/uploads/2023/08/Cucumberbook2019_LOW_RES2.pdf#page=113', scope: 'Flow-through substrate guide: feed EC 1.5–2.5 and drain EC 2.0–3.0 mS/cm. Actual targets depend on conditions and plant response.' },
  { id: 'aces', title: 'Alabama Extension · Greenhouse cucumber production', url: 'https://www.aces.edu/blog/topics/crop-production/greenhouse-cucumber-production/', scope: 'General substrate guide: daily leachate 10–25% of applied volume; relative humidity 60–70%. References are starting points, not calibrated coco targets.' }
];
function number(value, name, min, max, integer = false) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}`);
  return value;
}
function text(value, name, max, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function time(value, now, name) {
  if (typeof value !== 'string' || !/Z$|[+-]\d\d:\d\d$/i.test(value)) throw new Error(`${name} needs a timezone`);
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < now - 30 * DAY || at > now + 60000) throw new Error(`${name} must be within the past 30 days`);
  return new Date(at).toISOString();
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) throw new Error('Invalid record ID');
  return value;
}
function assertScope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.crop !== 'cucumber' || input.medium !== 'coco') throw new Error('This workspace accepts cucumber records in coco only');
}
function validateProfile(input, now = Date.now()) {
  assertScope(input);
  if (!['unknown', 'seedling', 'established', 'fruiting'].includes(input.stage)) throw new Error('Choose a crop stage');
  if (!['unknown', 'drain-to-waste', 'recirculating'].includes(input.system)) throw new Error('Choose an irrigation system');
  return { crop: 'cucumber', medium: 'coco', area: text(input.area, 'growing area', 80, true), cultivar: text(input.cultivar, 'cultivar', 80), stage: input.stage, system: input.system,
    plantCount: number(input.plantCount, 'plant count', 1, 100000, true), containerLiters: number(input.containerLiters, 'container volume', 0.1, 1000), updatedAt: new Date(now).toISOString() };
}
function validateRecord(input, now = Date.now()) {
  assertScope(input);
  const common = { id: id(input.id), kind: input.kind, crop: 'cucumber', medium: 'coco', source: 'manual', occurredAt: time(input.occurredAt, now, 'Reading time'), recordedAt: new Date(now).toISOString(), note: text(input.note, 'notes', 1000) };
  if (input.kind === 'followup') return { ...common, note: text(input.note, 'follow-up description', 1000, true), relatedId: id(input.relatedId) };
  if (input.kind !== 'observation') throw new Error('Choose a reading or follow-up');
  const reading = { ...common, airTempF: number(input.airTempF, 'air temperature (°F)', 20, 140), rh: number(input.rh, 'relative humidity (%)', 0, 100),
    feedEc: number(input.feedEc, 'feed EC (mS/cm)', 0, 20), drainEc: number(input.drainEc, 'drain EC (mS/cm)', 0, 20), feedPh: number(input.feedPh, 'feed pH', 0, 14),
    appliedLiters: number(input.appliedLiters, 'applied volume (L)', 0, 1000000), drainedLiters: number(input.drainedLiters, 'drain volume (L)', 0, 1000000),
    measuredPlants: number(input.measuredPlants, 'plants in the measured group', 1, 100000, true), meterChecked: input.meterChecked === true,
    sameGroup: input.sameGroup === true, collectionComplete: input.collectionComplete === true, periodStart: null, periodEnd: null };
  if (['airTempF', 'rh', 'feedEc', 'drainEc', 'feedPh', 'appliedLiters', 'drainedLiters'].every(key => reading[key] === null)) throw new Error('Enter at least one measured value');
  if (reading.appliedLiters !== null || reading.drainedLiters !== null) {
    reading.periodStart = time(input.periodStart, now, 'Collection start'); reading.periodEnd = time(input.periodEnd, now, 'Collection end');
    const hours = (Date.parse(reading.periodEnd) - Date.parse(reading.periodStart)) / 3600000;
    if (hours <= 0 || hours > 48) throw new Error('Collection period must be longer than zero and no more than 48 hours');
  }
  return reading;
}
function signature(profile) {
  const { crop, medium, area, cultivar, stage, system, plantCount, containerLiters } = profile;
  return crypto.createHash('sha256').update(JSON.stringify({ crop, medium, area, cultivar, stage, system, plantCount, containerLiters })).digest('hex');
}
function makeStore(env, fetcher = fetch) {
  const endpoint = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!endpoint || !token) throw new Error('Storage is not configured');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid storage endpoint');
  return async command => {
    const res = await fetcher(url.origin, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('Storage unavailable');
    const body = await res.json(); if (body.error || !Object.hasOwn(body, 'result')) throw new Error('Storage unavailable'); return body.result;
  };
}
const conflict = message => Object.assign(new Error(message), { status: 409 });
async function saveProfile(command, profile, revision) {
  if (!Number.isInteger(revision) || revision < 0) throw new Error('A profile revision is required');
  const value = { ...profile, revision: revision + 1, fingerprint: signature(profile) };
  const saved = await command(['EVAL', `local raw=redis.call('GET',KEYS[1]); local revision=0; if raw then revision=cjson.decode(raw).revision end; if revision~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`, '1', `${PREFIX}:profile`, String(revision), JSON.stringify(value)]);
  if (saved !== 1) throw conflict('Setup changed in another session. Reload before saving.');
  return value;
}
async function saveRecord(command, reading, expectedRevision) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...reading, recordedAt: null })).digest('hex');
  // A retry returns the original record even if the setup subsequently changed.
  const existing = await command(['HGET', `${PREFIX}:records`, reading.id]);
  if (existing) {
    if (await command(['HGET', `${PREFIX}:hashes`, reading.id]) !== fingerprint) throw conflict('This ID belongs to a different entry');
    return { saved: false, duplicate: true, record: JSON.parse(existing) };
  }
  const raw = await command(['GET', `${PREFIX}:profile`]); if (!raw) throw conflict('Save the cucumber setup first');
  const profile = JSON.parse(raw);
  if (expectedRevision !== profile.revision) throw conflict('Setup changed. Reload and review this entry.');
  if (reading.kind === 'observation' && profile.plantCount !== null && reading.measuredPlants > profile.plantCount) throw conflict('The measured group exceeds the setup plant count. Review both counts.');
  if (reading.kind === 'followup') {
    const related = JSON.parse(await command(['HGET', `${PREFIX}:records`, reading.relatedId]) || 'null');
    if (!related || related.kind !== 'observation' || related.profile.fingerprint !== profile.fingerprint) throw conflict('Choose a reading from the current cucumber setup');
  }
  const value = { ...reading, profile };
  const result = await command(['EVAL', `local previous=redis.call('HGET',KEYS[2],ARGV[1]); if previous then if previous==ARGV[3] then return 0 else return -1 end end; local profile=redis.call('GET',KEYS[4]); if not profile or cjson.decode(profile).revision~=tonumber(ARGV[5]) then return -2 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('HSET',KEYS[2],ARGV[1],ARGV[3]); redis.call('ZADD',KEYS[3],ARGV[4],ARGV[1]); return 1`,
    '4', `${PREFIX}:records`, `${PREFIX}:hashes`, `${PREFIX}:timeline`, `${PREFIX}:profile`, reading.id, JSON.stringify(value), fingerprint, String(Date.parse(reading.occurredAt)), String(expectedRevision)]);
  if (result < 0) throw conflict(result === -2 ? 'Setup changed. Reload and review this entry.' : 'This ID belongs to a different entry');
  return { saved: result === 1, duplicate: result === 0, record: result === 0 ? JSON.parse(await command(['HGET', `${PREFIX}:records`, reading.id])) : value };
}
function assess(profile, records, now = Date.now()) {
  const readings = records.filter(r => profile?.fingerprint && r.kind === 'observation' && r.crop === 'cucumber' && r.medium === 'coco' && r.source === 'manual' && r.profile?.fingerprint === profile.fingerprint && Date.parse(r.occurredAt) <= now + 60000).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const latest = readings[0], cards = [], metrics = {};
  const add = (rule, level, title, detail, action, source = null) => cards.push({ rule, level, title, detail, action, source, observationId: latest?.id || null });
  if (!profile) add('setup', 'info', 'Add your cucumber setup', 'Cucumbers in coco · manual readings · no sensor feed connected.', 'Name the growing area and record the crop stage and irrigation system.');
  else if (!latest) add('first-reading', 'info', 'Ready for your first measurement', 'No manual readings exist for the current cucumber setup.', 'Record measured values below. Leave unknown quantities blank.');
  else {
    const age = now - Date.parse(latest.occurredAt), chemistry = [latest.feedPh, latest.feedEc, latest.drainEc].some(v => v !== null);
    const established = ['established', 'fruiting'].includes(profile.stage), open = profile.system === 'drain-to-waste';
    if (age > DAY) add('stale', 'attention', 'Update the manual readings', `Last observation: ${latest.occurredAt}.`, 'Take new measurements before using the chemistry or climate checks.');
    if (chemistry && !latest.meterChecked) add('meter', 'attention', 'Verify the meters first', 'The reading does not confirm a calibration / standard check.', 'Check pH and EC meters against their standards, then enter fresh measurements. Chemistry comparisons are held.');
    if ([latest.feedPh, latest.feedEc, latest.drainEc].some(v => v === null)) add('missing-chemistry', 'info', 'Complete the feed and drain measurements', 'The latest entry has an unknown pH or EC value.', 'Measure feed pH, dripper EC and collected drainage EC. Keep each sample type distinct.');
    if (age <= DAY && latest.meterChecked && latest.feedPh !== null && (latest.feedPh < 5.5 || latest.feedPh > 6)) add('feed-ph', 'review', 'Review nutrient-solution pH', `Measured feed pH ${latest.feedPh}; UF reference 5.5–6.0.`, 'Confirm the dripper sample and review the mix and source-water alkalinity before adjusting pH.', 'uf');
    if (!established || !open) add('context', 'info', 'Feed EC and drainage checks need context', `Stage: ${profile.stage}; system: ${profile.system}.`, 'Confirm an established or fruiting crop in a drain-to-waste system. This version does not prescribe seedling or recirculating-system EC targets.');
    if (age <= DAY && established && open && latest.meterChecked) {
      if (latest.feedEc !== null && (latest.feedEc < 1.5 || latest.feedEc > 2.5)) add('feed-ec', 'review', 'Review feed strength', `Dripper EC ${latest.feedEc} mS/cm; NSW flow-through reference 1.5–2.5.`, 'Recheck mixing and source-water EC; compare feed and drain samples before changing fertilizer strength.', 'nsw');
      if (latest.drainEc !== null && (latest.drainEc < 2 || latest.drainEc > 3)) add('drain-ec', 'review', 'Review drainage EC', `Collected drain EC ${latest.drainEc} mS/cm; NSW flow-through reference 2.0–3.0.`, 'Check feed EC, collection method and daily drainage together. A drain sample is not a substrate-probe EC reading.', 'nsw');
    }
    if (age <= 6 * 3600000) {
      if (latest.airTempF !== null && (latest.airTempF < 65 || latest.airTempF > 95)) add('temperature', 'review', 'Check the temperature and its duration', `Spot measurement ${latest.airTempF}°F.`, 'Verify at crop height and check heating or cooling performance. A spot reading cannot establish a sustained temperature problem.', 'uf');
      if (latest.rh !== null && (latest.rh < 60 || latest.rh > 70)) add('humidity', 'review', 'Check humidity across the growing area', `Spot measurement ${latest.rh}% RH; Alabama reference 60–70%.`, 'Repeat at representative positions and inspect airflow. Confirm a persistent condition before changing climate settings.', 'aces');
    } else if (latest.airTempF !== null || latest.rh !== null) add('climate-age', 'info', 'Climate reading is historical', 'Climate comparisons use manual readings no older than six hours.', 'Enter a current crop-height temperature and humidity reading.');
    const hasWater = latest.appliedLiters !== null || latest.drainedLiters !== null;
    const collectionHours = (Date.parse(latest.periodEnd) - Date.parse(latest.periodStart)) / 3600000;
    const matched = latest.sameGroup && latest.collectionComplete && latest.measuredPlants !== null;
    const measured = matched && latest.appliedLiters > 0 && latest.drainedLiters !== null;
    if (measured) {
      metrics.drainagePercent = latest.drainedLiters / latest.appliedLiters * 100;
      metrics.appliedLitersPerMeasuredPlant = latest.appliedLiters / latest.measuredPlants;
      metrics.collectionHours = collectionHours;
    }
    if (hasWater && (!measured || collectionHours < 20 || collectionHours > 28)) add('water-scope', 'info', 'Complete a matched daily collection', 'The daily drainage reference needs a complete 20–28 hour collection from the same counted group of plants.', 'Measure applied and drained totals for that group and period; confirm collection is complete. Partial periods remain historical observations.');
    else if (measured && metrics.drainagePercent > 100) add('water-balance', 'attention', 'Resolve the collection mismatch', `Drainage is ${metrics.drainagePercent.toFixed(1)}% of applied water.`, 'Check timing, retained water from earlier irrigation, units and collection scope. Irrigation advice is held.');
    else if (measured && now - Date.parse(latest.periodEnd) > 36 * 3600000) add('water-age', 'info', 'The collection period is historical', `Collection ended ${latest.periodEnd}.`, 'Complete a current daily collection before reviewing irrigation changes.');
    else if (measured && established && open && collectionHours >= 20 && collectionHours <= 28 && now - Date.parse(latest.periodEnd) <= 36 * 3600000 && (metrics.drainagePercent < 10 || metrics.drainagePercent > 25)) add('drainage', 'review', 'Review daily irrigation and drainage', `Measured drainage ${metrics.drainagePercent.toFixed(1)}%; general substrate reference 10–25%.`, metrics.drainagePercent < 10 ? 'Inspect emitter delivery and drainage collection, then review irrigation against plant condition and drain EC. No fixed volume increase is inferred.' : 'Check for excess delivery or uneven wetting, then review irrigation against plant condition and drain EC. No fixed volume reduction is inferred.', 'aces');
    if (!cards.length) add('no-flags', 'info', 'No configured checks triggered', 'The available recent measurements did not trigger a rule.', 'Continue recording feed, drainage and crop condition. This is not proof that every condition is suitable.');
  }
  const week = readings.filter(r => now - Date.parse(r.occurredAt) <= 7 * DAY);
  const dates = new Set(week.map(r => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(r.occurredAt))));
  const history = ['feedEc', 'drainEc', 'feedPh'].map(field => {
    const values = week.map(r => r[field]).filter(Number.isFinite).sort((a, b) => a - b);
    return { field, count: values.length, min: values.length ? values[0] : null, max: values.length ? values.at(-1) : null,
      median: values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : null };
  });
  return { version: 1, generatedAt: new Date(now).toISOString(), mode: 'Cucumber guidance from explicit rules and manual measurements; no model training or automatic control.', latest, cards, metrics, history,
    baseline: { daysWithReadings: dates.size, samples: week.length, targetDays: 7, label: 'Manual entries from the same setup; not continuous coverage or an established optimum.' },
    limitations: ['Reference ranges vary with cultivar, crop stage, light, water quality and local conditions.', 'Manual spot readings cannot establish daily climate averages, root-zone drying or plant water uptake.', 'Only manually entered cucumber records are used. No live sensors or other crop records are imported.', 'History statistics use the loaded entries (up to 200 within 90 days); they may not include every retained record.', 'Rules remain versioned and explicit; follow-ups record your decisions without retraining a model.'], sources: SOURCES, sourcesCheckedAt: '2026-10-18' };
}
async function getWorkspace(command, now = Date.now()) {
  const profile = JSON.parse(await command(['GET', `${PREFIX}:profile`]) || 'null');
  const ids = await command(['ZREVRANGEBYSCORE', `${PREFIX}:timeline`, String(now + 60000), String(now - 90 * DAY), 'LIMIT', '0', '200']);
  const records = ids.length ? (await command(['HMGET', `${PREFIX}:records`, ...ids])).filter(Boolean).map(JSON.parse) : [];
  return { profile, records, assessment: assess(profile, records, now), recordsLimit: 200, retention: 'Entries are retained; this view shows up to 200 within 90 days.' };
}
module.exports = { PREFIX, DAY, SOURCES, validateProfile, validateRecord, makeStore, saveProfile, saveRecord, getWorkspace, assess, signature };
