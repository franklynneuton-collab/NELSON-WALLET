const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const walletRoutes = require('./routes/wallet.routes');
const productRoutes = require('./routes/products.routes');
const orderRoutes = require('./routes/orders.routes');
const notificationRoutes = require('./routes/notifications.routes');
const kycRoutes = require('./routes/kyc.routes');
const webhookRoutes = require('./routes/webhooks.routes');
const errorHandler = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(morgan(process.env.NODE_ENV === 'test' ? 'dev' : 'combined'));

  // Webhooks need the raw body for signature verification — the raw parser
  // must run before the router, and this whole block before express.json().
  app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

  app.use(express.json({ limit: '2mb' }));

  // General API rate limit; auth gets a stricter one to slow credential stuffing.
  app.use('/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true }));
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/auth', authLimiter, authRoutes);
  app.use('/wallet', walletRoutes);
  app.use('/products', productRoutes);
  app.use('/orders', orderRoutes);
  app.use('/notifications', notificationRoutes);
  app.use('/kyc', kycRoutes);

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
