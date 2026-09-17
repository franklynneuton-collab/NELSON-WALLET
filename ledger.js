const { randomUUID: uuid } = require('crypto');
const { db } = require('../config/db');

class LedgerError extends Error {
  constructor(message, code = 'LEDGER_ERROR') {
    super(message);
    this.code = code;
  }
}

/** Ensure a wallet account exists for a user (one per currency). */
function getOrCreateWalletAccount(userId, currency = 'USD') {
  const existing = db.prepare(
    `SELECT * FROM accounts WHERE user_id = ? AND type = 'wallet' AND currency = ?`
  ).get(userId, currency);
  if (existing) return existing;

  const account = { id: uuid(), user_id: userId, type: 'wallet', currency };
  db.prepare(
    `INSERT INTO accounts (id, user_id, type, currency) VALUES (@id, @user_id, @type, @currency)`
  ).run(account);
  return account;
}

/** Ensure a system account exists (external funding, fees, escrow). One per type+currency, no user. */
function getOrCreateSystemAccount(type, currency = 'USD') {
  const existing = db.prepare(
    `SELECT * FROM accounts WHERE type = ? AND currency = ? AND user_id IS NULL`
  ).get(type, currency);
  if (existing) return existing;

  const account = { id: uuid(), user_id: null, type, currency };
  db.prepare(
    `INSERT INTO accounts (id, user_id, type, currency) VALUES (@id, @user_id, @type, @currency)`
  ).run(account);
  return account;
}

function balanceOf(accountId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_cents ELSE 0 END), 0) AS balance
    FROM ledger_entries WHERE account_id = ?
  `).get(accountId);
  return row.balance;
}

/**
 * Post a balanced double-entry transaction: exactly one debit and one credit
 * of equal amount, in the same currency, executed atomically.
 * `fromAccountId` is debited, `toAccountId` is credited.
 * Throws LedgerError (never partially writes) if the debit account has
 * insufficient funds and `allowNegative` is false.
 */
const postTransfer = db.transaction((opts) => {
  const {
    fromAccountId, toAccountId, amountCents, currency,
    type, memo, idempotencyKey, allowNegative = false,
  } = opts;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new LedgerError('amount_cents must be a positive integer', 'INVALID_AMOUNT');
  }

  if (idempotencyKey) {
    const dupe = db.prepare(`SELECT id FROM ledger_transactions WHERE idempotency_key = ?`)
      .get(idempotencyKey);
    if (dupe) return { id: dupe.id, deduped: true };
  }

  if (!allowNegative) {
    const bal = balanceOf(fromAccountId);
    if (bal < amountCents) {
      throw new LedgerError('insufficient funds', 'INSUFFICIENT_FUNDS');
    }
  }

  const txId = uuid();
  db.prepare(`
    INSERT INTO ledger_transactions (id, type, status, memo, idempotency_key)
    VALUES (?, ?, 'posted', ?, ?)
  `).run(txId, type, memo || null, idempotencyKey || null);

  db.prepare(`
    INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount_cents, currency)
    VALUES (?, ?, ?, 'debit', ?, ?)
  `).run(uuid(), txId, fromAccountId, amountCents, currency);

  db.prepare(`
    INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount_cents, currency)
    VALUES (?, ?, ?, 'credit', ?, ?)
  `).run(uuid(), txId, toAccountId, amountCents, currency);

  return { id: txId, deduped: false };
});

function transactionHistory(accountId, limit = 50) {
  return db.prepare(`
    SELECT le.direction, le.amount_cents, le.currency, le.created_at,
           lt.type, lt.memo, lt.id AS transaction_id
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.transaction_id
    WHERE le.account_id = ?
    ORDER BY le.created_at DESC
    LIMIT ?
  `).all(accountId, limit);
}

module.exports = {
  LedgerError,
  getOrCreateWalletAccount,
  getOrCreateSystemAccount,
  balanceOf,
  postTransfer,
  transactionHistory,
};
