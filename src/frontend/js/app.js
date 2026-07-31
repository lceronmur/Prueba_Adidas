import { api } from './api.js';

const POLL_MS = 3000;

const el = {
  head: document.getElementById('inventory-head'),
  body: document.getElementById('inventory-body'),
  alerts: document.getElementById('alerts-list'),
  alertsCount: document.getElementById('alerts-count'),
  activity: document.getElementById('activity-list'),
  pillStores: document.getElementById('pill-stores'),
  pillAlerts: document.getElementById('pill-alerts'),
  dot: document.getElementById('dot-conn'),
  updated: document.getElementById('last-updated'),
  count: document.getElementById('result-count'),
  filterSku: document.getElementById('filter-sku'),
  filterStore: document.getElementById('filter-store'),
  filterCategory: document.getElementById('filter-category'),
  filterLow: document.getElementById('filter-low'),
};

const state = { stores: [], filters: { sku: '', store: '', category: '', low: false } };

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

const formatTime = (iso) => {
  // SQLite returns 'YYYY-MM-DD HH:MM:SS' in UTC, with no timezone suffix.
  const date = new Date(`${String(iso).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString('en-GB', { hour12: false });
};

// --- Render ------------------------------------------------------------------

function renderHead(stores) {
  el.head.innerHTML = `
    <tr>
      <th>SKU</th>
      <th>Product</th>
      ${stores.map((s) => `<th class="num" title="${escape(s.name)}">${escape(s.id.replace('store-', '').toUpperCase())}</th>`).join('')}
      <th class="num">NETWORK</th>
      <th class="num">Threshold</th>
      <th>Status</th>
    </tr>`;
}

function renderInventory(rows, stores) {
  if (!rows.length) {
    el.body.innerHTML = `<tr><td class="empty" colspan="${stores.length + 5}">No product matches the current filters.</td></tr>`;
    el.count.textContent = '0 products';
    return;
  }

  el.body.innerHTML = rows.map((row) => {
    const byStore = new Map(row.by_store.map((entry) => [entry.store_id, entry]));

    const cells = stores.map((store) => {
      const entry = byStore.get(store.id);
      return `<td class="num">${entry?.quantity ?? 0}</td>`;
    }).join('');

    return `
      <tr data-low="${row.low_stock}">
        <td class="sku">${escape(row.sku)}</td>
        <td class="product">${escape(row.name)}</td>
        ${cells}
        <td class="num total">${row.network_quantity}</td>
        <td class="num">${row.threshold}</td>
        <td>${row.low_stock
    ? '<span class="status status--low">▲ LOW</span>'
    : '<span class="status status--ok">● OK</span>'}</td>
      </tr>`;
  }).join('');

  const low = rows.filter((r) => r.low_stock).length;
  el.count.textContent = `${rows.length} product${rows.length === 1 ? '' : 's'}${low ? ` · ${low} low stock` : ''}`;
}

function renderAlerts(alerts) {
  el.alertsCount.textContent = alerts.length;
  el.pillAlerts.textContent = `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`;
  el.pillAlerts.dataset.active = alerts.length > 0;

  el.alerts.innerHTML = alerts.length
    ? alerts.map((alert) => `
        <li>
          <span class="feed-text">
            <span class="mono">${escape(alert.sku)}</span>
            — ${alert.quantity_at_trigger}/${alert.threshold}
          </span>
          <span class="time">${formatTime(alert.created_at)}</span>
        </li>`).join('')
    : '<li class="empty">No open alerts</li>';
}

function renderActivity(movements) {
  el.activity.innerHTML = movements.length
    ? movements.map((m) => `
        <li>
          <span class="time">${formatTime(m.created_at)}</span>
          <span class="tag tag--${m.type}">${m.type}</span>
          <span class="feed-text">
            ${escape(m.store_id)} · <span class="mono">${escape(m.sku)}</span>
            ${m.delta > 0 ? '+' : ''}${m.delta} → ${m.resulting_qty}
          </span>
        </li>`).join('')
    : '<li class="empty">No activity yet</li>';
}

// --- Update cycle --------------------------------------------------------------

async function refresh() {
  try {
    const [inventory, alerts, activity] = await Promise.all([
      api.inventory({
        sku: state.filters.sku,
        category: state.filters.category,
        low_stock: state.filters.low ? 'true' : undefined,
      }),
      api.alerts(),
      api.activity(15),
    ]);

    // The store filter is applied client-side: the consolidated view already
    // brings the full per-store breakdown, so no extra request is needed.
    const rows = state.filters.store
      ? inventory.data.filter((row) => row.by_store.some(
        (entry) => entry.store_id === state.filters.store && entry.quantity > 0,
      ))
      : inventory.data;

    renderInventory(rows, state.stores);
    renderAlerts(alerts.data);
    renderActivity(activity.data);

    el.dot.dataset.state = 'ok';
    el.dot.title = 'Connected';
    el.updated.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  } catch (error) {
    el.dot.dataset.state = 'error';
    el.dot.title = `Error: ${error.message}`;
    el.updated.textContent = 'disconnected';
  }
}

async function init() {
  const [stores, products] = await Promise.all([api.stores(), api.products()]);

  state.stores = stores.data;
  renderHead(state.stores);

  el.pillStores.textContent = `${state.stores.length} store${state.stores.length === 1 ? '' : 's'}`;

  el.filterStore.insertAdjacentHTML('beforeend', state.stores
    .map((s) => `<option value="${escape(s.id)}">${escape(s.name)}</option>`)
    .join(''));

  const categories = [...new Set(products.data.map((p) => p.category).filter(Boolean))].sort();
  el.filterCategory.insertAdjacentHTML('beforeend', categories
    .map((c) => `<option value="${escape(c)}">${escape(c)}</option>`)
    .join(''));

  let debounce;
  el.filterSku.addEventListener('input', (event) => {
    clearTimeout(debounce);
    state.filters.sku = event.target.value.trim();
    debounce = setTimeout(refresh, 250);
  });
  el.filterStore.addEventListener('change', (e) => { state.filters.store = e.target.value; refresh(); });
  el.filterCategory.addEventListener('change', (e) => { state.filters.category = e.target.value; refresh(); });
  el.filterLow.addEventListener('change', (e) => { state.filters.low = e.target.checked; refresh(); });

  await refresh();
  setInterval(refresh, POLL_MS);
}

init().catch((error) => {
  el.body.innerHTML = `<tr><td class="empty">Could not load the panel: ${escape(error.message)}</td></tr>`;
  el.dot.dataset.state = 'error';
});
