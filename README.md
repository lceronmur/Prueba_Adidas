# Network Inventory Sync

A backend service that receives stock movements from multiple (simulated)
stores and consolidates them into a single, consistent network inventory,
exposed through a REST API.

---

## Project overview and goals

Picture a small retail chain: 3 stores, one shared catalog of products.
Every time a store sells something or receives a shipment, it needs to tell
the "home office" system so that everyone — every other store, and whoever
is watching the dashboard — sees an up-to-date, correct total.

The hard part isn't the CRUD. It's that **multiple stores report changes at
the same time**, and the system still has to end up with the right numbers,
never a negative stock, and never a change that silently gets lost. That is
the actual goal of this project: not "how many endpoints can I build," but
**how do you keep stock correct when it's being updated concurrently, from
several places at once.**

To demonstrate that, the project includes:

- An endpoint for a store to report a stock movement (an item came in, or
  went out).
- A consolidated view of inventory across the whole network, filterable by
  store, product, or low-stock range.
- An alerting system that opens when a product's total stock drops under a
  configurable threshold, and closes automatically when it recovers.
- Basic API key authentication so only a store can report its own stock.
- A movement history per product (an audit trail of everything that
  happened).
- A minimal read-only web panel to see all of this without needing Postman.
- A test suite that proves the concurrency behavior works, by literally
  firing many requests at once and checking the result is exact.

---

## Technologies used

