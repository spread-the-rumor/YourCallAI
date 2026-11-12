// GET /api/transcribe/result?id= — fallback lookup + cleanup for the synchronous transcribe flow.
//
// Not a function of its own: the Hobby plan allows 12 and /api/ai moving off Edge made 13. The
// URL is rewritten to /api/transcribe (vercel.json) and api/transcribe.js routes GET here.
//
// The normal path is: POST /api/transcribe blocks, stores results/<id>.json, and returns its
// Blob URL directly. This route exists for two cases:
//   1. Fallback — if that response was lost, the client polls here to recover the Blob URL.
//   2. Cleanup — after the client fetches the transcript from Blob, it calls ?ack=1 to delete it.
//
// We return the Blob URL (small), NOT the transcript itself: a long meeting's transcript exceeds
// Vercel's ~4.5 MB function *response* limit, so the client must fetch it straight from Blob.
const { json, requireAppToken } = require('./_shared');
const { list, del } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (!requireAppToken(req, res)) return; // ?ack=1 deletes results
  const id = req.query.id;
  if (!id) return json(res, 400, { error: 'missing id' });

  try {
    const { blobs } = await list({ prefix: `results/${id}.json` });
    const blob = blobs.find((b) => b.pathname === `results/${id}.json`);
    if (!blob) return json(res, 200, { status: 'pending' });

    // Cleanup ack: the client has the transcript, so drop the stored copy.
    if (req.query.ack) {
      try { await del(blob.url); } catch { /* ignore */ }
      return json(res, 200, { status: 'deleted' });
    }

    return json(res, 200, { status: 'done', resultUrl: blob.url });
  } catch (err) {
    return json(res, 200, { status: 'error', error: err.message });
  }
};
