// One-off recovery for an orphaned recording whose in-app pipeline never completed
// (e.g. rec_1784649728818_4ve1 — the 94-min Teams meeting lost to the callback-body bug).
//
// Transcribes the LOCAL audio.webm directly against Deepgram (using the dev key in .env, so no
// Vercel deploy is needed), resolves speaker names + summary via the app's own modules, writes
// transcript.json into the recording folder, and injects the meeting into meetings.json (backed
// up first). Run with the app CLOSED.
//
//   node scripts/recover-meeting.js <recordingId>
//
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const { utterancesToSegments } = require('../src/transcribe');
const { alignSpeakers } = require('../src/align');
const { inferSpeakerNames } = require('../src/ai/inferSpeakerNames');
const { summarizeTranscript } = require('../src/ai/summarize');
const { meetingDate } = require('../src/transcriptUtils');

const SERVER_PORT = 3100; // matches src/server.js
const DG_QUERY = 'model=nova-3&multichannel=true&diarize=true&utterances=true&smart_format=true&punctuate=true';

// Minimal .env loader (mirrors settingsStore.loadEnvFile) → process.env for the AI proxy calls.
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

async function deepgramTranscribe(audioBuf) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY missing in .env');
  const res = await fetch(`https://api.deepgram.com/v1/listen?${DG_QUERY}`, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/webm' },
    body: audioBuf,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Deepgram failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function userDataDir() {
  // Windows Electron userData for productName "Your Call AI".
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Your Call AI');
}

function buildTitle(dateIso) {
  const d = new Date(dateIso);
  return `Meeting · ${d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })}`;
}

async function main() {
  const recordingId = process.argv[2];
  if (!recordingId) { console.error('usage: node scripts/recover-meeting.js <recordingId>'); process.exit(1); }

  loadEnv();
  const userData = userDataDir();
  const dir = path.join(userData, 'recordings', recordingId);
  const metaPath = path.join(dir, 'meta.json');
  const audioPath = path.join(dir, 'audio.webm');

  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  const audioBuf = await fsp.readFile(audioPath);
  console.log(`[recover] ${recordingId} — audio ${(audioBuf.length / 1e6).toFixed(1)} MB, "${meta.title || '(untitled)'}"`);
  if (!audioBuf.length) throw new Error('audio.webm is empty');

  console.log('[recover] transcribing via Deepgram (this can take a couple of minutes)…');
  const result = await deepgramTranscribe(audioBuf);
  const utterances = result?.results?.utterances || [];
  const userName = process.env.USER_DISPLAY_NAME || 'You';
  const transcript = utterancesToSegments(utterances, Date.parse(meta.startedAt), userName);
  console.log(`[recover] ${transcript.length} utterance segments`);
  if (!transcript.length) throw new Error('Deepgram returned no utterances');

  // Speaker names: alignment (native agent, likely empty here) + AI inference.
  const { roster } = alignSpeakers(transcript, path.join(dir, 'speakers.jsonl'));
  const inferred = await inferSpeakerNames(transcript, roster);
  for (const seg of transcript) if (inferred[seg.speaker]) seg.speaker = inferred[seg.speaker];
  await fsp.writeFile(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 2));
  console.log('[recover] wrote transcript.json');

  console.log('[recover] generating summary…');
  const summary = await summarizeTranscript(transcript);
  console.log('[recover] summary generated');

  const date = meetingDate(transcript) || meta.startedAt;
  const meeting = {
    id: recordingId,
    recordingId,
    title: meta.title || buildTitle(date),
    date,
    content: summary,
    summary,
    transcript,
    videoUrl: `http://localhost:${SERVER_PORT}/recordings/${recordingId}/video.webm`,
    transcriptUrl: `http://localhost:${SERVER_PORT}/recordings/${recordingId}/transcript.json`,
    speakerMap: {},
    chat: [],
  };

  // Inject into meetings.json (back up first).
  const mPath = path.join(userData, 'meetings.json');
  const backup = path.join(userData, `meetings.backup-${meta.endedAt ? meta.endedAt.replace(/[:.]/g, '-') : 'recover'}.json`);
  await fsp.copyFile(mPath, backup);
  console.log(`[recover] backed up meetings.json → ${path.basename(backup)}`);
  const data = JSON.parse(await fsp.readFile(mPath, 'utf8'));
  const now = new Date().toISOString();
  const i = data.meetings.findIndex((m) => m.recordingId === recordingId || m.id === recordingId);
  if (i >= 0) { data.meetings[i] = { ...data.meetings[i], ...meeting, updatedAt: now }; console.log('[recover] replaced existing entry'); }
  else { data.meetings.push({ ...meeting, createdAt: now, updatedAt: now }); console.log('[recover] added new entry'); }
  await fsp.writeFile(mPath, JSON.stringify(data, null, 2));

  await fsp.writeFile(metaPath, JSON.stringify({ ...meta, status: 'complete' }, null, 2));
  console.log('[recover] done — meeting will appear in the app on next launch.');
  console.log('\n--- SUMMARY PREVIEW ---\n' + summary.slice(0, 800));
}

main().catch((e) => { console.error('[recover] FAILED:', e.message); process.exit(1); });
