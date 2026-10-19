'use strict';
// Starts one merchant implementation on localhost.
//   node merchant/server.js --impl reference|vulnerable [--port 3001] [--db data/reference.db]
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadConfig } = require('./config');
const { createMockGateway } = require('./gateway/mock');

const IMPLS = {
  reference: () => require('./reference/app'),
  vulnerable: () => require('./vulnerable/app'),
};

function main() {
  const { values } = parseArgs({
    options: {
      impl: { type: 'string', default: 'reference' },
      port: { type: 'string', default: '3001' },
      db: { type: 'string', default: ':memory:' },
    },
  });
  if (!IMPLS[values.impl]) throw new Error(`--impl must be one of: ${Object.keys(IMPLS).join(', ')}`);

  const config = loadConfig();
  if (values.db !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(values.db)), { recursive: true });

  const { createApp } = IMPLS[values.impl]();
  const { app } = createApp({
    dbPath: values.db,
    keySecret: config.keySecret,
    webhookSecret: config.webhookSecret,
    gateway: createMockGateway(),
  });

  // Bind to loopback only: these are test fixtures, one of them deliberately insecure.
  app.listen(Number(values.port), '127.0.0.1', () => {
    console.log(`[${values.impl}] listening on http://127.0.0.1:${values.port} (db: ${values.db})`);
    if (config.mock) console.log('mock mode: using built-in dummy secrets, no Razorpay calls are made');
  });
}

main();
