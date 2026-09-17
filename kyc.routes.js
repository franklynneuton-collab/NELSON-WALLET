const express = require('express');
const { db } = require('../config/db');
const { requireAuth } = require('../middleware/requireAuth');
const kyc = require('../services/providers/kyc');

const router = express.Router();

router.post('/submit', requireAuth, async (req, res, next) => {
  try {
    const { idType, idNumber, selfieImageBase64 } = req.body;
    if (!idType || !idNumber || !selfieImageBase64) {
      return res.status(400).json({ error: 'missing_fields', required: ['idType', 'idNumber', 'selfieImageBase64'] });
    }

    const result = await kyc.submitVerification({ userId: req.user.sub, idType, idNumber, selfieImageBase64 });
    db.prepare(`UPDATE users SET kyc_status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(result.status, req.user.sub);

    res.status(202).json({ kycStatus: result.status, reference: result.reference });
  } catch (err) { next(err); }
});

router.get('/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(req.user.sub);
  res.json({ kycStatus: user.kyc_status });
});

module.exports = router;
