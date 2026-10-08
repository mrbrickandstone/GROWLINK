const crypto = require('node:crypto');
const { runMonitor } = require('../lib/monitor.cjs');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'Monitor setup required' });
  const expected = crypto.createHash('sha256').update(`Bearer ${secret}`).digest();
  const actual = crypto.createHash('sha256').update(String(req.headers.authorization || '')).digest();
  if (!crypto.timingSafeEqual(expected, actual)) return res.status(401).json({ error: 'Unauthorized' });
  if (process.env.MONITOR_ENABLED !== 'true') return res.status(200).json({ enabled: false });
  try {
    return res.status(200).json({ enabled: true, ...await runMonitor() });
  } catch {
    // Do not expose provider bodies, recipient addresses, or tokens through this endpoint.
    return res.status(503).json({ error: 'Monitor configuration, storage, or email delivery requires attention' });
  }
};
