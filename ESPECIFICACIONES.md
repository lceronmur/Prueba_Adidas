# Technical Specification — Network Inventory Sync

Scope: functional demo, not a production system.

---

## 1. Summary

A backend service acting as the **single source of truth for inventory**
across a network of stores. Each store reports stock movements (stock
in/out) independently and concurrently; the service consolidates them,
keeps per-store and network-wide totals, and raises an alert when a
product's network stock falls under a configurable threshold.

The design emphasis is not the number of endpoints, but **how stock stays
consistent when several stores report at the same time**.

### Central design decision

> Inventory is **never written, it is derived**. Stores report *movements*
> (deltas), never absolute quantities. `stock_movements` is an append-only
> ledger, and stock is a projection updated in the **same atomic
> transaction** that inserts the movement.

This removes the most common bug class in inventory sync at the root: the
*lost update* (two stores read 100, one writes 90, the other writes 110, and
a movement disappears without anyone noticing).

---

## 2. Requirements

| # | Requirement |
|---|---|
| RF-01 | Endpoint to report stock movements per store (IN / OUT) |
| RF-02 | Consolidation: total stock per product across the network |
| RF-03 | Inventory query with filters (store, product, low-stock range) |
| RF-04 | Alerts based on a configurable threshold |
| RF-05 | API key authentication for reporting stores |
| RF-06 | Movement history per product/store |
| RF-07 | Minimal read-only UI to demonstrate the API |
| RNF-01 | Consistency under concurrent writes (no negative stock, no lost updates) |
| RNF-02 | Input validation and a uniform error format |

### Explicitly out of scope

- Multi-tenancy or user/role management beyond a store's API key.
- Idempotency (de-duplicating retried requests via a client-supplied key).
  A retry after a network timeout can currently double the stock effect;
  the concurrency guarantee itself (two simultaneous reports never step on
  each other) does not depend on it. See README.md, "Known limitations",
  for the additive change needed to bring it back.
- Real external notifications (email/Slack) for alerts — alerts are
  **persisted and exposed through the API**; sending them anywhere is a
  documented extension point.
- High availability, replicas, sharding. A single-process SQLite database is
  enough for this demo.
- Batch/bulk ingestion, per-store thresholds, and alert hysteresis. They are
  natural extensions of the same transactional core but were cut to keep the
  write path small (see README.md, "Known limitations").

---

## 3. Architecture

```
+----------------+  POST /api/v1/movements        +------------------------------+
| Store A (sim)  | -------- X-API-Key -----------> |                              |
+----------------+                                 |      REST API (Express)      |
| Store B (sim)  | -------------------------------> |                              |
+----------------+                                 |  +------------------------+  |
| Store C (sim)  | -------------------------------> |  | Middleware             |  |
+----------------+                                 |  |  auth . validate .     |  |
                                                    |  |  errorHandler          |  |
+----------------+  GET /api/v1/inventory          |  +-----------+------------+  |
|  UI (static)   | <------------------------------> |              v               |
|  demo panel    |  GET /api/v1/alerts             |  +------------------------+  |
+----------------+                                 |  | Service layer          |  |
                                                    |  |  inventoryService      |  |
                                                    |  |  alertService          |  |
                                                    |  +-----------+------------+  |
                                                    |              v               |
                                                    |  +------------------------+  |
                                                    |  | Repositories (SQL)     |  |
                                                    |  +-----------+------------+  |
                                                    +--------------|---------------+
                                                                   v
                                                      +------------------------+
                                                      | SQLite (WAL)           |
                                                      |  stock_movements (log) |
                                                      |  inventory (projection)|
                                                      |  alerts                |
                                                      +------------------------+
```

### Layers

| Layer | Responsibility | Rule |
|---|---|---|
| **Routes** | Map HTTP to a use case. No business logic. | Never touches SQL |
| **Middleware** | Authentication, schema validation (Zod), centralized error handling | Fails fast |
| **Services** | Business rules, transactional orchestration, alert evaluation | Doesn't know `req`/`res` |
| **Repositories** | Prepared SQL statements | Doesn't decide rules |
| **DB** | Persistence and atomicity guarantees | Source of truth |

This separation is what lets the concurrency tests exercise the write path
against an in-memory database, with no HTTP server involved.

### Stack

| Component | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ (ESM) | Required by the brief |
| Framework | Express 4 | Required by the brief |
| DB | SQLite via `better-sqlite3` | **Synchronous and transactional**: `db.transaction()` gives real atomicity without managing pools or nested promises |
| Validation | `zod` | Declarative schemas reused across layers |
| Tests | `node:test` + `supertest` | No heavy dependencies |
| UI | Plain HTML + JS served by Express | The brief asks for "minimal"; a frontend build step would be noise |

---