| Piece | Choice | Why |
|---|---|---|
| Runtime | [Node.js](https://nodejs.org) (20+, ES modules) | JavaScript on the server |
| Web framework | [Express](https://expressjs.com) | Routes, middleware, request/response handling |
| Database | [SQLite](https://sqlite.org) via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | A single-file database that runs in-process — no separate database server to install. Its driver is *synchronous*, which is what makes the concurrency guarantees in this project possible (see below) |
| Input validation | [Zod](https://zod.dev) | Declarative schemas that check every request body/query before it reaches business logic |
| Testing | [`node:test`](https://nodejs.org/api/test.html) + [Supertest](https://github.com/ladjs/supertest) | Built into Node, no extra test runner to configure |
| Frontend | Plain HTML/CSS/JavaScript | No framework, no build step — it's a "just open it" static page served by Express |
| Config | [`dotenv`](https://github.com/motdotla/dotenv) | Optional `.env` file for settings; the project runs fine with just the defaults |

No database server, no ORM, no frontend build tooling — the whole project
runs with `npm install` and one command.

---

## Setup instructions

### Requirements

- [Node.js](https://nodejs.org) version 20 or newer
- npm (comes with Node)

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database and load sample data

```bash
npm run reset
```

This creates the SQLite database file, applies the schema, and seeds 3
stores, 9 products, and their initial stock. No `.env` file is required —
every setting has a sensible default.

### 3. Start the server

```bash
npm start
```

- Web panel: <http://localhost:3000>
- API base URL: <http://localhost:3000/api/v1>

### 4. (Optional) Watch it run under simulated load

With the server still running, in a **second terminal**:

```bash
npm run simulate -- --duration 60
```

This spins up 3 simulated stores reporting stock changes in parallel for 60
seconds — one that sells fast, one that receives large shipments, and one
that occasionally sends invalid requests. While it runs, refresh the panel
and watch the numbers move on their own. When it finishes, it checks that
the inventory is still perfectly consistent.

### 5. Run the tests

```bash
npm test
```

This runs the full test suite (35 tests). To run only the tests that prove
the concurrency behavior:

```bash
npm run test:concurrency
```

### Demo credentials

Every request (except the health check) needs an `X-API-Key` header:

| API key | Role | Can |
|---|---|---|
| `sk_store_a_demo`, `sk_store_b_demo`, `sk_store_c_demo` | Store | Report its own stock movements, and read |
| `sk_admin_demo` | Admin | Read everything, configure alert thresholds |

A store can only report movements for itself — if it tries to claim it's a
different store, the request is rejected.

A ready-to-run request collection is in [docs/api.http](docs/api.http)
(works with the VS Code "REST Client" extension or the IntelliJ HTTP
client) if you'd rather click through requests than write `curl` commands.

---

## How it works, in plain terms

The one idea that everything else in this project is built around:

> **Stock is never overwritten — it's calculated from history.**

When a store reports "3 units sold," the system doesn't go find a number
and subtract 3 from it. Instead, it writes down a permanent record — "store
A, product X, −3, at this time" — into a table that is never edited or
deleted, like a bank statement. The current stock is just the sum of all
those records for a given product and store. That sum is kept pre-computed
in a second table so reads stay fast, but it's always kept perfectly in
sync with the record of what actually happened.

**Why does that matter?** Because if the system instead read "current
stock," did the subtraction in code, and wrote the new number back, two
stores reporting at nearly the same time could both read the *same* old
number, and one of their changes would silently vanish. Writing changes as
permanent history, and doing the math inside a single database transaction
instead of in application code, removes that entire category of bug. This
is checked directly by the test suite: it fires many simultaneous requests
at the same product and asserts the final number is exactly right, every
single time.

The same transaction that records a movement also checks that stock never
goes negative (an oversell is rejected, not silently allowed), and updates
the low-stock alert for that product if needed.

---

## API reference

| Method | Route | Who can call it |
|---|---|---|
| `GET` | `/api/v1/health` | anyone |
| `POST` | `/api/v1/movements` | a store, reporting its own stock |
| `GET` | `/api/v1/movements` | any API key |
| `GET` | `/api/v1/inventory?group_by=product\|store` | any API key |
| `GET` | `/api/v1/inventory/:sku` | any API key |
| `GET` | `/api/v1/alerts` | any API key |
| `GET` | `/api/v1/stores` · `/api/v1/products` · `/api/v1/activity` | any API key |
| `PATCH` | `/api/v1/products/:sku/threshold` | admin |
| `GET` | `/api/v1/reconcile` | admin |

### Reporting a movement

```jsonc
// POST /api/v1/movements  (X-API-Key: sk_store_a_demo)
{ "sku": "BOOK-SJM-ACOMAF", "type": "OUT", "quantity": 3, "reason": "pos-sale" }
```

```jsonc
// 201 Created
{
  "movement_id": 42,
  "store_id": "store-a",
  "sku": "BOOK-SJM-ACOMAF",
  "delta": -3,
  "store_quantity": 28,
  "network_quantity": 70,
  "alert": { "triggered": false, "threshold": 20, "event": null }
}
```

`type` is either `"IN"` (stock coming in, adds to quantity) or `"OUT"`
(stock going out, subtracts from quantity). `quantity` is always a positive
number describing the size of the movement — never the resulting total.

### Errors

Every error comes back in the same shape:

```jsonc
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Store store-a has 2 units of BOOK-SJM-ACOMAF; 5 were requested.",
    "details": { "store_id": "store-a", "sku": "BOOK-SJM-ACOMAF", "available": 2, "requested": 5 },
    "request_id": "req_9f2a"
  }
}
```

| Code | HTTP status | When it happens |
|---|---|---|
| `VALIDATION_ERROR` | 400 | The request body/query doesn't match what's expected |
| `UNAUTHORIZED` | 401 | Missing or unknown API key |
| `STORE_MISMATCH` / `STORE_KEY_REQUIRED` / `ADMIN_KEY_REQUIRED` | 403 | Wrong kind of credential for this action |
| `PRODUCT_NOT_FOUND` | 404 | The SKU doesn't exist in the catalog |
| `INSUFFICIENT_STOCK` | 409 | The movement would leave stock negative |
| `INTERNAL_ERROR` | 500 | Something unexpected broke (check the logs, cross-referenced by `request_id`) |

### Project structure

```
src/backend/
  server.js · app.js · config.js    startup and wiring
  db/                                schema, migration script, seed data
  middleware/                        auth · request validation · error handling
  schemas/                           Zod input contracts
  repositories/                      SQL queries, no business rules
  services/                          the transaction logic and alert rules
  routes/                            HTTP endpoints
src/frontend/                        static read-only panel, no build step
scripts/simulate.js                  store simulator, for demo purposes
tests/                               35 tests (node:test + supertest)
```

---

## Known issues or limitations

These are deliberate cuts, made to keep the project focused on its actual
goal (concurrency correctness) instead of growing every adjacent feature.
None of them require touching the core design — each is described below
with what it would take to add.

- **One threshold per product, not one per store.** Alerts only look at
  the network-wide total. A store could be completely out of stock and, as
  long as other stores cover it, no alert fires for that store
  specifically. Adding a per-store threshold would reuse the exact same
  alert logic, just called once more per store.
- **No duplicate-request detection (idempotency).** If a store's request
  times out and it retries, and the *first* request actually did go
  through, the retry is currently treated as a brand-new movement — stock
  would be counted twice. This does not affect the concurrency guarantee
  itself (two different, simultaneous requests can never corrupt each
  other's result); it only affects the specific case of the *same* request
  being sent twice. Fixing it is additive: a client-supplied request ID
  column with a uniqueness constraint, checked at the start of the
  transaction.
- **Alerts are stored and shown in the API, not sent anywhere.** There's
  no email or Slack notification when a product goes low — the alert just
  becomes visible through `GET /alerts` and on the panel. Wiring up a real
  notification would sit on top of the existing alert logic without
  changing it.
- **No rate limiting.** Nothing stops a client from sending requests as
  fast as it can. Fine for a demo; in a real deployment this would usually
  be handled outside the application (API gateway, reverse proxy) rather
  than inside it.
- **API keys are plain text.** They're compared directly, with no
  hashing or rotation. Acceptable for a local demo with seeded, known
  keys; in production these would be hashed at rest, like passwords.
- **Single-file SQLite database.** There's no replication or failover.
  This keeps the project simple to run locally with zero setup, at the
  cost of not being how you'd deploy this for real traffic.

---

## Use of AI assistance

Claude (Anthropic) was used during the development of this project as a
learning and guidance tool — mainly to get explanations of concepts and
feedback on design decisions, not to skip understanding the code that ended
up in the repository. Below are examples of the kind of prompts used.

- "I need to build a backend where multiple stores report stock changes at
  the same time, and the total inventory always has to stay correct. What's
  the actual problem with updating a number directly when two requests can
  arrive at once, and what approach would avoid it?"
- "Explain what a database transaction is and why wrapping a stock update
  and its related changes in one transaction matters, using an example
  with numbers."
- "How should I organize an Express + SQLite project so the routes,
  business logic, and database queries aren't all mixed into one file?
  What does each folder end up being responsible for?"
- "What's the difference between validating a request manually inside a
  route versus using a validation middleware? Why would one be preferable?"
- "Walk me through, step by step, how I should have built this project —
  what would get built first, what depends on what, and why."
- "I'm not sure my authentication logic is doing what I think it does —
  can you trace exactly what happens when a request arrives without an API
  key, step by step?"

The final code, the explanations behind each design choice, and the
decision of what to simplify or keep were reviewed and understood before
being included here — the goal of using the tool this way was to learn the
concepts (concurrency, transactions, middleware, testing), not to submit
code without being able to explain it.
