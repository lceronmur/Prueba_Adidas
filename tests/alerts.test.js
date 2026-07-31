import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { KEYS, buildTestApp, openAlert } from './helpers.js';

describe('Low-stock alerts', () => {
  let app;
  let db;

  before(() => { ({ app, db } = buildTestApp()); });
  after(() => db.close());

  it('the initial load leaves BOOK-HK-VEGET with an open alert', () => {
    // 2 + 3 + 1 = 6 units network-wide, threshold 8.
    const alert = openAlert(db, 'BOOK-HK-VEGET');
    assert.ok(alert, 'an open alert must exist');
    assert.equal(alert.quantity_at_trigger, 6);
    assert.equal(alert.threshold, 8);
  });

  it('crossing the threshold opens exactly one alert, not one per movement', async () => {
    // BOOK-VES-DSOM starts at 20 + 15 + 12 = 47 network-wide, threshold 25.
    assert.equal(openAlert(db, 'BOOK-VES-DSOM'), undefined);

    // 47 -> 27: still above the threshold.
    const noCross = await request(app).post('/api/v1/movements').set('X-API-Key', KEYS.storeA)
      .send({ sku: 'BOOK-VES-DSOM', type: 'OUT', quantity: 20 }).expect(201);
    assert.equal(noCross.body.network_quantity, 27);
    assert.equal(noCross.body.alert.triggered, false);

    // 27 -> 26: still above.
    await request(app).post('/api/v1/movements').set('X-API-Key', KEYS.storeB)
      .send({ sku: 'BOOK-VES-DSOM', type: 'OUT', quantity: 1 }).expect(201);

    // 26 -> 25: the threshold is crossed here.
    const crossing = await request(app).post('/api/v1/movements').set('X-API-Key', KEYS.storeB)
      .send({ sku: 'BOOK-VES-DSOM', type: 'OUT', quantity: 1 }).expect(201);

    assert.equal(crossing.body.network_quantity, 25);
    assert.equal(crossing.body.alert.triggered, true);
    assert.equal(crossing.body.alert.event.action, 'OPENED');

    // One more movement below the threshold must not open a second alert.
    const next = await request(app).post('/api/v1/movements').set('X-API-Key', KEYS.storeB)
      .send({ sku: 'BOOK-VES-DSOM', type: 'OUT', quantity: 1 }).expect(201);

    assert.equal(next.body.alert.triggered, false);

    const openCount = db
      .prepare("SELECT COUNT(*) AS total FROM alerts WHERE sku = ? AND status = 'OPEN'")
      .get('BOOK-VES-DSOM').total;
    assert.equal(openCount, 1, 'only one open alert per product');
  });

  it('restocking above the threshold resolves the open alert', async () => {
    assert.ok(openAlert(db, 'BOOK-VES-DSOM'), 'the alert from the previous test is still open');

    const response = await request(app).post('/api/v1/movements').set('X-API-Key', KEYS.storeC)
      .send({ sku: 'BOOK-VES-DSOM', type: 'IN', quantity: 5 }).expect(201);

    assert.ok(response.body.network_quantity > 25);
    assert.equal(response.body.alert.event.action, 'RESOLVED');
    assert.equal(openAlert(db, 'BOOK-VES-DSOM'), undefined);
  });

  it('raising the threshold opens an alert immediately, without waiting for a movement', async () => {
    const response = await request(app)
      .patch('/api/v1/products/BOOK-SJM-ACOMAF/threshold')
      .set('X-API-Key', KEYS.admin)
      .send({ low_stock_threshold: 500 })
      .expect(200);

    assert.equal(response.body.product.low_stock_threshold, 500);
    assert.equal(response.body.alert_event.action, 'OPENED');
    assert.ok(openAlert(db, 'BOOK-SJM-ACOMAF'));
  });

  it('lowering the threshold resolves the open alert', async () => {
    const response = await request(app)
      .patch('/api/v1/products/BOOK-SJM-ACOMAF/threshold')
      .set('X-API-Key', KEYS.admin)
      .send({ low_stock_threshold: 20 })
      .expect(200);

    assert.equal(response.body.alert_event.action, 'RESOLVED');
    assert.equal(openAlert(db, 'BOOK-SJM-ACOMAF'), undefined);
  });

  it('the threshold endpoint requires the admin key', async () => {
    await request(app)
      .patch('/api/v1/products/BOOK-SJM-ACOMAF/threshold')
      .set('X-API-Key', KEYS.storeA)
      .send({ low_stock_threshold: 5 })
      .expect(403);
  });

  it('GET /alerts returns only open alerts by default', async () => {
    const response = await request(app)
      .get('/api/v1/alerts')
      .set('X-API-Key', KEYS.admin)
      .expect(200);

    assert.ok(response.body.data.length > 0);
    assert.ok(response.body.data.every((a) => a.status === 'OPEN'));
    assert.equal(response.body.meta.open_total, response.body.meta.total);
  });

  it('GET /alerts?status=RESOLVED returns the history', async () => {
    const response = await request(app)
      .get('/api/v1/alerts?status=RESOLVED')
      .set('X-API-Key', KEYS.admin)
      .expect(200);

    assert.ok(response.body.data.every((a) => a.status === 'RESOLVED'));
    assert.ok(response.body.data.every((a) => a.resolved_at !== null));
  });
});
