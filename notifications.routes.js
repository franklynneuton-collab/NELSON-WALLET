const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const notifications = require('../services/notifications');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json({ notifications: notifications.list(req.user.sub, Number(req.query.limit) || 50) });
});

router.post('/:id/read', requireAuth, (req, res) => {
  notifications.markRead(req.user.sub, req.params.id);
  res.status(204).send();
});

router.post('/read-all', requireAuth, (req, res) => {
  notifications.markAllRead(req.user.sub);
  res.status(204).send();
});

module.exports = router;
