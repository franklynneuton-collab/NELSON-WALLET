/**
 * Paystack provider interface. Real implementation calls the Paystack API
 * (https://paystack.com/docs/api/) using PAYSTACK_SECRET_KEY from env, and
 * MUST verify the transaction server-side via /transaction/verify/:reference
 * before crediting any ledger account — never trust a client-reported
 * "success" for money movement.
 *
 * This stub lets the rest of the app be built and tested against a real
 * contract without live credentials. It never marks a payment succeeded on
 * its own — initiate() returns a reference, and verify() must be called
 * (e.g. from Paystack's webhook) before the ledger is credited.
 */
const configured = Boolean(process.env.PAYSTACK_SECRET_KEY);

async function initializeTransaction({ email, amountCents, currency, metadata }) {
  if (!configured) {
    // eslint-disable-next-line no-console
    console.warn('[paystack] PAYSTACK_SECRET_KEY not set — using stub initializer. Do not use in production.');
    return {
      authorizationUrl: null,
      reference: `stub-ref-${Date.now()}`,
      provider: 'stub',
    };
  }

  // Real integration point:
  // const resp = await fetch('https://api.paystack.co/transaction/initialize', {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ email, amount: amountCents, currency, metadata }),
  // });
  throw new Error('Paystack integration not implemented — add the real API call here.');
}

async function verifyTransaction(reference) {
  if (!configured) {
    return { verified: false, provider: 'stub', reason: 'PAYSTACK_SECRET_KEY not configured' };
  }

  // Real integration point:
  // const resp = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
  //   headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  // });
  throw new Error('Paystack integration not implemented — add the real API call here.');
}

/**
 * Verify a webhook signature. Paystack signs webhook bodies with your secret
 * key via HMAC-SHA512 in the `x-paystack-signature` header — always verify
 * this before trusting a webhook payload.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!configured) return false;
  const crypto = require('crypto');
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody).digest('hex');
  return hash === signatureHeader;
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature, configured };
