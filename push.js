/**
 * Push notification provider interface. Real implementation uses
 * firebase-admin with FIREBASE_SERVICE_ACCOUNT_JSON (or a mounted service
 * account file) from env to call FCM's send API.
 *
 * The app always writes to the `notifications` table (in-app inbox) via
 * services/notifications.js regardless of provider config — this stub only
 * covers the *push* (device-level) delivery, which is best-effort.
 */
const configured = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

async function sendPush({ deviceToken, title, body, data }) {
  if (!configured) {
    // eslint-disable-next-line no-console
    console.warn('[push] FIREBASE_SERVICE_ACCOUNT_JSON not set — push not sent (in-app notification still recorded).');
    return { sent: false, provider: 'stub' };
  }

  // Real integration point (firebase-admin):
  // const admin = require('firebase-admin');
  // await admin.messaging().send({ token: deviceToken, notification: { title, body }, data });
  throw new Error('Firebase FCM integration not implemented — add the real send call here.');
}

module.exports = { sendPush, configured };
