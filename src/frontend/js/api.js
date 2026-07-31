/**
 * API client for the demo panel.
 *
 * Uses the admin (read) key: the panel NEVER writes. That's a deliberate
 * choice — every mutation enters through the stores, so if the panel shows a
 * change, it's because the backend genuinely consolidated it.
 *
 * In production this constant would be replaced by a real user session; this
 * is the single place to change.
 */
const API_KEY = 'sk_admin_demo';
const BASE = '/api/v1';

async function get(path, params = {}) {
  const url = new URL(BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`);
    error.code = body?.error?.code;
    throw error;
  }

  return body;
}

export const api = {
  inventory: (filters) => get('/inventory', { page_size: 200, ...filters }),
  alerts: () => get('/alerts', { status: 'OPEN', page_size: 50 }),
  activity: (limit = 15) => get('/activity', { limit }),
  stores: () => get('/stores'),
  products: () => get('/products'),
};
