const express = require('express');
const { randomUUID: uuid } = require('crypto');
const { db } = require('../config/db');
const {
  hashPassword, verifyPassword, signAccessToken,
  issueRefreshToken, verifyRefreshToken, revokeRefreshToken,
} = require('../services/auth');
const { getOrCreateWalletAccount } = require('../services/ledger');
const { registerSchema, loginSchema } = require('../utils/schemas');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email);
    if (existing) return res.status(409).json({ error: 'email_already_registered' });

    const passwordHash = await hashPassword(body.password);
    const userId = uuid();
    db.prepare(`
      INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)
    `).run(userId, body.email, body.name, passwordHash);

    getOrCreateWalletAccount(userId, 'USD');

    const user = { id: userId, email: body.email, role: 'user' };
    const accessToken = signAccessToken(user);
    const refreshToken = issueRefreshToken(userId);

    res.status(201).json({
      user: { id: userId, email: body.email, name: body.name, kycStatus: 'unverified' },
      accessToken, refreshToken,
    });
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email);
    // Constant-shape response whether the user exists or not, to avoid user enumeration.
    if (!user || !(await verifyPassword(user.password_hash, body.password))) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = issueRefreshToken(user.id);

    res.json({
      user: { id: user.id, email: user.email, name: user.name, kycStatus: user.kyc_status },
      accessToken, refreshToken,
    });
  } catch (err) { next(err); }
});

router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'missing_refresh_token' });

  const row = verifyRefreshToken(refreshToken);
  if (!row) return res.status(401).json({ error: 'invalid_or_expired_refresh_token' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return res.status(401).json({ error: 'invalid_refresh_token' });

  // Rotate: revoke the old refresh token, issue a new pair.
  revokeRefreshToken(refreshToken);
  const accessToken = signAccessToken(user);
  const newRefreshToken = issueRefreshToken(user.id);
  res.json({ accessToken, refreshToken: newRefreshToken });
});

router.post('/logout', requireAuth, (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) revokeRefreshToken(refreshToken);
  res.status(204).send();
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, kyc_status, role FROM users WHERE id = ?')
    .get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ user: { id: user.id, email: user.email, name: user.name, kycStatus: user.kyc_status, role: user.role } });
});

module.exports = router;
