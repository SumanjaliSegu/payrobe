CREATE TABLE IF NOT EXISTS products (
  sku   TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  razorpay_order_id TEXT NOT NULL,
  sku               TEXT NOT NULL,
  quantity          INTEGER NOT NULL,
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL,
  paid_payment_id   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  razorpay_order_id TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fulfillments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL,
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id                 TEXT PRIMARY KEY,
  razorpay_refund_id TEXT,
  order_id           TEXT NOT NULL,
  payment_id         TEXT NOT NULL,
  amount             INTEGER NOT NULL,
  status             TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO products (sku, name, price, stock) VALUES
  ('STICKER', 'Sticker', 100, 1000),
  ('TSHIRT',  'T-shirt', 49900, 100),
  ('HOODIE',  'Hoodie',  499900, 50);
