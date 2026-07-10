// Deepgram batch transcription (§6). Plain fetch, no SDK.
// audio.webm is stereo opus: ch0 = mic (the user), ch1 = system audio (everyone else).
// Cost note: multichannel bills per channel ≈ $0.43 per meeting-hour.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DG_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&multichannel=true&diarize=true&utterances=true&smart_format=true&punctuate=true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deepgramRequest(audioBuf) {
  const key = process.env.DEEPGRAM_API_KEY; // read at call time — Settings apply live
  if (!key) throw new Error('DEEPGRAM_API_KEY not configured');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(DG_URL, {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/webm' },
        body: audioBuf,
      });
      if (res.ok) return await res.json();
      const body = await res.text().catch(() => '');
      if (res.status < 500) throw Object.assign(new Error(`Deepgram ${res.status}: ${body.slice(0, 300)}`), { fatal: true });
      lastErr = new Error(`Deepgram ${res.status}`);
    } catch (err) {
      if (err.fatal) throw err;
      lastErr = err;
    }
    await sleep(2000 * 2 ** attempt);
  }
  throw lastErr || new Error('Deepgram request failed');
}

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

async function transcribeRecording(recordingDir, startedAt) {
  const audioPath = path.join(recordingDir, 'audio.webm');
  const audioBuf = await fsp.readFile(audioPath);
  if (!audioBuf.length) throw new Error('audio.webm is empty');
  const result = await deepgramRequest(audioBuf);
  const utterances = result?.results?.utterances || [];
  const userName = process.env.USER_DISPLAY_NAME || 'You';
  return utterancesToSegments(utterances, Date.parse(startedAt), userName);
}

module.exports = { transcribeRecording, utterancesToSegments };
