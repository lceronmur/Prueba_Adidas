-- Network inventory schema. See README.md for the design rationale.

CREATE TABLE IF NOT EXISTS stores (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  api_key    TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  sku                 TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  category            TEXT,
  low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projection: current stock per (store, product). Derived from
-- stock_movements, never written outside the transaction that also inserts
-- the matching movement (see inventory.service.js).
CREATE TABLE IF NOT EXISTS inventory (
  store_id   TEXT NOT NULL REFERENCES stores(id),
  sku        TEXT NOT NULL REFERENCES products(sku),
  quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, sku)
);

-- Immutable ledger: the source of truth for stock. Only ever inserted into,
-- never updated or deleted.
CREATE TABLE IF NOT EXISTS stock_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL REFERENCES stores(id),
  sku             TEXT NOT NULL REFERENCES products(sku),
  type            TEXT NOT NULL CHECK (type IN ('IN', 'OUT')),
  quantity        INTEGER NOT NULL CHECK (quantity > 0), -- magnitude of the movement
  delta           INTEGER NOT NULL,                      -- signed effect on stock
  resulting_qty   INTEGER NOT NULL,                       -- post-movement snapshot, for auditing
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                 TEXT NOT NULL REFERENCES products(sku),
  quantity_at_trigger INTEGER NOT NULL,
  threshold           INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at         TEXT,
  resolved_qty        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_movements_sku_date   ON stock_movements(sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movements_store_date ON stock_movements(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_sku        ON inventory(sku);
CREATE INDEX IF NOT EXISTS idx_alerts_status         ON alerts(status, created_at DESC);

-- At most one open alert per product.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open ON alerts(sku) WHERE status = 'OPEN';
