// POST /api/slack — forward { method, params, token } to Slack.
// token is the caller's own user token (xoxp-, per-user OAuth); falls back to a shared
// bot token if the server still has one. Method allowlist: the token can't be driven to
// arbitrary Slack calls. App-token gate: only our client (with APP_PROXY_TOKEN) may relay.
const { json, readJson, env, requireAppToken } = require('./_shared');

const ALLOWED = new Set([
  'users.conversations', 'conversations.open',
  'users.list', 'users.info', 'chat.postMessage',
]);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  if (!requireAppToken(req, res)) return;

  const { method, params = {}, token: clientToken } = await readJson(req);
  const token = clientToken || env('Bot_User_OAuth_Token');
  if (!token) return json(res, 200, { ok: false, error: 'Slack not connected.' });

  if (!ALLOWED.has(method)) return json(res, 200, { ok: false, error: `Slack method not allowed: ${method}` });

  try {
    // Slack Web API reads params from form-urlencoded; a JSON body is IGNORED for read
    // methods (users.conversations/users.list), silently dropping params like `types`.
    // All our params are flat (channel/text/types/limit/booleans) so URLSearchParams is safe.
    const r = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    // Pass through Slack's status (429 rate-limit incl. Retry-After) so the client's retry logic still works.
    const retry = r.headers.get('retry-after');
    if (retry) res.setHeader('Retry-After', retry);
    const body = await r.json();
    json(res, r.status, body);
  } catch (err) {
    json(res, 502, { ok: false, error: `Slack request failed: ${err.message}` });
  }
};
