import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { KEYS, buildTestApp, ledgerOf, stockOf } from './helpers.js';

describe('Movements API contract', () => {
  let app;
  let db;

  before(() => { ({ app, db } = buildTestApp()); });
  after(() => db.close());

  describe('Authentication and authorization', () => {
    it('returns 401 with no API key', async () => {
      const response = await request(app)
        .post('/api/v1/movements')
        .send({ sku: 'BOOK-CSP-CAPTIVE', type: 'IN', quantity: 1 })
        .expect(401);

      assert.equal(response.body.error.code, 'UNAUTHORIZED');
      assert.match(response.body.error.request_id, /^req_/);
    });

    it('returns 401 with an unknown API key', async () => {
      await request(app)
        .get('/api/v1/inventory')
        .set('X-API-Key', 'sk_made_up')
        .expect(401);
    });

    it('a store cannot report on behalf of another store (403)', async () => {
      const response = await request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeA)
        .send({ store_id: 'store-b', sku: 'BOOK-CSP-CAPTIVE', type: 'IN', quantity: 1 })
        .expect(403);

      assert.equal(response.body.error.code, 'STORE_MISMATCH');
      assert.equal(response.body.error.details.authenticated_store, 'store-a');
    });

    it('the admin key is read-only: it cannot report movements (403)', async () => {
      const response = await request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.admin)
        .send({ sku: 'BOOK-CSP-CAPTIVE', type: 'IN', quantity: 1 })
        .expect(403);

      assert.equal(response.body.error.code, 'STORE_KEY_REQUIRED');
    });

    it('/reconcile requires the admin key', async () => {
      await request(app).get('/api/v1/reconcile').set('X-API-Key', KEYS.storeA).expect(403);
      await request(app).get('/api/v1/reconcile').set('X-API-Key', KEYS.admin).expect(200);
    });
  });

  describe('Input validation', () => {
    const cases = [
      ['negative quantity', { sku: 'BOOK-CSP-CAPTIVE', type: 'IN', quantity: -5 }],
      ['zero quantity', { sku: 'BOOK-CSP-CAPTIVE', type: 'IN', quantity: 0 }],
      ['decimal quantity', { sku: 'BOOK-CSP-CAPTIVE', type: 'IN', quantity: 1.5 }],
      ['unknown type', { sku: 'BOOK-CSP-CAPTIVE', type: 'TRANSFER', quantity: 1 }],
      ['missing sku', { type: 'IN', quantity: 1 }],
      ['unknown field', { sku: 'BOOK-CSP-CAPTIVE', type: 'IN', quantity: 1, qty: 3 }],
    ];

    for (const [name, body] of cases) {
      it(`rejects ${name} with 400`, async () => {
        const response = await request(app)
          .post('/api/v1/movements')
          .set('X-API-Key', KEYS.storeA)
          .send(body)
          .expect(400);

        assert.equal(response.body.error.code, 'VALIDATION_ERROR');
        assert.ok(response.body.error.details.issues.length > 0);
      });
    }

    it('rejects malformed JSON with 400', async () => {
      const response = await request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeA)
        .set('Content-Type', 'application/json')
        .send('{"sku": ')
        .expect(400);

      assert.equal(response.body.error.code, 'MALFORMED_JSON');
    });

    it('returns 404 when the product is not in the catalog', async () => {
      const response = await request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeA)
        .send({ sku: 'DOES-NOT-EXIST', type: 'IN', quantity: 1 })
        .expect(404);

      assert.equal(response.body.error.code, 'PRODUCT_NOT_FOUND');
    });
  });

  describe('Applying movements', () => {
    it('IN adds to the store stock and to the network total', async () => {
      const before_ = stockOf(db, 'store-a', 'BOOK-SJM-ACOMAF');

      const response = await request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeA)
        .send({ sku: 'BOOK-SJM-ACOMAF', type: 'IN', quantity: 10 })
        .expect(201);

      assert.equal(response.body.delta, 10);
      assert.equal(response.body.store_quantity, before_ + 10);
      assert.equal(stockOf(db, 'store-a', 'BOOK-SJM-ACOMAF'), before_ + 10);
    });

    it('OUT subtracts exactly what was reported', async () => {
      const before_ = stockOf(db, 'store-a', 'BOOK-SJM-ACOMAF');

      const response = await request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeA)
        .send({ sku: 'BOOK-SJM-ACOMAF', type: 'OUT', quantity: 3 })
        .expect(201);

      assert.equal(response.body.delta, -3);
      assert.equal(stockOf(db, 'store-a', 'BOOK-SJM-ACOMAF'), before_ - 3);
    });

    it('an OUT larger than the stock returns 409 and changes nothing', async () => {
      const before_ = stockOf(db, 'store-c', 'BOOK-SJM-ACOTAR');

      const response = await request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeC)
        .send({ sku: 'BOOK-SJM-ACOTAR', type: 'OUT', quantity: before_ + 1 })
        .expect(409);

      assert.equal(response.body.error.code, 'INSUFFICIENT_STOCK');
      assert.equal(response.body.error.details.available, before_);
      assert.equal(stockOf(db, 'store-c', 'BOOK-SJM-ACOTAR'), before_, 'stock must stay untouched');
    });

    it('the network total sums every store', async () => {
      const response = await request(app)
        .get('/api/v1/inventory/BOOK-HB-WK')
        .set('X-API-Key', KEYS.admin)
        .expect(200);

      const total = response.body.by_store.reduce((sum, s) => sum + s.quantity, 0);
      assert.equal(response.body.network_quantity, total);
    });
  });

  describe('Queries', () => {
    it('filters by store with group_by=store', async () => {
      const response = await request(app)
        .get('/api/v1/inventory?group_by=store&store_id=store-b')
        .set('X-API-Key', KEYS.admin)
        .expect(200);

      assert.ok(response.body.data.length > 0);
      assert.ok(response.body.data.every((row) => row.store_id === 'store-b'));
    });

    it('low_stock=true returns only products under the network threshold', async () => {
      const response = await request(app)
        .get('/api/v1/inventory?low_stock=true')
        .set('X-API-Key', KEYS.admin)
        .expect(200);

      assert.ok(response.body.data.every((row) => row.network_quantity <= row.threshold));
    });

    it('low_stock=false is not interpreted as true', async () => {
      const response = await request(app)
        .get('/api/v1/inventory?low_stock=false')
        .set('X-API-Key', KEYS.admin)
        .expect(200);

      assert.ok(response.body.data.every((row) => row.network_quantity > row.threshold));
    });

    it('filters by stock range', async () => {
      const response = await request(app)
        .get('/api/v1/inventory?min_qty=10&max_qty=40')
        .set('X-API-Key', KEYS.admin)
        .expect(200);

      assert.ok(response.body.data.every((r) => r.network_quantity >= 10 && r.network_quantity <= 40));
    });

    it('rejects min_qty greater than max_qty', async () => {
      await request(app)
        .get('/api/v1/inventory?min_qty=50&max_qty=10')
        .set('X-API-Key', KEYS.admin)
        .expect(400);
    });

    it('history filters by product and type', async () => {
      const response = await request(app)
        .get('/api/v1/movements?sku=BOOK-SJM-ACOMAF&type=OUT')
        .set('X-API-Key', KEYS.admin)
        .expect(200);

      assert.ok(response.body.data.every((m) => m.sku === 'BOOK-SJM-ACOMAF' && m.type === 'OUT'));
      assert.ok(response.body.data.every((m) => typeof m.resulting_qty === 'number'));
    });

    it('paginates results', async () => {
      const response = await request(app)
        .get('/api/v1/inventory?page=2&page_size=5')
        .set('X-API-Key', KEYS.admin)
        .expect(200);

      assert.equal(response.body.meta.page, 2);
      assert.equal(response.body.meta.page_size, 5);
      assert.ok(response.body.data.length <= 5);
    });

    it('an unknown route returns 404 with the standard error format', async () => {
      const response = await request(app)
        .get('/api/v1/does-not-exist')
        .set('X-API-Key', KEYS.admin)
        .expect(404);

      assert.equal(response.body.error.code, 'ROUTE_NOT_FOUND');
    });
  });
});
