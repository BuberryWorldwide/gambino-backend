// backend/adminAuth.js
module.exports = function adminAuth(req, res, next) {
  const headerKey = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY || '663cb060900fc34fa58bc85b1f70fad4028c2337736b5e548829e49b003364a7';

  if (!headerKey || headerKey !== expected) {
    return res.status(401).json({ success: false, error: 'Admin access required' });
  }
  next();
};
