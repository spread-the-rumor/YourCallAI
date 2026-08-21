// POST /api/asana/oauth-refresh  { refreshToken }  -> { ok, token, expiresAt }
// Asana access tokens expire in ~1h. Refreshing needs the client_secret, which must stay
// server-side, so the client can't do this itself — it calls here instead. No Slack analogue
// (Slack user tokens don't expire). The refresh token itself is long-lived and stays on the
// client; we never persist it here.
const { json, readJson, requireAppToken, env } = require('../_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  if (!requireAppToken(req, res)) return;

  const { refreshToken } = await readJson(req);
  if (!refreshToken) return json(res, 200, { ok: false, error: 'Missing refreshToken.' });

  const clientId = env('ASANA_CLIENT_ID');
  const clientSecret = env('ASANA_CLIENT_SECRET');
  if (!clientId || !clientSecret) return json(res, 200, { ok: false, error: 'Asana OAuth not configured on server.' });

  try {
    const r = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.access_token) {
      // A revoked/rotated refresh token lands here — the client surfaces "reconnect in Settings".
      return json(res, 200, { ok: false, error: data.error_description || data.error || 'Refresh failed.' });
    }
    return json(res, 200, {
      ok: true,
      token: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    });
  } catch (err) {
    return json(res, 200, { ok: false, error: `Asana refresh failed: ${err.message}` });
  }
};
