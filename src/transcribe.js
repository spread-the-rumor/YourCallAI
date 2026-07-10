// Deepgram transcription via the Vercel proxy (§6). No key on the client.
// Flow: upload audio.webm straight to Vercel Blob → submit job → poll for the result.
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

// Submit the async Deepgram job and poll until the callback lands. Poll is cheap; no
// Vercel exec-time limit is hit because transcription runs on Deepgram's side.
async function transcribeViaProxy(audioBuf) {
  const url = await uploadAudio(audioBuf);

  const submit = await (await proxyPost('/api/transcribe', { url })).json();
  if (submit.error || !submit.id) throw new Error(submit.error || 'Transcription submit failed');

  // Poll: 3s interval, up to ~10 min for long meetings.
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    const res = await fetch(`${PROXY_URL}/api/transcribe/result?id=${encodeURIComponent(submit.id)}`);
    const data = await res.json().catch(() => ({}));
    if (data.status === 'done') return data.result;
    if (data.status === 'error') throw new Error(data.error || 'Transcription failed');
  }
  throw new Error('Transcription timed out');
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
