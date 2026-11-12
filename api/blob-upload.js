// POST /api/blob-upload — issues a client-upload token so the app uploads audio.webm
// DIRECTLY to Vercel Blob (bytes never pass through a function → no 4.5MB body limit).
const { handleUpload } = require('@vercel/blob/client');
const { env } = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end('POST only'); return; }
  let body = req.body;
  try {
    if (!body || typeof body !== 'object') {
      let raw = ''; for await (const c of req) raw += c; body = raw ? JSON.parse(raw) : {};
    }
    // Issuing an upload token needs the app token (else anyone can store 500 MB files on this
    // account). The upload-completed callback comes from Vercel Blob itself, signed, without it.
    // TRANSITION (v2.5.1): clients up to v2.5.0 send NO token here, and they keep running until
    // the update is published and installed — rejecting them would stop every one of their
    // meetings from transcribing. So a MISSING token is still accepted for now; a WRONG one is
    // not. Enforce fully (drop the `!== undefined` test) in the release after v2.5.1.
    const expected = env('APP_PROXY_TOKEN');
    const sent = req.headers['x-app-token'];
    if (body.type === 'blob.generate-client-token' && expected && sent !== undefined && sent !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const result = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['audio/webm'],
        maximumSizeInBytes: 500 * 1024 * 1024, // meeting-length opus; generous ceiling
        addRandomSuffix: true,
      }),
      // Deepgram fetches the URL itself; nothing to do on completion here.
      onUploadCompleted: async () => {},
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
