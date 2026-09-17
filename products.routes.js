const express = require('express');
const { randomUUID: uuid } = require('crypto');
const { db } = require('../config/db');
const { requireAuth } = require('../middleware/requireAuth');
const { productSchema } = require('../utils/schemas');

const router = express.Router();

router.get('/', (req, res) => {
  const { q, status = 'live' } = req.query;
  let rows;
  if (q) {
    rows = db.prepare(`
      SELECT * FROM products WHERE status = ? AND (name LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT 100
    `).all(status, `%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare(`SELECT * FROM products WHERE status = ? ORDER BY created_at DESC LIMIT 100`).all(status);
  }
  res.json({ products: rows });
});

router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC`).all(req.user.sub);
  res.json({ products: rows });
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ product: row });
});

router.post('/', requireAuth, (req, res, next) => {
  try {
    const body = productSchema.parse(req.body);
    const id = uuid();
    db.prepare(`
      INSERT INTO products (id, seller_id, name, description, price_cents, currency, stock, low_stock_at, tags, sku)
      VALUES (@id, @seller_id, @name, @description, @price_cents, @currency, @stock, @low_stock_at, @tags, @sku)
    `).run({
      id, seller_id: req.user.sub, name: body.name, description: body.description || null,
      price_cents: body.priceCents, currency: body.currency, stock: body.stock,
      low_stock_at: body.lowStockAt, tags: body.tags || null, sku: body.sku || null,
    });
    res.status(201).json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
  } catch (err) { next(err); }
});

router.patch('/:id', requireAuth, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (existing.seller_id !== req.user.sub) return res.status(403).json({ error: 'forbidden' });

    const body = productSchema.partial().parse(req.body);
    const merged = { ...existing, ...body };
    db.prepare(`
      UPDATE products SET name=@name, description=@description, price_cents=@price_cents,
        currency=@currency, stock=@stock, low_stock_at=@low_stock_at, tags=@tags, sku=@sku,
        updated_at = datetime('now')
      WHERE id=@id
    `).run({
      id: req.params.id, name: merged.name, description: merged.description,
      price_cents: merged.priceCents ?? merged.price_cents, currency: merged.currency,
      stock: merged.stock, low_stock_at: merged.lowStockAt ?? merged.low_stock_at,
      tags: merged.tags, sku: merged.sku,
    });
    res.json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id) });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.seller_id !== req.user.sub) return res.status(403).json({ error: 'forbidden' });
  db.prepare(`UPDATE products SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.status(204).send();
});

module.exports = router;
