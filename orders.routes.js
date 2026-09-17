const express = require('express');
const { randomUUID: uuid } = require('crypto');
const { db } = require('../config/db');
const { requireAuth, requireKyc } = require('../middleware/requireAuth');
const { orderSchema } = require('../utils/schemas');
const { getOrCreateWalletAccount, getOrCreateSystemAccount, postTransfer, LedgerError } = require('../services/ledger');
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

// Orders containing at least one of the current user's product listings —
// this is what a seller needs to see to ship/fulfill their sales.
router.get('/selling', requireAuth, (req, res) => {
  const orderIds = db.prepare(`SELECT DISTINCT order_id FROM order_items WHERE seller_id = ?`).all(req.user.sub)
    .map((r) => r.order_id);
  if (orderIds.length === 0) return res.json({ orders: [] });

  const placeholders = orderIds.map(() => '?').join(',');
  const orders = db.prepare(`SELECT * FROM orders WHERE id IN (${placeholders}) ORDER BY created_at DESC`).all(...orderIds);
  const withItems = orders.map((o) => {
    const buyer = db.prepare(`SELECT name, email FROM users WHERE id = ?`).get(o.buyer_id);
    return {
      ...o,
      buyerName: buyer ? buyer.name : 'Unknown',
      buyerEmail: buyer ? buyer.email : null,
      items: db.prepare(`SELECT * FROM order_items WHERE order_id = ? AND seller_id = ?`).all(o.id, req.user.sub),
    };
  });
  res.json({ orders: withItems });
});

router.get('/:id', requireAuth, (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ? AND buyer_id = ?`).get(req.params.id, req.user.sub);
  if (!order) return res.status(404).json({ error: 'not_found' });
  order.items = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(order.id);
  res.json({ order });
});

// Checkout: validates stock, charges the buyer's wallet INTO ESCROW (not
// sellers directly), decrements stock — all inside one atomic DB
// transaction. Sellers are only paid once the order is marked delivered
// (see PATCH /:id/status below). Buyer needs a verified wallet (KYC).
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
      const escrowAccount = getOrCreateSystemAccount('escrow', currency);

      const orderId = uuid();

      // Single transfer: buyer's wallet -> platform escrow, for the full
      // order total. Sellers are NOT paid at this point.
      const tx = postTransfer({
        fromAccountId: buyerAccount.id,
        toAccountId: escrowAccount.id,
        amountCents: totalCents,
        currency,
        type: 'order_payment',
        memo: `Order ${orderId} — held in escrow`,
        idempotencyKey: body.idempotencyKey,
      });

      for (const li of lineItems) {
        db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`).run(li.qty, li.product.id);
      }

      db.prepare(`
        INSERT INTO orders (id, buyer_id, status, escrow_status, total_cents, currency, ledger_transaction_id)
        VALUES (?, ?, 'processing', 'held', ?, ?, ?)
      `).run(orderId, req.user.sub, totalCents, currency, tx.id);

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
      body: `Order ${result.orderId} confirmed — ${(result.totalCents / 100).toFixed(2)} ${result.currency} is held in escrow until delivery.`,
    });
    for (const li of result.lineItems) {
      await notifications.notify(li.product.seller_id, {
        type: 'sold', title: 'Product Sold!',
        body: `${li.product.name} x${li.qty} just sold. Payout releases once the order is marked delivered.`,
      });
    }

    res.status(201).json({ orderId: result.orderId, totalCents: result.totalCents, currency: result.currency, escrowStatus: 'held' });
  } catch (err) { next(err); }
});

const VALID_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'];

