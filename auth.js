const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { randomUUID: uuid } = require('crypto');
const { db } = require('../config/db');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MB, OWASP-recommended minimum for argon2id
  timeCost: 2,
  parallelism: 1,
};

function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Generate one (e.g. `openssl rand -hex 32`) and put it in your .env file.'
    );
  }
  return secret;
}

async function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTS);
}

async function verifyPassword(hash, password) {
  return argon2.verify(hash, password);
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    requireJwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function issueRefreshToken(userId) {
  const raw = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400000).toISOString();

  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(uuid(), userId, tokenHash, expiresAt);

  return raw;
}

function verifyRefreshToken(raw) {
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const row = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime('now')
  `).get(tokenHash);
  return row || null;
}

function revokeRefreshToken(raw) {
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?`).run(tokenHash);
}

function verifyAccessToken(token) {
  return jwt.verify(token, requireJwtSecret());
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  verifyAccessToken,
};
