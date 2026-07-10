// POST /api/transcribe — submit a Deepgram async job for an already-uploaded Blob URL.
// Returns { id } immediately (<1s, no timeout). Deepgram POSTs results to /api/transcribe/callback.
const { json, readJson, env } = require('./_shared');

const DG_QUERY = 'model=nova-3&multichannel=true&diarize=true&utterances=true&smart_format=true&punctuate=true';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const key = env('DEEPGRAM_API_KEY');
  if (!key) return json(res, 200, { error: 'Deepgram not configured on server.' });

  const { url } = await readJson(req);
  if (!url) return json(res, 200, { error: 'Missing audio url.' });

  // Our own job id → keys the result blob; audioUrl passed through so the callback can delete it.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const cbUrl = `${proto}://${host}/api/transcribe/callback?id=${id}&audio=${encodeURIComponent(url)}`;

  try {
    const r = await fetch(`https://api.deepgram.com/v1/listen?${DG_QUERY}&callback=${encodeURIComponent(cbUrl)}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return json(res, 200, { error: `Deepgram submit failed (${r.status}): ${body.slice(0, 200)}` });
    }
    json(res, 200, { id });
  } catch (err) {
    json(res, 200, { error: `Deepgram request failed: ${err.message}` });
  }
};
