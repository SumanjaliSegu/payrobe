'use strict';
const { createMockGateway } = require('../merchant/gateway/mock');
const { MOCK_KEY_SECRET, MOCK_WEBHOOK_SECRET } = require('../merchant/config');

const IMPLS = {
  reference: require('../merchant/reference/app'),
  vulnerable: require('../merchant/vulnerable/app'),
};

// Starts an implementation on an ephemeral loopback port with a fresh in-memory DB.
// Returns the DB handle so tests can assert on stored state, not HTTP responses.
// Pass a harness ledger to have the mock gateway record its actions independently.
async function startMerchant(impl, { ledger } = {}) {
  const gateway = createMockGateway({ ledger });
  const { app, db } = IMPLS[impl].createApp({
    dbPath: ':memory:',
    keySecret: MOCK_KEY_SECRET,
    webhookSecret: MOCK_WEBHOOK_SECRET,
    gateway,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    impl,
    baseUrl,
    db,
    gateway,
    keySecret: MOCK_KEY_SECRET,
    webhookSecret: MOCK_WEBHOOK_SECRET,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

module.exports = { IMPLS, startMerchant, postJson };
