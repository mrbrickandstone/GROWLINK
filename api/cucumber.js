const crypto = require('node:crypto');
const { makeStore, validateProfile, validateRecord, saveProfile, saveRecord, getWorkspace } = require('../lib/cucumber.cjs');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return res.status(503).json({ error: 'Dashboard setup required' });
  const authorization = String(req.headers.authorization || ''), decoded = Buffer.from(authorization.slice(6), 'base64').toString(), colon = decoded.indexOf(':');
  const hash = value => crypto.createHash('sha256').update(value).digest();
  if (!authorization.startsWith('Basic ') || colon < 0 || !crypto.timingSafeEqual(hash(decoded.slice(colon + 1)), hash(password))) return res.status(401).json({ error: 'Connect with your dashboard password.' });
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Use JSON' });
    if (!req.headers.host || req.headers.origin !== `https://${req.headers.host}`) return res.status(403).json({ error: 'Save entries from this workspace.' });
  }
  try {
    const command = makeStore(process.env), now = Date.now();
    if (req.method === 'GET') return res.status(200).json(await getWorkspace(command, now));
    let input = req.body;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }
    if (!input || JSON.stringify(input).length > 6000) return res.status(400).json({ error: 'Invalid or oversized entry' });
    let value;
    try {
      value = input.action === 'profile' ? validateProfile(input.profile, now) : input.action === 'record' ? validateRecord(input.record, now) : null;
      if (!value) throw new Error('Choose setup or record');
      if (!Number.isInteger(input.revision) || input.revision < 0) throw new Error('Reload the current setup');
    } catch (error) { return res.status(400).json({ error: error.message }); }
    const result = input.action === 'profile' ? { profile: await saveProfile(command, value, input.revision) } : await saveRecord(command, value, input.revision);
    console.info(JSON.stringify({ event: 'cucumber_write', kind: input.action, saved: result.saved ?? true }));
    return res.status(result.saved ? 201 : 200).json(result);
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: error.message });
    console.warn(JSON.stringify({ event: 'cucumber_storage_unavailable' }));
    return res.status(503).json({ error: 'Storage is temporarily unavailable. An entry may already be saved; retry it unchanged.' });
  }
};
