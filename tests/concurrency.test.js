import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { KEYS, buildTestApp, countMovements, ledgerOf, stockOf } from './helpers.js';

/**
 * The test that backs the design (see README.md).
 *
 * If the logic did a read-modify-write in JavaScript, these assertions would
 * fail intermittently: that's exactly the class of bug the delta model plus
 * single-transaction writes eliminates.
 */
describe('Concurrency and consistency', () => {
  let app;
  let db;

  before(() => { ({ app, db } = buildTestApp()); });
  after(() => db.close());

  it('simultaneous movements on the same SKU settle exactly', async () => {
    const SKU = 'BOOK-CSP-CAPTIVE';
    const STORE = 'store-a';
    const initial = stockOf(db, STORE, SKU);

    // 18 one-unit IN and 12 one-unit OUT, all fired at once.
    const requests = [
      ...Array.from({ length: 18 }, () => ({ type: 'IN', quantity: 1 })),
      ...Array.from({ length: 12 }, () => ({ type: 'OUT', quantity: 1 })),
    ].sort(() => Math.random() - 0.5);

    const responses = await Promise.all(
      requests.map((movement) => request(app)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeA)
        .send({ sku: SKU, ...movement })),
    );

    assert.equal(
      responses.filter((r) => r.status === 201).length, 30,
      'all 30 requests must be applied',
    );

    const expected = initial + 18 - 12;
    assert.equal(stockOf(db, STORE, SKU), expected, 'final stock must be exact');
    assert.equal(countMovements(db, STORE, SKU), 31, '30 movements + 1 from the initial load');
    assert.equal(
      ledgerOf(db, STORE, SKU), stockOf(db, STORE, SKU),
      'the projection must equal the sum of the ledger',
    );
  });

  it('concurrent overselling: only the movements that fit are applied', async () => {
    const { app: isolatedApp, db: isolatedDb } = buildTestApp();
    const SKU = 'BOOK-HK-VEGET';
    const STORE = 'store-b';

    // store-b starts with 3 units of BOOK-HK-VEGET; fire 6 concurrent OUT 1.
    const initial = stockOf(isolatedDb, STORE, SKU);
    assert.equal(initial, 3);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(isolatedApp)
        .post('/api/v1/movements')
        .set('X-API-Key', KEYS.storeB)
        .send({ sku: SKU, type: 'OUT', quantity: 1 })),
    );

    const applied = responses.filter((r) => r.status === 201).length;
    const rejected = responses.filter((r) => r.status === 409).length;

    assert.equal(applied, 3, 'only 3 exits fit');
    assert.equal(rejected, 3, 'the other 3 must be rejected with 409');
    assert.equal(stockOf(isolatedDb, STORE, SKU), 0, 'stock lands at 0, never negative');
    assert.equal(ledgerOf(isolatedDb, STORE, SKU), 0, 'the projection still matches the ledger');

    const reconcile = await request(isolatedApp)
      .get('/api/v1/reconcile')
      .set('X-API-Key', KEYS.admin)
      .expect(200);
    assert.equal(reconcile.body.consistent, true, 'the ledger and the projection still agree');

    isolatedDb.close();
  });
});
