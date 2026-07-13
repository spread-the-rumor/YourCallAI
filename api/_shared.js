// Shared helpers for the Vercel proxy functions.

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// App-token gate: the proxy relays client-supplied Slack tokens, so sensitive routes
// require a shared secret (baked into the client build) that a random caller of the
// public URL won't have. Returns true if the request is allowed; else writes 401 and
// returns false — callers must stop when it returns false.
// ponytail: single shared secret, not per-user; rotate APP_PROXY_TOKEN if it leaks.
function requireAppToken(req, res) {
  const expected = env('APP_PROXY_TOKEN');
  if (!expected) return true; // gate disabled if unset (dev / not yet configured)
  if (req.headers['x-app-token'] === expected) return true;
  json(res, 401, { ok: false, error: 'Unauthorized' });
  return false;
}

// Read+parse a JSON request body (Vercel Node functions give req.body pre-parsed when
// Content-Type is json, but be defensive for raw streams).
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const env = (k) => process.env[k];

module.exports = { json, readJson, env, requireAppToken };
