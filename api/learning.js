const crypto = require('node:crypto');
const { makeStore, getStatus, buildReport, validateEvent, saveEvent } = require('../lib/learning.cjs');
function same(a, b) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return res.status(503).json({ error: 'Dashboard configuration required' });
  const auth = String(req.headers.authorization || '');
  let supplied = '';
  try { const decoded = Buffer.from(auth.slice(6), 'base64').toString(); supplied = decoded.slice(decoded.indexOf(':') + 1); } catch {}
  if (!auth.startsWith('Basic ') || !same(supplied, password)) return res.status(401).json({ error: 'Connect with your dashboard password.' });
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Use JSON for event entries.' });
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host || origin !== `https://${host}`) return res.status(403).json({ error: 'Save events from this dashboard.' });
  }
  try {
    const command = makeStore(process.env), now = Date.now();
    if (req.method === 'POST') {
      let input = req.body;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return res.status(400).json({ error: 'Invalid JSON event' }); } }
      if (JSON.stringify(input || {}).length > 4096) return res.status(413).json({ error: 'Event entry is too large' });
      let event;
      try { event = validateEvent(input, now); } catch (error) { return res.status(400).json({ error: error.message }); }
      const result = await saveEvent(command, event);
      return res.status(result.saved ? 201 : 200).json(result);
    }
    const status = await getStatus(command, now);
    if (req.query?.view === 'preview') return res.status(200).json({ ...status, currentAnalysis: await buildReport(command, now, status.baseline) });
    return res.status(200).json(status);
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: error.message });
    return res.status(503).json({ error: 'Learning storage is temporarily unavailable. Your entry may already be saved; retry the same entry.' });
  }
};
