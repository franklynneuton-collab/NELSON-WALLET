const { verifyAccessToken } = require('../services/auth');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    req.user = verifyAccessToken(token); // { sub, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

/** KYC-gated routes: money movement should require a verified user. */
function requireKyc(req, res, next) {
  const { db } = require('../config/db');
  const user = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(req.user.sub);
  if (!user || user.kyc_status !== 'verified') {
    return res.status(403).json({ error: 'kyc_required', kyc_status: user ? user.kyc_status : 'unverified' });
  }
  next();
}

module.exports = { requireAuth, requireKyc };
