// POST /api/transcribe/callback?id=&audio= — Deepgram posts the finished transcript here.
// Store it to Blob keyed by id (Hobby has no KV); delete the source audio Blob.
const { put, del } = require('@vercel/blob');

module.exports = async (req, res) => {
  const { id, audio } = req.query;
  if (!id) { res.status(400).end('missing id'); return; }

  let raw = '';
  for await (const chunk of req) raw += chunk;

  try {
    // Store the raw Deepgram JSON for the poller to fetch.
    await put(`results/${id}.json`, raw || '{}', {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (err) {
    console.error('[transcribe/callback] store failed:', err.message);
  }

  // Best-effort delete the source audio — it's transcribed, we don't keep it.
  if (audio) { try { await del(audio); } catch { /* ignore */ } }

  res.status(200).end('ok');
};
