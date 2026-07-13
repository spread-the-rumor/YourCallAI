// POST /api/slack/oauth-redeem  { code: <otc> }  -> { ok, token, team }
// The app calls this over HTTPS to exchange the single-use OTC (delivered via the deep
// link) for the actual Slack user token. The OTC is deleted on read — single use.
const { Redis } = require('@upstash/redis');
const { json, readJson, requireAppToken, env } = require('../_shared');

const redis = new Redis({
  url: env('UPSTASH_REDIS_REST_URL') || env('KV_REST_API_URL'),
  token: env('UPSTASH_REDIS_REST_TOKEN') || env('KV_REST_API_TOKEN'),
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  if (!requireAppToken(req, res)) return;

  const { code } = await readJson(req);
  if (!code) return json(res, 200, { ok: false, error: 'Missing code.' });

  const key = `slack:otc:${code}`;
  const entry = await redis.get(key); // @upstash/redis auto-deserializes the stored object
  await redis.del(key); // single use — delete whether or not it existed
  if (!entry || !entry.token) return json(res, 200, { ok: false, error: 'Code expired or invalid.' });

  return json(res, 200, { ok: true, token: entry.token, team: entry.team || '' });
};
