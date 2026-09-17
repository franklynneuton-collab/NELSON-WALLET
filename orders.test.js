const request = require('supertest');
const { migrate, db } = require('../config/db');
migrate();
const createApp = require('../app');
const { getOrCreateWalletAccount, getOrCreateSystemAccount, postTransfer } = require('../services/ledger');

const app = createApp();

async function registerAndLogin(emailPrefix) {
  const email = `${emailPrefix}-${Date.now()}-${Math.random()}@example.com`;
  const password = 'Str0ngPassw0rd!';
  const reg = await request(app).post('/auth/register').send({ name: emailPrefix, email, password });
  return { userId: reg.body.user.id, accessToken: reg.body.accessToken, email };
}

function markVerified(userId) {
  db.prepare(`UPDATE users SET kyc_status = 'verified' WHERE id = ?`).run(userId);
}

describe('orders checkout', () => {
  test('checkout pays the seller, decrements stock, and requires KYC', async () => {
    const seller = await registerAndLogin('seller');
    const buyer = await registerAndLogin('buyer');
    markVerified(buyer.userId);
    markVerified(seller.userId);

    // Fund the buyer's wallet directly via the ledger (bypassing Paystack, which isn't configured in tests).
    const external = getOrCreateSystemAccount('external', 'USD');
    const buyerAccount = getOrCreateWalletAccount(buyer.userId, 'USD');
    postTransfer({
      fromAccountId: external.id, toAccountId: buyerAccount.id, amountCents: 10000,
      currency: 'USD', type: 'add_money', idempotencyKey: `fund-${buyer.userId}`, allowNegative: true,
    });

    const productRes = await request(app).post('/products')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ name: 'Leather Wallet', priceCents: 3000, stock: 5 });
    expect(productRes.status).toBe(201);
    const productId = productRes.body.product.id;

    const orderRes = await request(app).post('/orders')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ items: [{ productId, qty: 2 }], idempotencyKey: `order-${Date.now()}` });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.totalCents).toBe(6000);

    const product = await request(app).get(`/products/${productId}`);
    expect(product.body.product.stock).toBe(3);

    const sellerBalance = await request(app).get('/wallet/balance')
      .set('Authorization', `Bearer ${seller.accessToken}`);
    expect(sellerBalance.body.balanceCents).toBe(6000);

    const buyerBalance = await request(app).get('/wallet/balance')
      .set('Authorization', `Bearer ${buyer.accessToken}`);
    expect(buyerBalance.body.balanceCents).toBe(4000);
  });

  test('checkout is rejected for an unverified (non-KYC) buyer', async () => {
    const seller = await registerAndLogin('seller2');
    const buyer = await registerAndLogin('buyer2');
    markVerified(seller.userId); // buyer stays unverified

    const productRes = await request(app).post('/products')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ name: 'Sneakers', priceCents: 5000, stock: 5 });

    const orderRes = await request(app).post('/orders')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ items: [{ productId: productRes.body.product.id, qty: 1 }], idempotencyKey: `order-${Date.now()}` });

    expect(orderRes.status).toBe(403);
    expect(orderRes.body.error).toBe('kyc_required');
  });

  test('checkout fails cleanly when stock is insufficient — no partial charge', async () => {
    const seller = await registerAndLogin('seller3');
    const buyer = await registerAndLogin('buyer3');
    markVerified(buyer.userId);
    markVerified(seller.userId);

    const external = getOrCreateSystemAccount('external', 'USD');
    const buyerAccount = getOrCreateWalletAccount(buyer.userId, 'USD');
    postTransfer({
      fromAccountId: external.id, toAccountId: buyerAccount.id, amountCents: 10000,
      currency: 'USD', type: 'add_money', idempotencyKey: `fund2-${buyer.userId}`, allowNegative: true,
    });

    const productRes = await request(app).post('/products')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ name: 'Rare Watch', priceCents: 9000, stock: 1 });

    const orderRes = await request(app).post('/orders')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ items: [{ productId: productRes.body.product.id, qty: 5 }], idempotencyKey: `order-${Date.now()}` });

    expect(orderRes.status).toBe(400);

    const balance = await request(app).get('/wallet/balance')
      .set('Authorization', `Bearer ${buyer.accessToken}`);
    expect(balance.body.balanceCents).toBe(10000); // untouched
  });
});
