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
  test('checkout escrows payment (not paid to seller yet) and decrements stock', async () => {
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
    expect(orderRes.body.escrowStatus).toBe('held');

    const product = await request(app).get(`/products/${productId}`);
    expect(product.body.product.stock).toBe(3);

    // Seller is NOT paid yet — funds sit in escrow until delivery.
    const sellerBalance = await request(app).get('/wallet/balance')
      .set('Authorization', `Bearer ${seller.accessToken}`);
    expect(sellerBalance.body.balanceCents).toBe(0);

    const buyerBalance = await request(app).get('/wallet/balance')
      .set('Authorization', `Bearer ${buyer.accessToken}`);
    expect(buyerBalance.body.balanceCents).toBe(4000);
  });

  test('marking an order delivered releases escrow to the seller', async () => {
    const seller = await registerAndLogin('seller-deliver');
    const buyer = await registerAndLogin('buyer-deliver');
    markVerified(buyer.userId);
    markVerified(seller.userId);

    const external = getOrCreateSystemAccount('external', 'USD');
    const buyerAccount = getOrCreateWalletAccount(buyer.userId, 'USD');
    postTransfer({
      fromAccountId: external.id, toAccountId: buyerAccount.id, amountCents: 10000,
      currency: 'USD', type: 'add_money', idempotencyKey: `fund-deliver-${buyer.userId}`, allowNegative: true,
    });

    const productRes = await request(app).post('/products')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ name: 'Sunglasses', priceCents: 2500, stock: 10 });

    const orderRes = await request(app).post('/orders')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ items: [{ productId: productRes.body.product.id, qty: 1 }], idempotencyKey: `order-deliver-${Date.now()}` });
    const orderId = orderRes.body.orderId;

    // Still unpaid before delivery.
    let sellerBalance = await request(app).get('/wallet/balance').set('Authorization', `Bearer ${seller.accessToken}`);
    expect(sellerBalance.body.balanceCents).toBe(0);

    const deliverRes = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ status: 'delivered' });
    expect(deliverRes.status).toBe(200);
    expect(deliverRes.body.order.escrow_status).toBe('released');

    sellerBalance = await request(app).get('/wallet/balance').set('Authorization', `Bearer ${seller.accessToken}`);
    expect(sellerBalance.body.balanceCents).toBe(2500);

    // Marking delivered twice must not pay the seller twice.
    const secondDeliver = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ status: 'delivered' });
    expect(secondDeliver.status).toBe(409);

    sellerBalance = await request(app).get('/wallet/balance').set('Authorization', `Bearer ${seller.accessToken}`);
    expect(sellerBalance.body.balanceCents).toBe(2500); // unchanged
  });

  test('seller can see the order via /orders/selling and mark it shipped; buyer cannot ship, seller cannot cancel', async () => {
    const seller = await registerAndLogin('seller-auth');
    const buyer = await registerAndLogin('buyer-auth');
    markVerified(buyer.userId);
    markVerified(seller.userId);

    const external = getOrCreateSystemAccount('external', 'USD');
    const buyerAccount = getOrCreateWalletAccount(buyer.userId, 'USD');
    postTransfer({
      fromAccountId: external.id, toAccountId: buyerAccount.id, amountCents: 10000,
      currency: 'USD', type: 'add_money', idempotencyKey: `fund-auth-${buyer.userId}`, allowNegative: true,
    });

    const productRes = await request(app).post('/products')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ name: 'Cap', priceCents: 1500, stock: 5 });

    const orderRes = await request(app).post('/orders')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ items: [{ productId: productRes.body.product.id, qty: 1 }], idempotencyKey: `order-auth-${Date.now()}` });
    const orderId = orderRes.body.orderId;

    const sellingRes = await request(app).get('/orders/selling').set('Authorization', `Bearer ${seller.accessToken}`);
    expect(sellingRes.status).toBe(200);
    expect(sellingRes.body.orders.some((o) => o.id === orderId)).toBe(true);

    // Buyer cannot mark it shipped.
    const buyerShip = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${buyer.accessToken}`).send({ status: 'shipped' });
    expect(buyerShip.status).toBe(403);

    // Seller can mark it shipped.
    const sellerShip = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${seller.accessToken}`).send({ status: 'shipped' });
    expect(sellerShip.status).toBe(200);

    // Seller cannot cancel.
    const sellerCancel = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${seller.accessToken}`).send({ status: 'cancelled' });
    expect(sellerCancel.status).toBe(403);

    // Buyer cannot cancel after it's shipped.
    const buyerCancel = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${buyer.accessToken}`).send({ status: 'cancelled' });
    expect(buyerCancel.status).toBe(409);
  });

  test('cancelling a held order refunds the buyer and restocks the item', async () => {
    const seller = await registerAndLogin('seller-cancel');
    const buyer = await registerAndLogin('buyer-cancel');
    markVerified(buyer.userId);
    markVerified(seller.userId);

    const external = getOrCreateSystemAccount('external', 'USD');
    const buyerAccount = getOrCreateWalletAccount(buyer.userId, 'USD');
    postTransfer({
      fromAccountId: external.id, toAccountId: buyerAccount.id, amountCents: 10000,
      currency: 'USD', type: 'add_money', idempotencyKey: `fund-cancel-${buyer.userId}`, allowNegative: true,
    });

    const productRes = await request(app).post('/products')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ name: 'Backpack', priceCents: 4000, stock: 3 });
    const productId = productRes.body.product.id;

    const orderRes = await request(app).post('/orders')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ items: [{ productId, qty: 1 }], idempotencyKey: `order-cancel-${Date.now()}` });
    const orderId = orderRes.body.orderId;

    let product = await request(app).get(`/products/${productId}`);
    expect(product.body.product.stock).toBe(2);

    const cancelRes = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ status: 'cancelled' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.order.escrow_status).toBe('refunded');

    const buyerBalance = await request(app).get('/wallet/balance').set('Authorization', `Bearer ${buyer.accessToken}`);
    expect(buyerBalance.body.balanceCents).toBe(10000); // fully refunded

    product = await request(app).get(`/products/${productId}`);
    expect(product.body.product.stock).toBe(3); // restocked

    // Can't cancel again once refunded.
    const secondCancel = await request(app).patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ status: 'cancelled' });
    expect(secondCancel.status).toBe(409);
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
