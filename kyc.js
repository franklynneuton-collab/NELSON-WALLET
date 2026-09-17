/**
 * KYC provider interface. Real implementation should call Smile Identity's
 * API (https://docs.smileidentity.com) using SMILE_IDENTITY_PARTNER_ID /
 * SMILE_IDENTITY_API_KEY from env. This stub lets the rest of the app
 * (routes, ledger gating, tests) be built and tested against a real
 * contract without live credentials.
 *
 * Swap the body of `submitVerification` for a real Smile Identity call when
 * credentials are available — nothing else in the codebase needs to change.
 */
const configured = Boolean(process.env.SMILE_IDENTITY_API_KEY);

async function submitVerification({ userId, idType, idNumber, selfieImageBase64 }) {
  if (!configured) {
    // eslint-disable-next-line no-console
    console.warn('[kyc] SMILE_IDENTITY_API_KEY not set — using stub verifier (auto-pending). Do not use in production.');
    return { status: 'pending', provider: 'stub', reference: `stub-${userId}-${Date.now()}` };
  }

  // Real integration point:
  // const resp = await fetch('https://api.smileidentity.com/v1/id_verification', { ... });
  throw new Error('Smile Identity integration not implemented — add the real API call here.');
}

module.exports = { submitVerification, configured };
