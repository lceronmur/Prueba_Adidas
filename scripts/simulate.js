/**
 * Simulates stores reporting stock movements in parallel.
 *
 * The goal isn't pretty traffic, it's to exercise what actually happens on a
 * real store network: concurrent bursts and malformed requests. While it
 * runs, the panel moves on its own and `GET /reconcile` should keep
 * returning zero discrepancies.
 *
 * Usage:  npm run simulate -- [--duration 120] [--url http://localhost:3000]
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const BASE = flag('url', 'http://localhost:3000');
const DURATION_S = Number(flag('duration', 120));
const ADMIN_KEY = flag('admin-key', 'sk_admin_demo');

const PROFILES = [
  {
    id: 'store-a',
    apiKey: 'sk_store_a_demo',
    label: 'high turnover',
    interval: () => 300 + Math.random() * 500,
    // Mostly sales: this store drains stock and triggers alerts.
    movement: (sku) => ({ sku, type: 'OUT', quantity: 1 + Math.floor(Math.random() * 3), reason: 'pos-sale' }),
    invalidRate: 0,
  },
  {
    id: 'store-b',
    apiKey: 'sk_store_b_demo',
    label: 'receiving',
    interval: () => 4000 + Math.random() * 2000,
    // Batched restocking: resolves alerts.
    movement: (sku) => ({ sku, type: 'IN', quantity: 10 + Math.floor(Math.random() * 40), reason: 'warehouse-receipt' }),
    invalidRate: 0,
  },
  {
    id: 'store-c',
    apiKey: 'sk_store_c_demo',
    label: 'erratic',
    interval: () => 600 + Math.random() * 900,
    movement: (sku) => (Math.random() < 0.6
      ? { sku, type: 'OUT', quantity: 1 + Math.floor(Math.random() * 2), reason: 'pos-sale' }
      : { sku, type: 'IN', quantity: 2 + Math.floor(Math.random() * 8), reason: 'incoming-transfer' }),
    // 5% invalid requests.
    invalidRate: 0.05,
  },
];

const stats = new Map(PROFILES.map((p) => [p.id, {
  sent: 0, applied: 0, outOfStock: 0, invalid: 0, other: 0,
}]));

let SKUS = [];
let running = true;

async function apiGet(path, key = ADMIN_KEY) {
  const response = await fetch(`${BASE}${path}`, { headers: { 'X-API-Key': key } });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return response.json();
}

async function report(profile, body) {
  const record = stats.get(profile.id);
  record.sent += 1;

  try {
    const response = await fetch(`${BASE}/api/v1/movements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': profile.apiKey },
      body: JSON.stringify(body),
    });

    const responseBody = await response.json().catch(() => ({}));

    if (response.status === 201) record.applied += 1;
    else if (responseBody?.error?.code === 'INSUFFICIENT_STOCK') record.outOfStock += 1;
    else if (responseBody?.error?.code === 'VALIDATION_ERROR') record.invalid += 1;
    else record.other += 1;
  } catch {
    record.other += 1;
  }
}

async function runStore(profile) {
  while (running) {
    const sku = SKUS[Math.floor(Math.random() * SKUS.length)];

    if (Math.random() < profile.invalidRate) {
      // Negative quantity: must bounce with 400 without touching the inventory.
      await report(profile, { sku, type: 'OUT', quantity: -1 });
    } else {
      await report(profile, profile.movement(sku));
    }

    await new Promise((resolve) => setTimeout(resolve, profile.interval()));
  }
}

function printSummary() {
  console.log('\n+- Per-store summary ' + '-'.repeat(44));
  console.log('| store      profile          sent   applied   no-stock   invalid');
  for (const profile of PROFILES) {
    const s = stats.get(profile.id);
    console.log(
      `| ${profile.id.padEnd(10)} ${profile.label.padEnd(15)} `
      + `${String(s.sent).padStart(6)} ${String(s.applied).padStart(9)} `
      + `${String(s.outOfStock).padStart(10)} ${String(s.invalid).padStart(9)}`,
    );
  }
  console.log('+' + '-'.repeat(65));
}

async function checkConsistency() {
  const { consistent, discrepancies } = await apiGet('/api/v1/reconcile');

  if (consistent) {
    console.log('\n[OK] /reconcile: 0 discrepancies - the projection matches the ledger');
  } else {
    console.error(`\n[FAIL] /reconcile: ${discrepancies.length} discrepancies`);
    console.error(discrepancies);
    process.exitCode = 1;
  }
}

async function main() {
  const { data: products } = await apiGet('/api/v1/products');
  SKUS = products.map((product) => product.sku);

  console.log(`- simulating ${PROFILES.length} stores against ${BASE} for ${DURATION_S}s`);
  console.log(`  ${SKUS.length} SKUs · Ctrl+C to stop early\n`);

  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  setTimeout(stop, DURATION_S * 1000);

  const ticker = setInterval(async () => {
    const { open_alerts: openAlerts } = await apiGet('/api/v1/health').catch(() => ({}));
    const total = [...stats.values()].reduce((sum, s) => sum + s.sent, 0);
    process.stdout.write(`\r  ${total} movements sent · ${openAlerts ?? '—'} open alerts   `);
  }, 2000);

  await Promise.all(PROFILES.map(runStore));

  clearInterval(ticker);
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  printSummary();
  await checkConsistency();
}

main().catch((error) => {
  console.error(`\n[ERROR] ${error.message}`);
  console.error('  Is the server running? -> npm start');
  process.exit(1);
});
