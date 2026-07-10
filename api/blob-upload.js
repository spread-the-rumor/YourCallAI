// POST /api/blob-upload — issues a client-upload token so the app uploads audio.webm
// DIRECTLY to Vercel Blob (bytes never pass through a function → no 4.5MB body limit).
const { handleUpload } = require('@vercel/blob/client');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end('POST only'); return; }
  let body = req.body;
  if (!body || typeof body !== 'object') {
    let raw = ''; for await (const c of req) raw += c; body = raw ? JSON.parse(raw) : {};
  }
  try {
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