## 4. Data model

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE stores (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  api_key    TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE products (
  sku                 TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  category            TEXT,
  low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projection: current stock per (store, product).
CREATE TABLE inventory (
  store_id   TEXT NOT NULL REFERENCES stores(id),
  sku        TEXT NOT NULL REFERENCES products(sku),
  quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, sku)
);

-- Append-only ledger: the source of truth.
CREATE TABLE stock_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL REFERENCES stores(id),
  sku             TEXT NOT NULL REFERENCES products(sku),
  type            TEXT NOT NULL CHECK (type IN ('IN','OUT')),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  delta           INTEGER NOT NULL,
  resulting_qty   INTEGER NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE alerts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                 TEXT NOT NULL REFERENCES products(sku),
  quantity_at_trigger INTEGER NOT NULL,
  threshold           INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at         TEXT,
  resolved_qty        INTEGER
);

CREATE UNIQUE INDEX idx_alerts_open ON alerts(sku) WHERE status = 'OPEN';
```

### Invariants

| ID | Invariant | Guaranteed by |
|---|---|---|
| INV-1 | `quantity >= 0` always | `CHECK` constraint + the update's guard clause |
| INV-2 | `inventory.quantity == SUM(stock_movements.delta)` for every (store, sku) | Both written in the same transaction; verified live by `/reconcile` |
| INV-3 | At most one `OPEN` alert per product | Partial unique index |

---

## 5. Concurrency and consistency strategy

### Level 1 — Deltas, not absolute values

The API contract **forbids** `{"quantity": 42}` as a target state. It only
accepts `{"type":"OUT","quantity":3}`. Summing deltas is commutative: the
arrival order of two concurrent movements never changes the final result.

### Level 2 — Atomic update in SQL

There is never a read-modify-write in JavaScript. The check happens inside
the engine:

```sql
UPDATE inventory
   SET quantity   = quantity + @delta,
       updated_at = datetime('now')
 WHERE store_id = @store_id AND sku = @sku
   AND quantity + @delta >= 0        -- rejects overselling with no prior read
RETURNING quantity;
```

If `changes === 0`, the movement is rejected with `409 INSUFFICIENT_STOCK`.
There is no window between reading and writing.

### Level 3 — One transaction for movement + projection + alert

```js
const applyOne = db.transaction((cmd) => {
  inventoryRepo.ensureRow(cmd.storeId, cmd.sku);
  const resultingQty = inventoryRepo.applyDelta({ ...cmd, delta });
  if (resultingQty === undefined) throw new InsufficientStockError(cmd);

  const movement = movementRepo.insert({ ...cmd, delta, resultingQty });
  const alert = alertService.evaluate(cmd.sku);

  return { movement, alert };
});
```

`better-sqlite3` runs this as `BEGIN IMMEDIATE ... COMMIT`. Either
everything applies, or nothing does: a movement can never end up recorded
without being reflected in stock, or vice versa (INV-2).

### Verification

`tests/concurrency.test.js`:

> 30 concurrent requests on the same SKU (18 × `IN 1`, 12 × `OUT 1`,
> starting from a known stock). **Assertions:** final stock is exact;
> movement count matches; `SUM(delta) == inventory.quantity`.

Plus an overselling test: stock at 3, 6 concurrent `OUT 1` requests -> 3
`201`s, 3 `409`s, final stock 0, and `/reconcile` still reports zero
discrepancies afterwards.

---

## 6. API summary

Base: `/api/v1` · Format: JSON · Timestamps: UTC

### Authentication

| Endpoint type | Credential | Header |
|---|---|---|
| Write (stores) | Store API key | `X-API-Key: sk_store_a_demo` |
| Read / admin | Admin API key | `X-API-Key: sk_admin_demo` |

A store can only report on itself: `store_id` is derived from the API key;
if the body contradicts it, the request is rejected with `403
STORE_MISMATCH`. Missing or unknown key -> `401 UNAUTHORIZED`.

See [README.md](README.md) for the full endpoint list, an example request,
and the error code table. A ready-to-run request collection is in
[docs/api.http](docs/api.http).

### Alert rule (RF-04)

On every movement, inside the same transaction:

```
network_qty = SUM(inventory.quantity) WHERE sku = ?

if network_qty <= threshold and no OPEN alert exists -> open one
if network_qty >  threshold and an OPEN alert exists -> resolve it
```

Changing a product's threshold (`PATCH /products/:sku/threshold`)
re-evaluates its alert immediately, without waiting for the next movement.

---

## 7. Implementation status

Implemented and verified. 35 tests passing (`npm test`).

| Requirement | Status | Where |
|---|---|---|
| RF-01 Report movements | Done | `services/inventory.service.js` · `routes/movements.routes.js` |
| RF-02 Network consolidation | Done | `repositories/inventory.repo.js` |
| RF-03 Filtered queries | Done | `routes/inventory.routes.js` |
| RF-04 Configurable threshold alerts | Done | `services/alert.service.js` · `routes/admin.routes.js` |
| RF-05 API key authentication | Done | `middleware/auth.js` |
| RF-06 Movement history | Done | `repositories/movement.repo.js` |
| RF-07 Minimal read-only UI | Done | `src/frontend/` |
| RNF-01 Concurrent consistency | Done | `tests/concurrency.test.js` |
| RNF-02 Validation and errors | Done | `middleware/validate.js` · `errorHandler.js` |
