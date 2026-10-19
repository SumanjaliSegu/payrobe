CREATE TABLE IF NOT EXISTS products (
  sku   TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),   -- paise
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  sku               TEXT NOT NULL REFERENCES products(sku),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  amount            INTEGER NOT NULL CHECK (amount > 0),  -- paise, computed server-side
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('created', 'paid')),
  paid_payment_id   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,                -- Razorpay payment id
  razorpay_order_id TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('failed', 'authorized', 'captured')),
  flag              TEXT,                            -- amount_mismatch | unknown_order | extra_payment
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkout_verifications (
  order_id    TEXT NOT NULL REFERENCES orders(id),
  payment_id  TEXT NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (order_id, payment_id)
);

CREATE TABLE IF NOT EXISTS fulfillments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL UNIQUE REFERENCES orders(id),
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id                 TEXT PRIMARY KEY,
  razorpay_refund_id TEXT UNIQUE,
  order_id           TEXT NOT NULL REFERENCES orders(id),
  payment_id         TEXT NOT NULL,
  amount             INTEGER NOT NULL CHECK (amount > 0),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO products (sku, name, price, stock) VALUES
  ('STICKER', 'Sticker', 100, 1000),
  ('TSHIRT',  'T-shirt', 49900, 100),
  ('HOODIE',  'Hoodie',  499900, 50);
