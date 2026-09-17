# NELSON × Potafoglio — Backend

A real, tested Node/Express + SQLite backend for the marketplace + wallet app.
This covers steps 1–8 of the build plan (auth, ledger, payments plumbing,
marketplace, notifications, security, tests). It is **not** yet wired to the
6,850-line frontend prototype, and three external integrations are stubbed
pending your real credentials (see below) — using this in production before
those are filled in would move fake money and skip identity checks.

## Run it

```bash
npm install
cp .env.example .env
# edit .env — at minimum set JWT_SECRET (openssl rand -hex 32)
npm run dev      # http://localhost:4000
npm test         # 16 tests, all passing: auth, ledger, checkout
```

## What's real

- **Auth** — Argon2id password hashing (OWASP-recommended params), JWT
  access tokens (15 min) + rotating refresh tokens (30 days, revoked on use),
  rate-limited login/register, no user-enumeration on failed login.
- **Ledger** — true double-entry accounting. Every money movement is a
  balanced debit+credit pair inside one atomic SQLite transaction.
  Idempotency keys prevent double-processing (e.g. a retried request).
  Insufficient-funds and invalid-amount checks throw before anything is
  written — verified by test (`ledger.test.js`).
- **Checkout** — validates stock, checks currency consistency, charges the
  buyer, pays each seller, decrements stock — all in one atomic transaction.
  A failed checkout leaves balances and stock completely untouched (tested).
- **KYC gating** — sending money, adding money, exchanging, and checkout all
  require `kyc_status = 'verified'` on the account (403 `kyc_required`
  otherwise).
- **Security middleware** — helmet, CORS, general + auth-specific rate
  limiting, Zod input validation on every write endpoint, centralized error
  handling that never leaks stack traces.

## What's stubbed (needs your credentials)

These live behind clean interfaces in `src/services/providers/` — plug in
real credentials in `.env` and nothing else in the codebase changes:

| Provider | File | What it needs | Stub behavior |
|---|---|---|---|
| Paystack (payments) | `providers/paystack.js` | `PAYSTACK_SECRET_KEY` | Returns a fake reference, never marks a payment succeeded |
| Smile Identity (KYC) | `providers/kyc.js` | `SMILE_IDENTITY_API_KEY` | Marks submissions "pending" forever, never auto-verifies |
| Firebase FCM (push) | `providers/push.js` | `FIREBASE_SERVICE_ACCOUNT_JSON` | Skips the push; in-app notification is still recorded |

**Important on money flow**: `/wallet/add-money/initiate` never credits a
wallet by itself — only the Paystack webhook (`/webhooks/paystack`), after
verifying the signature, does that. This is deliberate: never trust a
client-reported "payment succeeded."

## What's genuinely not done yet (steps 7–8, partially)

- **AI features** (assistant chat, voice search, image search) — the
  frontend prototype has UI shells for these; this backend has no endpoints
  for them yet. Need to decide: wire to a real model (e.g. via your OmniAI
  platform) or scope out of v1.
- **Escrow** — checkout currently pays sellers immediately on order
  placement. A real marketplace usually escrows funds until delivery
  confirmation — worth adding before real transaction volume.
- **FX rates** — `/wallet/exchange` uses a placeholder 1:1 rate. Needs a
  real rate provider before launch.
- **Frontend wiring** — nothing in the uploaded HTML prototype calls this
  API yet; it still runs on localStorage. That's the next piece of work.
- **Device registration** — push notifications have no way to learn a
  user's device token yet (`notifications.js` has a `// TODO`).
- **Native build** — this backend is platform-agnostic, but the frontend
  is browser-Babel React and isn't store-shippable as-is (see step 9 of the
  original plan — React Native or Capacitor wrapping still needed).

## API surface

```
POST /auth/register            POST /auth/login          POST /auth/refresh
POST /auth/logout              GET  /auth/me

GET  /wallet/balance           GET  /wallet/transactions
POST /wallet/send              POST /wallet/add-money/initiate
POST /wallet/exchange

POST /kyc/submit               GET  /kyc/status

GET  /products                 GET  /products/mine        GET /products/:id
POST /products                 PATCH /products/:id        DELETE /products/:id

GET  /orders                   GET  /orders/:id           POST /orders
PATCH /orders/:id/status

GET  /notifications            POST /notifications/:id/read
POST /notifications/read-all

POST /webhooks/paystack
```

All amounts are integer cents to avoid floating-point money bugs.
