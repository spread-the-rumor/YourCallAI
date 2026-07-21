// POST /api/transcribe — transcribe an already-uploaded Blob URL via Deepgram.
//
// SYNCHRONOUS by design (§6). We call Deepgram and read the (large) transcript as the
// fetch RESPONSE body, then store it to Blob ourselves. This deliberately AVOIDS Deepgram's
// async callback: the callback POSTed the full multichannel/word-level transcript INTO this
// function, and for long meetings that body exceeds Vercel's ~4.5 MB request-body limit, so
// results/<id>.json was never written and the client timed out. An outbound fetch response
// has no such inbound cap. We return the Blob URL (small) — the client fetches the transcript
// directly from Blob storage, so the ~4.5 MB *response* limit is never hit either.
//
// Requires a raised maxDuration (see vercel.json) since this blocks for the whole
// transcription (~30x realtime on Deepgram nova-3; ~300s covers well over 2 hours of audio).
const { json, readJson, env } = require('./_shared');
const { put, del } = require('@vercel/blob');

const DG_QUERY = 'model=nova-3&multichannel=true&diarize=true&utterances=true&smart_format=true&punctuate=true';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const key = env('DEEPGRAM_API_KEY');
  if (!key) return json(res, 200, { error: 'Deepgram not configured on server.' });

  const { url, id: clientId } = await readJson(req);
  if (!url) return json(res, 200, { error: 'Missing audio url.' });
  // Client supplies the id so it can poll /result as a fallback if this response is lost.
  const id = clientId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const dg = await fetch(`https://api.deepgram.com/v1/listen?${DG_QUERY}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const raw = await dg.text();
    if (!dg.ok) {
      return json(res, 200, { id, error: `Deepgram failed (${dg.status}): ${raw.slice(0, 200)}` });
    }

    // Persist the transcript so the client can fetch it directly from Blob (bypasses the
    // function response-size limit) and so a lost response is still recoverable via /result.
    let resultUrl;
    try {
      const blob = await put(`results/${id}.json`, raw || '{}', {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      resultUrl = blob.url;
    } catch (err) {
      return json(res, 200, { id, error: `Storing transcript failed: ${err.message}` });
    }

    // Source audio is transcribed and no longer needed. Best-effort; a re-run re-uploads it.
    if (url) { try { await del(url); } catch { /* ignore */ } }

    return json(res, 200, { id, status: 'done', resultUrl });
  } catch (err) {
    return json(res, 200, { id, error: `Deepgram request failed: ${err.message}` });
  }
};
