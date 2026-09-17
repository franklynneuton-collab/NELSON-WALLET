const express = require('express');
const { randomUUID: uuid } = require('crypto');
const { db } = require('../config/db');
const { requireAuth, requireKyc } = require('../middleware/requireAuth');
const { orderSchema } = require('../utils/schemas');
const { getOrCreateWalletAccount, postTransfer, LedgerError } = require('../services/ledger');
const notifications = require('../services/notifications');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const orders = db.prepare(`SELECT * FROM orders WHERE buyer_id = ? ORDER BY created_at DESC`).all(req.user.sub);
  const withItems = orders.map((o) => ({
    ...o,
    items: db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(o.id),
  }));
  res.json({ orders: withItems });
});

router.get('/:id', requireAuth, (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ? AND buyer_id = ?`).get(req.params.id, req.user.sub);
  if (!order) return res.status(404).json({ error: 'not_found' });
  order.items = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(order.id);
  res.json({ order });
});

// Checkout: validates stock, charges the buyer's wallet, pays each seller,
// decrements stock — all inside one atomic DB transaction. Buyer needs a
// verified wallet balance (KYC) since this moves real money between users.
router.post('/', requireAuth, requireKyc, async (req, res, next) => {
  try {
    const body = orderSchema.parse(req.body);

    const runCheckout = db.transaction(() => {
      const lineItems = body.items.map(({ productId, qty }) => {
        const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = ?').get(productId, 'live');
        if (!product) throw new LedgerError(`product ${productId} not available`, 'PRODUCT_UNAVAILABLE');
        if (product.stock < qty) throw new LedgerError(`insufficient stock for ${product.name}`, 'INSUFFICIENT_STOCK');
        return { product, qty };
      });

      const currency = lineItems[0].product.currency;
      if (!lineItems.every((li) => li.product.currency === currency)) {
        throw new LedgerError('all items in one order must share a currency', 'MIXED_CURRENCY');
      }

      const totalCents = lineItems.reduce((sum, li) => sum + li.product.price_cents * li.qty, 0);
      const buyerAccount = getOrCreateWalletAccount(req.user.sub, currency);

      const orderId = uuid();
      let ledgerTxId = null;

      // Pay each seller directly (marketplace model, no platform escrow yet —
      // add an 'escrow' account + release-on-delivery flow before real launch).
      for (const li of lineItems) {
        const sellerAccount = getOrCreateWalletAccount(li.product.seller_id, currency);
        const tx = postTransfer({
          fromAccountId: buyerAccount.id,
          toAccountId: sellerAccount.id,
          amountCents: li.product.price_cents * li.qty,
          currency,
          type: 'order_payment',
          memo: `Order ${orderId} — ${li.product.name} x${li.qty}`,
          idempotencyKey: `${body.idempotencyKey}-${li.product.id}`,
        });
        ledgerTxId = ledgerTxId || tx.id;

        db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`).run(li.qty, li.product.id);
      }

      db.prepare(`
        INSERT INTO orders (id, buyer_id, status, total_cents, currency, ledger_transaction_id)
        VALUES (?, ?, 'processing', ?, ?, ?)
      `).run(orderId, req.user.sub, totalCents, currency, ledgerTxId);

      for (const li of lineItems) {
        db.prepare(`
          INSERT INTO order_items (id, order_id, product_id, seller_id, name, unit_price_cents, qty)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuid(), orderId, li.product.id, li.product.seller_id, li.product.name, li.product.price_cents, li.qty);
      }

      return { orderId, totalCents, currency, lineItems };
    });

    const result = runCheckout();

    await notifications.notify(req.user.sub, {
      type: 'order', title: 'Order Placed!',
      body: `Order ${result.orderId} confirmed — ${(result.totalCents / 100).toFixed(2)} ${result.currency}.`,
    });
    for (const li of result.lineItems) {
      await notifications.notify(li.product.seller_id, {
        type: 'sold', title: 'Product Sold!',
        body: `${li.product.name} x${li.qty} just sold.`,
      });
    }

    res.status(201).json({ orderId: result.orderId, totalCents: result.totalCents, currency: result.currency });
  } catch (err) { next(err); }
});

router.patch('/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  if (!['processing', 'shipped', 'delivered', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  res.json({ order: { ...order, status } });
});

module.exports = router;
