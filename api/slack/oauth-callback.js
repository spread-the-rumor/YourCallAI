// GET /api/slack/oauth-callback?code=<slack_code>&state=<state>
// Slack redirects here after the user authorizes. We exchange the code for the user's
// xoxp- token server-side (client_secret never leaves Vercel), stash it in KV under a
// single-use one-time code (120s TTL), and 302 back to the app via the custom protocol.
// The actual token never rides the deep link — only the OTC does, redeemed over HTTPS.
const { env, redisClient } = require('../_shared');
const crypto = require('crypto');

const DEEP_LINK = 'yourcallai://slack';

function redirect(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.writeHead(302, { Location: `${DEEP_LINK}?${qs}` });
  res.end();
}

module.exports = async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) return redirect(res, { error, state: state || '' });
  if (!code) return redirect(res, { error: 'missing_code', state: state || '' });

  const clientId = env('SLACK_CLIENT_ID');
  const clientSecret = env('SLACK_CLIENT_SECRET');
  // Must EXACTLY match the authorize-step redirect_uri (client uses PROXY_URL) and the Slack
  // app config. Do NOT use VERCEL_URL — it's the per-deployment host (…-<hash>.vercel.app),
  // which differs from the canonical domain → Slack rejects the exchange with bad_redirect_uri.
  const redirectUri = 'https://your-call-ai.vercel.app/api/slack/oauth-callback';
  if (!clientId || !clientSecret) return redirect(res, { error: 'server_not_configured', state: state || '' });

  let token, team;
  try {
    const r = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    const data = await r.json();
    // User token lives under authed_user (we requested user_scope, not bot scopes).
    token = data.ok && data.authed_user && data.authed_user.access_token;
    team = data.team?.name || '';
    if (!token) return redirect(res, { error: data.error || 'oauth_failed', state: state || '' });
  } catch (err) {
    return redirect(res, { error: `exchange_failed: ${err.message}`, state: state || '' });
  }

  // Store the token under a single-use OTC. Separate try so a store failure is labeled
  // store_failed, not mislabeled as an exchange error.
  try {
    const otc = crypto.randomBytes(24).toString('hex');
    await redisClient().set(`slack:otc:${otc}`, { token, team }, { ex: 120 });
    return redirect(res, { code: otc, state: state || '' });
  } catch (err) {
    return redirect(res, { error: `store_failed: ${err.message}`, state: state || '' });
  }
};
