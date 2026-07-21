// Deepgram transcription via the Vercel proxy (§6). No key on the client.
// Flow: upload audio.webm straight to Vercel Blob → POST /api/transcribe (synchronous; the proxy
// runs Deepgram and stores the transcript to Blob) → fetch the transcript URL directly from Blob.
// audio.webm is stereo opus: ch0 = mic (the user), ch1 = system audio (everyone else).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { upload } = require('@vercel/blob/client');
const { PROXY_URL, proxyPost } = require('./proxy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map Deepgram utterances → the §4.1 segment shape, both channels interleaved by start time.
function utterancesToSegments(utterances, startedAtMs, userName) {
  const iso = (rel) => new Date(startedAtMs + rel * 1000).toISOString();
  const sorted = [...(utterances || [])].sort((a, b) => a.start - b.start);
  return sorted.map((u) => ({
    // channel 0 = one person at the mic: collapse diarized sub-speakers into USER_DISPLAY_NAME
    speaker: u.channel === 0 ? userName : `Speaker ${(u.speaker ?? 0) + 1}`,
    channel: u.channel,
    diarizedSpeaker: u.channel === 0 ? 0 : (u.speaker ?? 0),
    text: u.transcript || '',
    words: (u.words || []).map((w) => ({
      text: w.punctuated_word || w.word,
      start_timestamp: { absolute: iso(w.start), relative: w.start },
      end_timestamp: { absolute: iso(w.end), relative: w.end },
    })),
  }));
}

// Upload the buffer directly to Vercel Blob (bytes never pass through a function body).
// Deepgram fetches this URL, so it must be public. Wrap the Buffer in a Blob for the SDK.
async function uploadAudio(audioBuf) {
  const body = new Blob([audioBuf], { type: 'audio/webm' });
  const blob = await upload(`audio/${Date.now()}.webm`, body, {
    access: 'public',
    contentType: 'audio/webm',
    handleUploadUrl: `${PROXY_URL}/api/blob-upload`,
  });
  return blob.url;
}

// Transcribe synchronously through the proxy (§6): /api/transcribe blocks while Deepgram runs,
// stores the transcript to Blob, and returns its URL. We fetch that URL DIRECTLY from Blob storage
// (never back through a function) so neither the ~4.5 MB request nor response limit is hit — this
// is what lets long meetings transcribe. The proxy call can take minutes; that's expected.
async function transcribeViaProxy(audioBuf) {
  const url = await uploadAudio(audioBuf);
  // Client-generated id so a lost /api/transcribe response is still recoverable via /result polling.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const submit = await (await proxyPost('/api/transcribe', { url, id })).json();
  if (submit.error) throw new Error(submit.error);

  // Prefer the URL from the submit response; fall back to polling /result if it was lost.
  let resultUrl = submit.resultUrl;
  if (!resultUrl) {
    for (let i = 0; i < 60 && !resultUrl; i++) {
      await sleep(3000);
      const data = await fetch(`${PROXY_URL}/api/transcribe/result?id=${encodeURIComponent(id)}`)
        .then((r) => r.json()).catch(() => ({}));
      if (data.status === 'done') resultUrl = data.resultUrl;
      else if (data.status === 'error') throw new Error(data.error || 'Transcription failed');
    }
    if (!resultUrl) throw new Error('Transcription timed out');
  }

  const result = await fetch(resultUrl).then((r) => r.json());
  // Best-effort: drop the stored transcript now that we have it.
  fetch(`${PROXY_URL}/api/transcribe/result?id=${encodeURIComponent(id)}&ack=1`).catch(() => {});
  return result;
}

async function transcribeRecording(recordingDir, startedAt) {
  const audioPath = path.join(recordingDir, 'audio.webm');
  const audioBuf = await fsp.readFile(audioPath);
  if (!audioBuf.length) throw new Error('audio.webm is empty');
  const result = await transcribeViaProxy(audioBuf);
  const utterances = result?.results?.utterances || [];
  const userName = process.env.USER_DISPLAY_NAME || 'You';
  return utterancesToSegments(utterances, Date.parse(startedAt), userName);
}

module.exports = { transcribeRecording, utterancesToSegments };
