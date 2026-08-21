// GET /api/asana/oauth-callback?code=<asana_code>&state=<state>
// Asana redirects here after the user authorizes. We exchange the code for the user's
// access token server-side (client_secret never leaves Vercel), stash it in KV under a
// single-use one-time code (120s TTL), and 302 back to the app via the custom protocol.
// The actual token never rides the deep link — only the OTC does, redeemed over HTTPS.
// Unlike Slack, Asana access tokens expire (~3600s) and come with a refresh_token, so we
// store both plus an absolute expiry the client can check before each call.
const { env, redisClient } = require('../_shared');
const crypto = require('crypto');

const DEEP_LINK = 'yourcallai://asana';

function redirect(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.writeHead(302, { Location: `${DEEP_LINK}?${qs}` });
  res.end();
}

module.exports = async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) return redirect(res, { error, state: state || '' });
  if (!code) return redirect(res, { error: 'missing_code', state: state || '' });

  const clientId = env('ASANA_CLIENT_ID');
  const clientSecret = env('ASANA_CLIENT_SECRET');
  // Must EXACTLY match the authorize-step redirect_uri (client uses PROXY_URL) and the Asana
  // app config. Do NOT use VERCEL_URL — it's the per-deployment host (…-<hash>.vercel.app),
  // which differs from the canonical domain → the exchange is rejected (same class of bug as
  // Slack's bad_redirect_uri).
  const redirectUri = 'https://your-call-ai.vercel.app/api/asana/oauth-callback';
  if (!clientId || !clientSecret) return redirect(res, { error: 'server_not_configured', state: state || '' });

  let token, refreshToken, expiresAt, user;
  try {
    const r = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });
    const data = await r.json().catch(() => ({}));
    token = data.access_token;
    refreshToken = data.refresh_token || '';
    // Absolute expiry so the client doesn't have to track when it received the token.
    expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    // data.data is the authorizing user: { gid, name, email }.
    user = data.data ? { gid: data.data.gid || '', name: data.data.name || '', email: data.data.email || '' } : null;
    if (!token) return redirect(res, { error: data.error || 'oauth_failed', state: state || '' });
  } catch (err) {
    return redirect(res, { error: `exchange_failed: ${err.message}`, state: state || '' });
  }

  // Store the token under a single-use OTC. Separate try so a store failure is labeled
  // store_failed, not mislabeled as an exchange error.
  try {
    const otc = crypto.randomBytes(24).toString('hex');
    await redisClient().set(`asana:otc:${otc}`, { token, refreshToken, expiresAt, user }, { ex: 120 });
    return redirect(res, { code: otc, state: state || '' });
  } catch (err) {
    return redirect(res, { error: `store_failed: ${err.message}`, state: state || '' });
  }
};
