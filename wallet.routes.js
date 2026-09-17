const express = require('express');
const { db } = require('../config/db');
const { requireAuth, requireKyc } = require('../middleware/requireAuth');
const {
  getOrCreateWalletAccount, getOrCreateSystemAccount,
  balanceOf, postTransfer, transactionHistory,
} = require('../services/ledger');
const { sendMoneySchema, addMoneySchema, exchangeSchema } = require('../utils/schemas');
const paystack = require('../services/providers/paystack');
const notifications = require('../services/notifications');

const router = express.Router();

router.get('/balance', requireAuth, (req, res) => {
  const account = getOrCreateWalletAccount(req.user.sub, req.query.currency || 'USD');
  res.json({ currency: account.currency, balanceCents: balanceOf(account.id) });
});

router.get('/transactions', requireAuth, (req, res) => {
  const account = getOrCreateWalletAccount(req.user.sub, req.query.currency || 'USD');
  res.json({ transactions: transactionHistory(account.id, Number(req.query.limit) || 50) });
});

// Money movement requires a KYC-verified account.
router.post('/send', requireAuth, requireKyc, async (req, res, next) => {
  try {
    const body = sendMoneySchema.parse(req.body);
    const recipient = db.prepare('SELECT id FROM users WHERE email = ?').get(body.recipientEmail);
    if (!recipient) return res.status(404).json({ error: 'recipient_not_found' });
    if (recipient.id === req.user.sub) return res.status(400).json({ error: 'cannot_send_to_self' });

    const fromAccount = getOrCreateWalletAccount(req.user.sub, body.currency);
    const toAccount = getOrCreateWalletAccount(recipient.id, body.currency);

    const tx = postTransfer({
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      amountCents: body.amountCents,
      currency: body.currency,
      type: 'send',
      memo: body.note,
      idempotencyKey: body.idempotencyKey,
    });

    await notifications.notify(recipient.id, {
      type: 'payment', title: 'Payment Received',
      body: `You received ${(body.amountCents / 100).toFixed(2)} ${body.currency}.`,
    });

    res.status(201).json({ transactionId: tx.id, deduped: tx.deduped });
  } catch (err) { next(err); }
});

// Add money: creates a Paystack payment intent. Ledger is only credited once
// the payment is verified (see /webhooks/paystack) — never on this call directly.
router.post('/add-money/initiate', requireAuth, requireKyc, async (req, res, next) => {
  try {
    const body = addMoneySchema.parse(req.body);
    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.sub);

    const intent = await paystack.initializeTransaction({
      email: user.email, amountCents: body.amountCents, currency: body.currency,
      metadata: { userId: req.user.sub, idempotencyKey: body.idempotencyKey },
    });

    const { randomUUID: uuid } = require('crypto');
    db.prepare(`
      INSERT INTO payment_intents (id, user_id, provider, provider_ref, amount_cents, currency, status)
      VALUES (?, ?, 'paystack', ?, ?, ?, 'pending')
    `).run(uuid(), req.user.sub, intent.reference, body.amountCents, body.currency);

    res.status(201).json({
      reference: intent.reference,
      authorizationUrl: intent.authorizationUrl,
      note: paystack.configured ? undefined : 'Paystack not configured — this is a stub reference, no real payment will occur.',
    });
  } catch (err) { next(err); }
});

router.post('/exchange', requireAuth, requireKyc, async (req, res, next) => {
  try {
    const body = exchangeSchema.parse(req.body);
    // TODO: replace with a real FX rate provider; 1:1 is a placeholder so the
    // ledger mechanics (two accounts, two currencies) can be built and tested now.
    const rate = 1;
    const convertedCents = Math.round(body.amountCents * rate);

    const fromAccount = getOrCreateWalletAccount(req.user.sub, body.fromCurrency);
    const toAccount = getOrCreateWalletAccount(req.user.sub, body.toCurrency);
    const fxSystemAccount = getOrCreateSystemAccount('fee_revenue', body.fromCurrency);

    // Debit the source currency wallet, credit an FX clearing account, then
    // credit the destination currency wallet from system liquidity. Modeled
    // as two linked transfers so each stays single-currency and balanced.
    const tx1 = postTransfer({
      fromAccountId: fromAccount.id, toAccountId: fxSystemAccount.id,
      amountCents: body.amountCents, currency: body.fromCurrency,
      type: 'exchange', memo: `FX ${body.fromCurrency}->${body.toCurrency}`,
      idempotencyKey: `${body.idempotencyKey}-out`,
    });
    const toSystemAccount = getOrCreateSystemAccount('fee_revenue', body.toCurrency);
    const tx2 = postTransfer({
      fromAccountId: toSystemAccount.id, toAccountId: toAccount.id,
      amountCents: convertedCents, currency: body.toCurrency,
      type: 'exchange', memo: `FX ${body.fromCurrency}->${body.toCurrency}`,
      idempotencyKey: `${body.idempotencyKey}-in`,
      allowNegative: true, // system liquidity account; replace with real treasury logic before production
    });

    res.status(201).json({ debitTransactionId: tx1.id, creditTransactionId: tx2.id, rate, convertedCents });
  } catch (err) { next(err); }
});

module.exports = router;
