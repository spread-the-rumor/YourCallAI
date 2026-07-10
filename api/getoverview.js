// POST /api/getoverview — forward { pathname, method, body } to GetOverview, inject base+token.
const { json, readJson, env } = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  const base = env('GetOverview_BASE_URL');
  const token = env('GetOverview_Access_Token');
  if (!base || !token) return json(res, 200, { ok: false, error: 'GetOverview not configured on server.' });

  const { pathname, method = 'GET', body } = await readJson(req);
  if (!pathname || !pathname.startsWith('/')) return json(res, 200, { ok: false, error: 'Invalid pathname.' });

  try {
    const r = await fetch(`${base.replace(/\/$/, '')}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const respBody = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) {
      return json(res, 200, { ok: false, error: respBody.error || respBody.message || `GetOverview ${r.status}` });
    }
    json(res, 200, { ok: true, status: r.status, body: respBody });
  } catch (err) {
    json(res, 200, { ok: false, error: `GetOverview request failed: ${err.message}` });
  }
};
