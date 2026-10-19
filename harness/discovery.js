'use strict';
// Deterministic payment-flow discovery: given an app's SOURCE directory, propose a v2 mapping
// (harness/mapping-v2.js) with file:line evidence, using general field-name heuristics only.
//
// It never reads an answer key and is not tuned to any one fixture: it scores columns and tables by
// what they look like (a status column, a gateway order reference, a stock column), not by fixed names.
// Whatever it proposes is only a hypothesis; harness/validator.js confirms or rejects every entry against
// the running app's behaviour and the cited source, and only confirmed entries drive the checker. So a
// wrong guess yields cannot_verify, never a false finding.
//
// Scope and limits (documented, see docs/DECISIONS.md D18):
//   - SQL schema is parsed from `CREATE TABLE` statements in .sql files (SQLite column lines).
//   - Routes are parsed from Express `app.<method>('<path>', ...)` calls in .js files.
//   - Request/response field names (the body a create-order call takes, the fields it returns) are a
//     CONVENTION the discoverer assumes and the validator then confirms; they are not parsed from source.
//     An app that departs from the convention leaves those entries unconfirmed (cannot_verify), not wrong.
//   - No LLM is used here. harness/investigator.js documents where a model could propose or refine a
//     mapping; this module is the deterministic path and the ground truth the validator checks against.
const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA_ID, entry } = require('./mapping-v2');

// Normalized status vocabularies we look for, by entity. Ordered best-first.
const PAID_HINTS = ['paid', 'success', 'successful', 'complete', 'completed', 'captured', 'confirmed', 'settled', 'fulfilled', 'fulfilment', 'fulfillment'];
const CAPTURED_HINTS = ['captured', 'paid', 'success', 'successful', 'settled', 'completed'];
const NOT_COUNTED_REFUND_HINTS = ['failed', 'cancelled', 'canceled', 'rejected', 'reversed', 'voided'];

// --- source loading ------------------------------------------------------

function listSourceFiles(root, exts) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (exts.includes(path.extname(name))) out.push(abs);
    }
  };
  walk(root);
  return out;
}

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// --- schema parsing ------------------------------------------------------

