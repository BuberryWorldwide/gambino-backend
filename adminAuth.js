// backend/adminAuth.js
module.exports = function adminAuth(req, res, next) {
  const headerKey = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) throw new Error('ADMIN_API_KEY not configured');

  if (!headerKey || headerKey !== expected) {
    return res.status(401).json({ success: false, error: 'Admin access required' });
  }
  next();
};
