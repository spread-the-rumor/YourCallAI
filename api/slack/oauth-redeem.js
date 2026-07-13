// POST /api/slack/oauth-redeem  { code: <otc> }  -> { ok, token, team }
// The app calls this over HTTPS to exchange the single-use OTC (delivered via the deep
// link) for the actual Slack user token. The OTC is deleted on read — single use.
const { json, readJson, requireAppToken, redisClient } = require('../_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  if (!requireAppToken(req, res)) return;

  const { code } = await readJson(req);
  if (!code) return json(res, 200, { ok: false, error: 'Missing code.' });

  const redis = redisClient();
  const key = `slack:otc:${code}`;
  const entry = await redis.get(key); // @upstash/redis auto-deserializes the stored object
  await redis.del(key); // single use — delete whether or not it existed
  if (!entry || !entry.token) return json(res, 200, { ok: false, error: 'Code expired or invalid.' });

  return json(res, 200, { ok: true, token: entry.token, team: entry.team || '' });
};
