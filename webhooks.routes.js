const express = require('express');
const { db } = require('../config/db');
const paystack = require('../services/providers/paystack');
const { getOrCreateWalletAccount, getOrCreateSystemAccount, postTransfer } = require('../services/ledger');
const notifications = require('../services/notifications');

const router = express.Router();

/**
 * Paystack webhook. Mounted with express.raw() in server.js (not express.json())
 * because signature verification needs the exact raw request body.
 * This is the ONLY place a card top-up actually credits a wallet — the
 * /wallet/add-money/initiate call never does, by design.
 */
router.post('/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.body; // Buffer, thanks to express.raw()

  if (!paystack.verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const event = JSON.parse(rawBody.toString('utf8'));
  if (event.event !== 'charge.success') return res.status(200).json({ received: true });

  const reference = event.data.reference;
  const intent = db.prepare(`SELECT * FROM payment_intents WHERE provider_ref = ?`).get(reference);
  if (!intent || intent.status === 'succeeded') return res.status(200).json({ received: true });

  const externalAccount = getOrCreateSystemAccount('external', intent.currency);
  const walletAccount = getOrCreateWalletAccount(intent.user_id, intent.currency);

  const tx = postTransfer({
    fromAccountId: externalAccount.id,
    toAccountId: walletAccount.id,
    amountCents: intent.amount_cents,
    currency: intent.currency,
    type: 'add_money',
    memo: `Paystack top-up ${reference}`,
    idempotencyKey: `paystack-${reference}`,
    allowNegative: true, // external funding source, not a real balance constraint
  });

  db.prepare(`UPDATE payment_intents SET status = 'succeeded', ledger_transaction_id = ? WHERE id = ?`)
    .run(tx.id, intent.id);

  await notifications.notify(intent.user_id, {
    type: 'payment', title: 'Money Added',
    body: `${(intent.amount_cents / 100).toFixed(2)} ${intent.currency} added to your wallet.`,
  });

  res.status(200).json({ received: true });
});

module.exports = router;
