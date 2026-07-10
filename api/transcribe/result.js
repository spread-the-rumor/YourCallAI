// GET /api/transcribe/result?id= — poll for the async transcript.
// { status: 'pending' } until Deepgram's callback lands, then the Deepgram JSON + cleanup.
const { json } = require('../_shared');
const { list, del } = require('@vercel/blob');

module.exports = async (req, res) => {
  const id = req.query.id;
  if (!id) return json(res, 400, { error: 'missing id' });

  try {
    const { blobs } = await list({ prefix: `results/${id}.json` });
    const blob = blobs.find((b) => b.pathname === `results/${id}.json`);
    if (!blob) return json(res, 200, { status: 'pending' });

    const r = await fetch(blob.url);
    const data = await r.json().catch(() => null);
    if (!data) return json(res, 200, { status: 'pending' });

    // Deliver once, then clean up the result blob.
    try { await del(blob.url); } catch { /* ignore */ }
    json(res, 200, { status: 'done', result: data });
  } catch (err) {
    json(res, 200, { status: 'error', error: err.message });
  }
};
