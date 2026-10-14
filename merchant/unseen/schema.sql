-- Independent merchant integration, written with different table/column names and route shapes from the
-- reference and vulnerable fixtures (D7). Used only to evaluate autonomous discovery. Carries no comments
-- describing its behaviour; any expected finding lives only in the evaluation test, never here.

CREATE TABLE IF NOT EXISTS catalog (
  sku              TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0),
  available_units  INTEGER NOT NULL CHECK (available_units >= 0)
);

CREATE TABLE IF NOT EXISTS baskets (
  ref            TEXT PRIMARY KEY,
  gw_order_ref   TEXT NOT NULL UNIQUE,
  sku            TEXT NOT NULL REFERENCES catalog(sku),
  units          INTEGER NOT NULL CHECK (units > 0),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  curr           TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('open', 'settled')),
  settled_charge TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS charges (
  ref          TEXT PRIMARY KEY,
  gw_order_ref TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  curr         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('failed', 'authorized', 'captured')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  basket_ref TEXT NOT NULL UNIQUE REFERENCES baskets(ref),
  sku        TEXT NOT NULL,
  units      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reversals (
  ref          TEXT PRIMARY KEY,
  gateway_ref  TEXT UNIQUE,
  charge_ref   TEXT NOT NULL REFERENCES charges(ref),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  state        TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seen_events (
  event_ref TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO catalog (sku, title, unit_price_minor, available_units) VALUES
  ('STICKER', 'Sticker', 100, 1000),
  ('TSHIRT',  'T-shirt', 49900, 100),
  ('HOODIE',  'Hoodie',  499900, 50);
