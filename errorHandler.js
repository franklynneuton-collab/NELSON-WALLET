const { LedgerError } = require('../services/ledger');
const { ZodError } = require('zod');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation_error', details: err.errors });
  }
  if (err instanceof LedgerError) {
    const status = err.code === 'INSUFFICIENT_FUNDS' ? 422 : 400;
    return res.status(status).json({ error: err.code.toLowerCase(), message: err.message });
  }

  console.error(err); // eslint-disable-line no-console
  return res.status(500).json({ error: 'internal_error' });
}

module.exports = errorHandler;
