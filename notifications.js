const { randomUUID: uuid } = require('crypto');
const { db } = require('../config/db');
const push = require('./providers/push');

async function notify(userId, { type, title, body, data }) {
  db.prepare(`
    INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), userId, type, title, body);

  // Best-effort push; never let a push failure break the in-app record above.
  try {
    const deviceToken = null; // TODO: look up from a user_devices table once device registration exists
    if (deviceToken) await push.sendPush({ deviceToken, title, body, data });
  } catch (err) {
    console.error('[notifications] push send failed:', err.message); // eslint-disable-line no-console
  }
}

function list(userId, limit = 50) {
  return db.prepare(`
    SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit);
}

function markRead(userId, id) {
  db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`).run(id, userId);
}

function markAllRead(userId) {
  db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ?`).run(userId);
}

module.exports = { notify, list, markRead, markAllRead };
