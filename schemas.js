const { z } = require('zod');

const registerSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(10).max(128)
    .regex(/[A-Z]/, 'must contain an uppercase letter')
    .regex(/[a-z]/, 'must contain a lowercase letter')
    .regex(/[0-9]/, 'must contain a number'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const sendMoneySchema = z.object({
  recipientEmail: z.string().email(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  note: z.string().max(200).optional(),
  idempotencyKey: z.string().min(8),
});

const addMoneySchema = z.object({
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  idempotencyKey: z.string().min(8),
});

const exchangeSchema = z.object({
  fromCurrency: z.string().length(3),
  toCurrency: z.string().length(3),
  amountCents: z.number().int().positive(),
  idempotencyKey: z.string().min(8),
});

const productSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  priceCents: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  stock: z.number().int().min(0).default(0),
  lowStockAt: z.number().int().min(0).default(0),
  tags: z.string().max(300).optional(),
  sku: z.string().max(60).optional(),
  status: z.enum(['draft', 'live', 'paused', 'sold_out', 'removed']).optional(),
});

const orderSchema = z.object({
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number().int().positive(),
  })).min(1),
  idempotencyKey: z.string().min(8),
});

module.exports = {
  registerSchema, loginSchema, sendMoneySchema, addMoneySchema,
  exchangeSchema, productSchema, orderSchema,
};
