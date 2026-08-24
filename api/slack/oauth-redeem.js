// POST /api/slack/oauth-redeem  { code: <otc> }  -> { ok, token, team }
// The app calls this over HTTPS to exchange the single-use OTC (delivered via the deep
// link) for the actual Slack user token. The OTC is deleted on read — single use.
const { json, readJson, requireAppToken, redisClient } = require('../_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  if (!requireAppToken(req, res)) return;

  const { code } = await readJson(req);
  if (!code) return json(res, 200, { ok: false, error: 'Missing code.' });

  const key = `slack:otc:${code}`;
  let entry;
  try {
    const redis = redisClient();
    entry = await redis.get(key); // @upstash/redis auto-deserializes the stored object
    await redis.del(key); // single use — delete whether or not it existed
  } catch (err) {
    // Store unreachable (archived/paused Upstash DB, network) — report it instead of throwing,
    // which would surface as an opaque FUNCTION_INVOCATION_FAILED 500 with no cause.
    // Distinct from the "not found" case below: that one is normal, this one is an outage.
    return json(res, 200, { ok: false, error: `Token store unavailable: ${err.message}` });
  }
  if (!entry || !entry.token) return json(res, 200, { ok: false, error: 'Code expired or invalid.' });

  return json(res, 200, { ok: true, token: entry.token, team: entry.team || '' });
};
