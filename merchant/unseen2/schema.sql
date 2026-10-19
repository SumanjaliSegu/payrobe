-- A second, independently-written merchant integration with its own domain vocabulary (event-ticketing
-- style), distinct from every other fixture. Used only to evaluate discovery and false-positive rate on
-- unfamiliar names. No comments describe its behaviour; the evaluation test holds any expected result.

CREATE TABLE IF NOT EXISTS inventory (
  sku        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  unit_paise INTEGER NOT NULL CHECK (unit_paise > 0),
  in_stock   INTEGER NOT NULL CHECK (in_stock >= 0)
);

CREATE TABLE IF NOT EXISTS tickets (
  token             TEXT PRIMARY KEY,
  pg_order_handle   TEXT NOT NULL UNIQUE,
  sku               TEXT NOT NULL REFERENCES inventory(sku),
  qty               INTEGER NOT NULL CHECK (qty > 0),
  price_paise       INTEGER NOT NULL CHECK (price_paise > 0),
  iso_curr          TEXT NOT NULL,
  phase             TEXT NOT NULL CHECK (phase IN ('pending', 'fulfilled')),
  winning_settlement TEXT,
  opened_at         TEXT NOT NULL DEFAULT (datetime('now')),
  touched_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settlements (
  handle          TEXT PRIMARY KEY,
  pg_order_handle TEXT NOT NULL,
  price_paise     INTEGER NOT NULL,
  iso_curr        TEXT NOT NULL,
  phase           TEXT NOT NULL CHECK (phase IN ('failed', 'authorized', 'captured')),
  touched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_token TEXT NOT NULL UNIQUE REFERENCES tickets(token),
  sku          TEXT NOT NULL,
  qty          INTEGER NOT NULL,
  granted_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credits (
  ref               TEXT PRIMARY KEY,
  pg_credit_handle  TEXT UNIQUE,
  settlement_handle TEXT NOT NULL REFERENCES settlements(handle),
  price_paise       INTEGER NOT NULL CHECK (price_paise > 0),
  phase             TEXT NOT NULL CHECK (phase IN ('pending', 'done', 'failed')),
  made_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS processed_hooks (
  hook_ref TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO inventory (sku, label, unit_paise, in_stock) VALUES
  ('STICKER', 'Sticker', 100, 1000),
  ('TSHIRT',  'T-shirt', 49900, 100),
  ('HOODIE',  'Hoodie',  499900, 50);
