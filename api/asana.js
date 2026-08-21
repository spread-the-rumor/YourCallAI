// POST /api/asana — forward { pathname, method, body, token } to the Asana REST API.
// token is the caller's own per-user OAuth access token; there is no shared server-side
// fallback (unlike Slack's Bot_User_OAuth_Token) because Asana tasks must be created as
// the acting user. Path allowlist: the relayed token can't be driven to arbitrary calls.
// App-token gate: only our client (with APP_PROXY_TOKEN) may relay.
const { json, readJson, requireAppToken } = require('./_shared');

const BASE = 'https://app.asana.com/api/1.0';

// [method, pathname regex]. The pathname is matched WITHOUT its query string, so opt_fields /
// limit / offset params are free — they can't widen access beyond the listed resources.
const ALLOWED = [
  ['GET', /^\/workspaces$/],
  ['GET', /^\/workspaces\/\d+\/projects$/],
  ['GET', /^\/workspaces\/\d+\/users$/],
  ['POST', /^\/tasks$/],
];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  if (!requireAppToken(req, res)) return;

  const { pathname, method = 'GET', body, token } = await readJson(req);
  if (!token) return json(res, 200, { ok: false, error: 'Asana not connected.' });
  if (!pathname || !pathname.startsWith('/')) return json(res, 200, { ok: false, error: 'Invalid pathname.' });

  const verb = String(method).toUpperCase();
  const bare = pathname.split('?')[0];
  if (!ALLOWED.some(([m, re]) => m === verb && re.test(bare))) {
    return json(res, 200, { ok: false, error: `Asana path not allowed: ${verb} ${bare}` });
  }

  try {
    // Asana is a JSON API and wraps request/response payloads in { data: … } — this is the
    // one place NOT to copy the Slack proxy's form-urlencoded body.
    const r = await fetch(`${BASE}${pathname}`, {
      method: verb,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const respBody = await r.json().catch(() => ({}));

    // Pass the rate-limit hint through so client-side back-off can honour it.
    const retry = r.headers.get('retry-after');
    if (retry) res.setHeader('Retry-After', retry);

    // 401 is reported distinctly (with status) so the client knows to refresh + retry rather
    // than surfacing a dead end to the user.
    if (r.status === 401) return json(res, 200, { ok: false, status: 401, error: 'unauthorized' });

    if (!r.ok) {
      // Asana errors arrive as { errors: [{ message }] }.
      const msg = respBody.errors?.[0]?.message || respBody.error_description || respBody.error || `Asana ${r.status}`;
      return json(res, 200, { ok: false, status: r.status, error: msg });
    }
    json(res, 200, { ok: true, status: r.status, body: respBody });
  } catch (err) {
    json(res, 200, { ok: false, error: `Asana request failed: ${err.message}` });
  }
};
