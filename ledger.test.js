const { migrate } = require('../config/db');
migrate();

const {
  getOrCreateWalletAccount, getOrCreateSystemAccount,
  balanceOf, postTransfer, LedgerError,
} = require('../services/ledger');
const { db } = require('../config/db');

// accounts.user_id has a foreign key to users(id) — seed lightweight user
// rows for the fake ids this test file uses, since it exercises the ledger
// directly rather than going through the registration flow.
beforeAll(() => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'x')
  `);
  for (const id of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5', 'user-6', 'user-7']) {
    insert.run(id, `${id}@test.local`, id);
  }
});

describe('ledger', () => {
  test('a transfer debits one account and credits another by the same amount', () => {
    const a = getOrCreateSystemAccount('external', 'USD');
    const b = getOrCreateWalletAccount('user-1', 'USD');

    postTransfer({
      fromAccountId: a.id, toAccountId: b.id, amountCents: 5000, currency: 'USD',
      type: 'add_money', idempotencyKey: 'test-1', allowNegative: true,
    });

    expect(balanceOf(b.id)).toBe(5000);
  });

  test('rejects a transfer that would overdraw the source account', () => {
    const a = getOrCreateWalletAccount('user-2', 'USD');
    const b = getOrCreateWalletAccount('user-3', 'USD');

    expect(() => postTransfer({
      fromAccountId: a.id, toAccountId: b.id, amountCents: 100, currency: 'USD',
      type: 'send', idempotencyKey: 'test-2',
    })).toThrow(LedgerError);

    expect(balanceOf(a.id)).toBe(0);
    expect(balanceOf(b.id)).toBe(0);
  });

  test('same idempotency key is not applied twice', () => {
    const a = getOrCreateSystemAccount('external', 'USD');
    const b = getOrCreateWalletAccount('user-4', 'USD');

    postTransfer({
      fromAccountId: a.id, toAccountId: b.id, amountCents: 1000, currency: 'USD',
      type: 'add_money', idempotencyKey: 'dupe-key', allowNegative: true,
    });
    postTransfer({
      fromAccountId: a.id, toAccountId: b.id, amountCents: 1000, currency: 'USD',
      type: 'add_money', idempotencyKey: 'dupe-key', allowNegative: true,
    });

    expect(balanceOf(b.id)).toBe(1000); // not 2000
  });

  test('rejects non-positive or non-integer amounts', () => {
    const a = getOrCreateSystemAccount('external', 'USD');
    const b = getOrCreateWalletAccount('user-5', 'USD');

    expect(() => postTransfer({
      fromAccountId: a.id, toAccountId: b.id, amountCents: 0, currency: 'USD',
      type: 'add_money', idempotencyKey: 'bad-1', allowNegative: true,
    })).toThrow(LedgerError);

    expect(() => postTransfer({
      fromAccountId: a.id, toAccountId: b.id, amountCents: 10.5, currency: 'USD',
      type: 'add_money', idempotencyKey: 'bad-2', allowNegative: true,
    })).toThrow(LedgerError);
  });

  test('every transaction stays balanced: sum of all entries across the ledger is zero', () => {
    const a = getOrCreateSystemAccount('external', 'USD');
    const b = getOrCreateWalletAccount('user-6', 'USD');
    const c = getOrCreateWalletAccount('user-7', 'USD');

    postTransfer({ fromAccountId: a.id, toAccountId: b.id, amountCents: 3000, currency: 'USD', type: 'add_money', idempotencyKey: 'bal-1', allowNegative: true });
    postTransfer({ fromAccountId: b.id, toAccountId: c.id, amountCents: 1200, currency: 'USD', type: 'send', idempotencyKey: 'bal-2' });

    const { db } = require('../config/db');
    const row = db.prepare(`
      SELECT SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END) AS total FROM ledger_entries
    `).get();
    expect(row.total).toBe(0);
  });
});
