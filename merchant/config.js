'use strict';

// Dummy secrets used when no .env is present. They are not Razorpay credentials.
const MOCK_KEY_ID = 'rzp_test_mock';
const MOCK_KEY_SECRET = 'mock_key_secret_not_real';
const MOCK_WEBHOOK_SECRET = 'mock_webhook_secret_not_real';

function loadConfig(env = process.env) {
  const keyId = env.RZP_KEY_ID || MOCK_KEY_ID;
  if (/^rzp_live_/.test(keyId)) {
    throw new Error('Refusing to run with a live Razorpay key (rzp_live_*). Use a test key or mock mode.');
  }
  const mock = !env.RZP_KEY_SECRET && !env.RZP_WEBHOOK_SECRET;
  return {
    keyId,
    keySecret: env.RZP_KEY_SECRET || MOCK_KEY_SECRET,
    webhookSecret: env.RZP_WEBHOOK_SECRET || MOCK_WEBHOOK_SECRET,
    mock,
  };
}

module.exports = { loadConfig, MOCK_KEY_ID, MOCK_KEY_SECRET, MOCK_WEBHOOK_SECRET };