router.patch('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
    if (!order) return res.status(404).json({ error: 'not_found' });

    const items = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(order.id);
    const isBuyer = order.buyer_id === req.user.sub;
    const isSeller = items.some((i) => i.seller_id === req.user.sub);

    // Buyer confirms delivery (releases escrow) or cancels their own order
    // (only while still processing, before a seller has shipped it).
    // A seller on the order can mark it shipped.
    if (status === 'delivered' && !isBuyer) return res.status(403).json({ error: 'forbidden', message: 'Only the buyer can confirm delivery.' });
    if (status === 'cancelled' && !isBuyer) return res.status(403).json({ error: 'forbidden', message: 'Only the buyer can cancel an order.' });
    if (status === 'shipped' && !isSeller) return res.status(403).json({ error: 'forbidden', message: 'Only a seller on this order can mark it shipped.' });
    if (!isBuyer && !isSeller) return res.status(403).json({ error: 'forbidden' });

    if (status === 'cancelled') {
      if (order.escrow_status !== 'held') {
        return res.status(409).json({ error: 'cannot_cancel', message: `Escrow already ${order.escrow_status} — order can no longer be cancelled.` });
      }
      if (order.status === 'shipped') {
        return res.status(409).json({ error: 'cannot_cancel', message: 'Order has already shipped — contact the seller instead of cancelling.' });
      }
    }
    if (status === 'delivered' && order.escrow_status !== 'held') {
      return res.status(409).json({ error: 'already_settled', message: `Escrow already ${order.escrow_status}.` });
    }

    const escrowAccount = getOrCreateSystemAccount('escrow', order.currency);

    if (status === 'delivered') {
      // Release escrow to each seller, grouped by seller, in one atomic DB transaction.
      const bySeller = {};
      for (const item of items) {
        bySeller[item.seller_id] = (bySeller[item.seller_id] || 0) + item.unit_price_cents * item.qty;
      }

      const releaseAll = db.transaction(() => {
        for (const [sellerId, amountCents] of Object.entries(bySeller)) {
          const sellerAccount = getOrCreateWalletAccount(sellerId, order.currency);
          postTransfer({
            fromAccountId: escrowAccount.id,
            toAccountId: sellerAccount.id,
            amountCents,
            currency: order.currency,
            type: 'payout',
            memo: `Order ${order.id} — released on delivery`,
            idempotencyKey: `escrow-release-${order.id}-${sellerId}`,
          });
        }
        db.prepare(`UPDATE orders SET status = ?, escrow_status = 'released', updated_at = datetime('now') WHERE id = ?`)
          .run(status, order.id);
      });
      releaseAll();

      for (const sellerId of Object.keys(bySeller)) {
        await notifications.notify(sellerId, {
          type: 'payment', title: 'Payout Released',
          body: `${(bySeller[sellerId] / 100).toFixed(2)} ${order.currency} from order ${order.id} has been added to your wallet.`,
        });
      }
    } else if (status === 'cancelled') {
      // Refund the full escrowed amount back to the buyer and restock items.
      const refundAll = db.transaction(() => {
        const buyerAccount = getOrCreateWalletAccount(order.buyer_id, order.currency);
        postTransfer({
          fromAccountId: escrowAccount.id,
          toAccountId: buyerAccount.id,
          amountCents: order.total_cents,
          currency: order.currency,
          type: 'refund',
          memo: `Order ${order.id} — cancelled, refunded from escrow`,
          idempotencyKey: `escrow-refund-${order.id}`,
        });
        for (const item of items) {
          db.prepare(`UPDATE products SET stock = stock + ? WHERE id = ?`).run(item.qty, item.product_id);
        }
        db.prepare(`UPDATE orders SET status = ?, escrow_status = 'refunded', updated_at = datetime('now') WHERE id = ?`)
          .run(status, order.id);
      });
      refundAll();

      await notifications.notify(order.buyer_id, {
        type: 'refund', title: 'Order Cancelled — Refunded',
        body: `${(order.total_cents / 100).toFixed(2)} ${order.currency} from order ${order.id} has been refunded to your wallet.`,
      });
    } else {
      // processing / shipped: no money movement, just a status update.
      db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, order.id);
    }

    res.json({ order: { ...order, status, escrow_status: status === 'delivered' ? 'released' : status === 'cancelled' ? 'refunded' : order.escrow_status } });
  } catch (err) { next(err); }
});

module.exports = router;