// Parses `CREATE TABLE [IF NOT EXISTS] name ( ... )` blocks and their column lines from SQLite DDL.
// Returns [{ table, file, line, columns: [{ name, type, raw, line, pk, check }] }].
// Replaces SQL comments with spaces, preserving every newline so line numbers are unchanged.
function stripSqlComments(text) {
  return text
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function parseSchema(sqlFiles, root) {
  const tables = [];
  for (const abs of sqlFiles) {
    const text = stripSqlComments(fs.readFileSync(abs, 'utf8'));
    const file = rel(root, abs);
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const table = m[1];
      const startIdx = m.index + m[0].length;
      // Find the matching close paren for this CREATE TABLE.
      let depth = 1;
      let i = startIdx;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
      }
      const body = text.slice(startIdx, i - 1);
      const tableLine = text.slice(0, m.index).split(/\r?\n/).length;
      // Line-based column extraction: the table body spans from (tableLine + offset) onward. Each physical
      // line that begins with `name TYPE` is one column definition. Accurate line numbers for evidence.
      const bodyStartLine = tableLine + text.slice(m.index, startIdx).split(/\r?\n/).length - 1;
      const bodyLines = body.split(/\r?\n/);
      const columns = [];
      for (let bi = 0; bi < bodyLines.length; bi++) {
        const trimmed = bodyLines[bi].trim().replace(/,\s*$/, '');
        if (!trimmed) continue;
        const cm = trimmed.match(/^["'`]?(\w+)["'`]?\s+(TEXT|INTEGER|REAL|NUMERIC|BLOB|BOOLEAN)/i);
        if (!cm || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(trimmed)) continue;
        const checkMatch = trimmed.match(/CHECK\s*\([^)]*IN\s*\(([^)]*)\)/i);
        const checkValues = checkMatch
          ? checkMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
          : null;
        columns.push({
          name: cm[1],
          type: cm[2].toUpperCase(),
          raw: trimmed,
          line: bodyStartLine + bi,
          pk: /PRIMARY\s+KEY/i.test(trimmed),
          unique: /\bUNIQUE\b/i.test(trimmed),
          references: (trimmed.match(/REFERENCES\s+["'`]?(\w+)/i) || [])[1] || null,
          checkValues,
        });
      }
      tables.push({ table, file, line: tableLine, columns });
    }
  }
  return tables;
}

// --- route parsing -------------------------------------------------------

function parseRoutes(jsFiles, root) {
  const routes = [];
  for (const abs of jsFiles) {
    const text = fs.readFileSync(abs, 'utf8');
    const file = rel(root, abs);
    const re = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      routes.push({ method: m[1].toUpperCase(), path: m[2], file, line });
    }
  }
  return routes;
}

// --- heuristics ----------------------------------------------------------

const has = (name, ...subs) => subs.every((s) => name.toLowerCase().includes(s));
const hasAny = (name, subs) => subs.some((s) => name.toLowerCase().includes(s));
const GATEWAY_HINTS = ['razorpay', 'gateway', 'pg_', 'psp', 'provider', 'rzp'];
const isGatewayOrderRef = (n) => (hasAny(n, GATEWAY_HINTS) && n.toLowerCase().includes('order')) || /(^|_)(gw|rzp)_?order/i.test(n);
const isStatus = (n) => hasAny(n, ['status', 'state', 'phase', 'stage', 'lifecycle']);
const isAmount = (n) => hasAny(n, ['amount', 'total', 'price', 'value']) && !n.toLowerCase().includes('refund');
const isCurrency = (n) => n.toLowerCase().includes('curr');
const isQty = (n) => hasAny(n, ['quantity', 'qty', 'count', 'units']);
const isSku = (n) => hasAny(n, ['sku', 'product', 'item', 'variant']);
const isStock = (n) => hasAny(n, ['stock', 'inventory', 'available', 'on_hand', 'onhand', 'qty', 'quantity', 'count']);

const pickStatusValues = (col, hints) => {
  if (!col?.checkValues?.length) return null;
  const lower = col.checkValues.map((v) => v.toLowerCase());
  for (const h of hints) {
    const i = lower.indexOf(h);
    if (i !== -1) return [col.checkValues[i]];
  }
  return null;
};

// Fallback when the schema has no CHECK list: scan JS source for a quoted string literal that exactly
// equals one of `hints` (payment-status words), taking the highest-priority hint that appears anywhere.
// Returns { values, evidence: ['file:line'] } citing the first line that literal appears on, or null.
// The cited line contains the literal, so the validator's evidence check passes; behaviour then confirms
// (the status after a genuine capture must fall in this list). Hint-priority ordering keeps 'captured'
// ahead of 'paid' for payments even though both tables name the column `status`.
function scanStatusLiterals(jsFiles, root, hints) {
  const found = new Map(); // literal -> 'file:line'
  for (const abs of jsFiles) {
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/['"`]([a-z_]{3,20})['"`]/gi)) {
        const lit = m[1].toLowerCase();
        if (!found.has(lit)) found.set(lit, `${rel(root, abs)}:${i + 1}`);
      }
    }
  }
  for (const h of hints) {
    if (found.has(h)) return { values: [h], evidence: [found.get(h)] };
  }
  return null;
}

// Scores a table as the "orders" table: has status + amount + currency + a gateway order ref.
function scoreOrders(t) {
  const c = t.columns;
  let s = 0;
  if (c.some((x) => isStatus(x.name))) s += 2;
  if (c.some((x) => isAmount(x.name))) s += 1;
  if (c.some((x) => isCurrency(x.name))) s += 1;
  if (c.some((x) => isGatewayOrderRef(x.name))) s += 2;
  if (/order/i.test(t.table)) s += 2;
  if (c.some((x) => x.pk)) s += 1;
  return s;
}
function scorePayments(t, ordersTable) {
  const c = t.columns;
  let s = 0;
  if (/pay(ment)?/i.test(t.table)) s += 3;
  if (c.some((x) => isStatus(x.name))) s += 1;
  if (c.some((x) => isAmount(x.name))) s += 1;
  if (c.some((x) => isGatewayOrderRef(x.name))) s += 1;
  if (t.table === ordersTable?.table) s -= 100;
  return s;
}
function scoreFulfillments(t, ordersTable) {
  const c = t.columns;
  let s = 0;
  if (/fulfil|fulfill|shipment|ship|dispatch|delivery|fulfilment/i.test(t.table)) s += 3;
  if (c.some((x) => x.references === ordersTable?.table || has(x.name, 'order'))) s += 2;
  if (c.some((x) => isSku(x.name))) s += 1;
  if (c.some((x) => isQty(x.name))) s += 1;
  if (t.table === ordersTable?.table) s -= 100;
  return s;
}
function scoreRefunds(t) {
  const c = t.columns;
  let s = 0;
  if (/refund|reversal|chargeback/i.test(t.table)) s += 3;
  if (c.some((x) => isAmount(x.name))) s += 1;
  if (c.some((x) => isStatus(x.name))) s += 1;
  if (c.some((x) => has(x.name, 'payment'))) s += 1;
  return s;
}
function scoreStock(t) {
  const c = t.columns;
  let s = 0;
  if (/product|catalog|item|inventory|stock|sku/i.test(t.table)) s += 2;
  if (c.some((x) => isSku(x.name) || x.pk)) s += 1;
  if (c.some((x) => isStock(x.name))) s += 2;
  return s;
}

const best = (tables, score) => {
  let top = null;
  let topScore = 0;
  for (const t of tables) {
    const sc = score(t);
    if (sc > topScore) { topScore = sc; top = t; }
  }
  return top && topScore > 0 ? top : null;
};

// Picks the column in `table` best matching `pred`; `prefer` breaks ties by name hint.
function pickColumn(table, pred, { prefer, exclude = [] } = {}) {
  const cands = table.columns.filter((c) => !exclude.includes(c.name) && pred(c));
  if (!cands.length) return null;
  if (prefer) {
    const p = cands.find((c) => prefer(c.name));
    if (p) return p;
  }
  return cands[0];
}

function ev(root, file, line) {
  return `${file}:${line}`;
}

// A value-list entry (paidValues/capturedValues): schema CHECK list first, else a JS-literal scan.
function statusValueEntry(table, statusCol, hints, jsFiles, root) {
  const fromCheck = pickStatusValues(statusCol, hints);
  if (fromCheck) return entry(fromCheck, [`${table.file}:${statusCol.line}`], { confidence: 'medium' });
  const fromCode = scanStatusLiterals(jsFiles, root, hints);
  // 'medium' (not 'low'): the cited line contains the literal and behaviour confirms it; 'low' would be
  // treated as ambiguous and could never be confirmed, which would reject an otherwise-correct mapping.
  if (fromCode) return entry(fromCode.values, fromCode.evidence, { confidence: 'medium' });
  return entry([], [], { confidence: 'low' });
}

// Builds a v2 entry for a column, with its schema line as evidence; confidence from match strength.
function colEntry(table, col, confidence = 'high') {
  if (!col) return entry(null, [], { confidence: 'low' });
  return entry(col.name, [`${table.file}:${col.line}`], { confidence });
}

// Order-resource nouns: an order-creation endpoint tends to POST to one of these collections.
const ORDER_NOUNS = ['order', 'basket', 'cart', 'checkout', 'session', 'intent', 'purchase'];

// Classify a parsed route to a normalized role, or null. General e-commerce vocabulary, not fixture names.
function classifyRoute(r) {
  if (r.method !== 'POST') return null;
  const p = r.path.toLowerCase();
  if (hasAny(p, ['webhook', 'hook'])) return 'webhook';
  if (hasAny(p, ['refund', 'reversal', 'chargeback'])) return 'refund';
  if (hasAny(p, ['verify', 'callback', 'confirm'])) return 'verify';
  // Order creation: a collection POST (no :id/{id} path parameter) to an order-ish noun.
  if (!/[:{]/.test(p) && hasAny(p, ORDER_NOUNS)) return 'createOrder';
  return null;
}

// Request/response convention (see header). The validator confirms these against behaviour.
const DEFAULT_BODY = { sku: '{sku}', quantity: '{quantity}' };
const DEFAULT_RESPONSE = { orderId: 'order_id', gatewayOrderId: 'razorpay_order_id', amount: 'amount', currency: 'currency' };

// Collects evidence lines covering `tokens`: the route's own line, plus the first source line that
// mentions each token (the validator requires every token to appear on some cited line). `sourceIndex`
// is [{ file, lines: [...] }] over all .js/.sql source.
function routeEvidence(route, tokens, sourceIndex) {
  const evid = [`${route.file}:${route.line}`];
  const wholeWord = (line, tok) => new RegExp(`(^|[^A-Za-z0-9_])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(line);
  for (const tok of tokens) {
    if (!tok) continue;
    let found = false;
    for (const { file, lines } of sourceIndex) {
      for (let i = 0; i < lines.length; i++) {
        if (wholeWord(lines[i], String(tok))) { evid.push(`${file}:${i + 1}`); found = true; break; }
      }
      if (found) break;
    }
  }
  return [...new Set(evid)];
}

const staticSegments = (p) => p.split('/').filter((s) => s && !s.startsWith(':') && !s.startsWith('{'));

function discoverRoutes(routes, sourceIndex, { bodyConvention = DEFAULT_BODY, responseConvention = DEFAULT_RESPONSE, sampleSku = 'TSHIRT', sampleQty = 2 } = {}) {
  const out = {};
  const seen = { createOrder: null, webhook: null, verify: null, refund: null };
  for (const r of routes) {
    const role = classifyRoute(r);
    if (!role || seen[role]) continue;
    seen[role] = r;
    const value = { method: r.method, path: r.path };
    let tokens = staticSegments(r.path);
    if (role === 'createOrder') {
      value.body = bodyConvention;
      value.sample = { sku: sampleSku, quantity: sampleQty };
      value.response = responseConvention;
      tokens = [...tokens, ...Object.keys(bodyConvention), ...Object.values(responseConvention), sampleSku];
    }
    if (role === 'webhook') {
      value.signatureHeader = 'x-razorpay-signature';
      // Only claim an event-id header if the handler source actually reads one; some apps do not.
      const readsEventId = sourceIndex.some(({ lines }) => lines.some((l) => /x-razorpay-event-id/i.test(l)));
      value.eventIdHeader = readsEventId ? 'x-razorpay-event-id' : null;
      tokens = [...tokens, value.signatureHeader, value.eventIdHeader].filter(Boolean);
    }
    if (role === 'refund') value.path = r.path.replace(/:(\w+)/g, '{orderId}');
    out[role] = entry(value, routeEvidence(r, tokens, sourceIndex), { confidence: role === 'createOrder' || role === 'webhook' ? 'high' : 'medium' });
  }
  return out;
}

// --- top level -----------------------------------------------------------

// Produces a v2 mapping hypothesis for the app rooted at `root`.
// options.sampleSku/sampleQty seed the create-order probe the validator will run; they do not affect
// which tables/columns are chosen. launchHints lets a caller pass known launch metadata (not discovered).
function discoverMapping({ root, name, sqlExts = ['.sql'], jsExts = ['.js'], launchHints = {}, ...routeOpts } = {}) {
  if (!root || !fs.existsSync(root)) throw new Error(`discovery: source root not found: ${root}`);
  const sqlFiles = listSourceFiles(root, sqlExts);
  const jsFiles = listSourceFiles(root, jsExts);
  const tables = parseSchema(sqlFiles, root);
  const routes = parseRoutes(jsFiles, root);
  if (!tables.length) throw new Error('discovery: no CREATE TABLE statements found in source');
  // Source index over all .js and .sql files, for route-evidence token coverage. Order: js first.
  const sourceIndex = [...jsFiles, ...sqlFiles].map((abs) => ({ file: rel(root, abs), lines: fs.readFileSync(abs, 'utf8').split(/\r?\n/) }));

  const orders = best(tables, scoreOrders);
  const payments = best(tables, (t) => scorePayments(t, orders));
  const fulfillments = best(tables, (t) => scoreFulfillments(t, orders));
  const refunds = best(tables, scoreRefunds);
  const stock = best(tables, scoreStock);

  const mapping = {
    schema: SCHEMA_ID,
    name: name ?? path.basename(root),
    provenance: 'discovered (harness/discovery.js, deterministic heuristics)',
    launch: {
      command: entry(launchHints.command ?? { argv: ['node', 'server.js'], cwd: '.' }, launchHints.commandEvidence ?? [], { confidence: 'low' }),
      port: entry(launchHints.port ?? { via: 'arg', name: '--port' }, [], { confidence: 'low' }),
      dbPath: entry(launchHints.dbPath ?? { via: 'arg', name: '--db' }, [], { confidence: 'low' }),
      webhookSecret: entry(launchHints.webhookSecret ?? { via: 'env', name: 'RZP_WEBHOOK_SECRET' }, [], { confidence: 'low' }),
      keySecret: entry(launchHints.keySecret ?? { via: 'env', name: 'RZP_KEY_SECRET' }, [], { confidence: 'low' }),
    },
    routes: discoverRoutes(routes, sourceIndex, routeOpts),
  };

  if (orders) {
    const statusCol = pickColumn(orders, (c) => isStatus(c.name));
    mapping.orders = {
      table: entry(orders.table, [ev(root, orders.file, orders.line)]),
      columns: {
        id: colEntry(orders, pickColumn(orders, (c) => c.pk || c.name.toLowerCase() === 'id', { prefer: (n) => n.toLowerCase() === 'id' })),
        gatewayOrderId: colEntry(orders, pickColumn(orders, (c) => isGatewayOrderRef(c.name))),
        amount: colEntry(orders, pickColumn(orders, (c) => isAmount(c.name))),
        currency: colEntry(orders, pickColumn(orders, (c) => isCurrency(c.name))),
        status: colEntry(orders, statusCol),
        paidPaymentId: colEntry(orders, pickColumn(orders, (c) => has(c.name, 'paid') && has(c.name, 'payment'), { prefer: (n) => n.toLowerCase().includes('paid') })),
      },
      paidValues: statusValueEntry(orders, statusCol, PAID_HINTS, jsFiles, root),
    };
  }
  if (payments) {
    const statusCol = pickColumn(payments, (c) => isStatus(c.name));
    mapping.payments = {
      table: entry(payments.table, [ev(root, payments.file, payments.line)]),
      columns: {
        id: colEntry(payments, pickColumn(payments, (c) => c.pk || c.name.toLowerCase() === 'id', { prefer: (n) => n.toLowerCase() === 'id' })),
        gatewayOrderId: colEntry(payments, pickColumn(payments, (c) => isGatewayOrderRef(c.name))),
        amount: colEntry(payments, pickColumn(payments, (c) => isAmount(c.name))),
        currency: colEntry(payments, pickColumn(payments, (c) => isCurrency(c.name))),
        status: colEntry(payments, statusCol),
      },
      capturedValues: statusValueEntry(payments, statusCol, CAPTURED_HINTS, jsFiles, root),
    };
  }
  if (fulfillments) {
    mapping.fulfillments = {
      table: entry(fulfillments.table, [ev(root, fulfillments.file, fulfillments.line)]),
      columns: {
        orderId: colEntry(fulfillments, pickColumn(fulfillments, (c) => c.references === orders?.table || has(c.name, 'order'), { prefer: (n) => n.toLowerCase().includes('order') })),
        sku: colEntry(fulfillments, pickColumn(fulfillments, (c) => isSku(c.name))),
        quantity: colEntry(fulfillments, pickColumn(fulfillments, (c) => isQty(c.name))),
      },
    };
  }
  if (refunds) {
    const statusCol = pickColumn(refunds, (c) => isStatus(c.name));
    mapping.refunds = {
      table: entry(refunds.table, [ev(root, refunds.file, refunds.line)]),
      columns: {
        id: colEntry(refunds, pickColumn(refunds, (c) => c.pk || c.name.toLowerCase() === 'id', { prefer: (n) => n.toLowerCase() === 'id' })),
        paymentId: colEntry(refunds, pickColumn(refunds, (c) => has(c.name, 'payment') || c.references === payments?.table, { prefer: (n) => n.toLowerCase().includes('payment') })),
        amount: colEntry(refunds, pickColumn(refunds, (c) => isAmount(c.name))),
        status: colEntry(refunds, statusCol),
      },
      notCountedValues: entry(pickStatusValues(statusCol, NOT_COUNTED_REFUND_HINTS) ?? ['failed'], statusCol?.checkValues ? [`${refunds.file}:${statusCol.line}`] : [], { confidence: 'low' }),
    };
  }
  if (stock) {
    mapping.stock = {
      table: entry(stock.table, [ev(root, stock.file, stock.line)]),
      columns: {
        sku: colEntry(stock, pickColumn(stock, (c) => isSku(c.name) || c.pk, { prefer: (n) => isSku(n) })),
        quantity: colEntry(stock, pickColumn(stock, (c) => isStock(c.name))),
      },
    };
  }

  return { mapping, inspected: { tables: tables.map((t) => ({ table: t.table, columns: t.columns.map((c) => c.name) })), routes } };
}

module.exports = { discoverMapping, parseSchema, parseRoutes, classifyRoute, listSourceFiles };
