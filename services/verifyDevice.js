// services/verifyDevice.js
const crypto = require('crypto');
const Machine = require('../src/models/Machine'); // you already require this in server.js

// Helper: constant-time compare
function tscmp(a, b) {
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  catch { return false; }
}

async function resolveSecret(req) {
  // 1) Best: per-device secret from Machine collection
  const devId = req.get('X-Device-ID');
  if (devId) {
    const m = await Machine.findOne({ deviceId: devId, status: { $ne: 'inactive' } })
                           .select('deviceId deviceSecret')
                           .lean()
                           .catch(() => null);
    if (m?.deviceSecret) return { secret: m.deviceSecret, deviceId: devId };
  }

  // 2) Fallback: one shared secret from env
  if (process.env.EDGE_SHARED_SECRET) {
    return { secret: process.env.EDGE_SHARED_SECRET, deviceId: devId || 'shared' };
  }

  return { secret: null, deviceId: devId || null };
}

module.exports = async function verifyDevice(req, res, next) {
  try {
    const ts = req.get('X-Timestamp');
    const sig = req.get('X-Signature');
    const dev = req.get('X-Device-ID') || 'unknown';

    if (!ts || !sig) {
      return res.status(401).json({ error: 'missing device headers' });
    }

    // basic replay / clock skew guard (±60s)
    const skew = Math.abs(Date.now() - Number(ts));
    if (!Number.isFinite(Number(ts)) || skew > 60_000) {
      return res.status(401).json({ error: 'clock skew' });
    }

    const { secret, deviceId } = await resolveSecret(req);
    if (!secret) return res.status(401).json({ error: 'device not provisioned' });

    const raw = JSON.stringify(req.body || {});
    const expect = crypto.createHmac('sha256', secret)
                         .update(ts + raw)
                         .digest('hex');

    if (!tscmp(sig, expect)) {
      return res.status(401).json({ error: 'bad signature', deviceId: deviceId || dev });
    }

    // expose device to downstream handlers if useful
    req.edgeDevice = { deviceId, auth: 'hmac' };
    next();
  } catch (e) {
    console.error('verifyDevice error', e);
    res.status(401).json({ error: 'device auth failed' });
  }
};
