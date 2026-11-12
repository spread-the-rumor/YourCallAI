// Native system-audio capture, JS side (§5). Windows only; every function degrades to "not
// available" so the recording behaves exactly as before when the agent binary is missing.
//
// Chromium's loopback (the ch1 of audio.webm) can only ever follow the Windows DEFAULT output, so
// a display connect, a headset arriving or a meeting app set to a specific speaker silently records
// the wrong device. The agent's --capture mode records EVERY output device onto one wall-clock
// timeline (system.pcm, see agents/windows/AudioCapture.cs). At transcription time this module
// decides, from measured audio activity, whether that native track or Chromium's carries more of
// the meeting, and if it is the native one, builds audio.native.webm: ch0 = the mic exactly as
// recorded, ch1 = the native track aligned to the recorder's own start time.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
const ACTIVE_RMS = 0.003;     // per-second RMS above which a second counts as "has sound"
const NATIVE_SHARE = 0.9;     // native wins unless Chromium heard clearly more of the meeting
const OUT_NAME = 'audio.native.webm';

// ---------- pure helpers (unit-tested in test/selfcheck.js) ----------

// Per-second activity of 16-bit little-endian mono PCM: one boolean per whole second.
function activityFromPcm(buf, sampleRate = SAMPLE_RATE, threshold = ACTIVE_RMS) {
  const n = Math.floor(buf.length / 2);
  const out = [];
  for (let s = 0; (s + 1) * sampleRate <= n; s++) {
    let q = 0;
    for (let i = s * sampleRate; i < (s + 1) * sampleRate; i++) {
      const v = buf.readInt16LE(i * 2) / 32768;
      q += v * v;
    }
    out.push(Math.sqrt(q / sampleRate) > threshold);
  }
  return out;
}

const countActive = (act) => (act || []).filter(Boolean).length;

// Which ch1 to transcribe. `native`/`chrome` are per-second activity arrays (or null).
function chooseSystemTrack(native, chrome) {
  if (!native || !native.length) return { use: 'chrome', reason: 'no-native-capture' };
  const n = countActive(native);
  if (n === 0) return { use: 'chrome', reason: 'native-silent' };
  if (!chrome || !chrome.length) return { use: 'native', reason: 'no-chrome-track', nativeActive: n };
  const c = countActive(chrome);
  if (n >= c * NATIVE_SHARE) return { use: 'native', reason: n > c ? 'native-heard-more' : 'equivalent', nativeActive: n, chromeActive: c };
  return { use: 'chrome', reason: 'chrome-heard-more', nativeActive: n, chromeActive: c };
}

// Seconds of sound the native track carried during stretches where Chromium's loopback heard
// NOTHING. `levels` are the recorder's 15 s diagnostics ({ ts, sysActive, window }); nativeAct is
// per-second activity of system.pcm starting at nativeStartedAtMs. A window counts as "Chromium
// deaf" when it logged zero active seconds; only then are native seconds counted, so a healthy
// meeting where both heard the same things scores ~0 and the original file is used unchanged.
function secondsMissedByChrome(levels, nativeAct, nativeStartedAtMs) {
  let missed = 0;
  for (const l of levels || []) {
    if (typeof l.sysActive !== 'number' || l.sysActive > 0) continue;
    const win = l.window || 15;
    const end = Math.floor((l.ts - nativeStartedAtMs) / 1000);
    for (let s = Math.max(0, end - win); s < end && s < nativeAct.length; s++) if (nativeAct[s]) missed++;
  }
  return missed;
}
// Below this many missed seconds the difference is noise (a notification sound, an edge of a
// window), not a lost stretch of meeting, and is not worth re-encoding the recording for.
const MISSED_SECONDS_TO_SWITCH = 20;

// Offset (seconds) of the recorder's start inside system.pcm. Positive = the native capture
// started earlier (the usual case: it is spawned before the recorder window exists).
function alignmentOffset(nativeStartedAtMs, recorderStartedAtMs) {
  if (!Number.isFinite(nativeStartedAtMs) || !Number.isFinite(recorderStartedAtMs)) return null;
  return (recorderStartedAtMs - nativeStartedAtMs) / 1000;
}

// ffmpeg filter for the remix: ch0 = mic (left channel of audio.webm), ch1 = aligned native track.
// apad makes the native input endless and -shortest ends the output where the mic ends, so the
// result has exactly the recorder's duration. `join` with an explicit stereo layout, not
// `amerge`: amerge emits two channels with NO layout, which libopus refuses to open.
// padMic: the recorder died early, so audio.webm is SHORTER than the meeting; pad the mic with
// silence and let the caller bound the length with -t instead of -shortest.
function remixFilter(offsetSec, { padMic = false } = {}) {
  const align = offsetSec >= 0
    ? `atrim=start=${offsetSec.toFixed(3)},asetpts=PTS-STARTPTS`
    : `adelay=${Math.round(-offsetSec * 1000)}:all=1`;
  return `[0:a]pan=mono|c0=c0,aresample=${SAMPLE_RATE}${padMic ? ',apad' : ''}[mic];[1:a]${align},apad[sys];[mic][sys]join=inputs=2:channel_layout=stereo[out]`;
}

// ---------- capture lifecycle ----------

// Start native capture into `dir`. Returns { stop(): Promise } or null when unavailable.
function start(dir, onEvent) {
  if (process.platform !== 'win32' || process.env.YCAI_NATIVE_CAPTURE === '0') return null;
  try {
    const { startAgentMode } = require('./agents');
    return startAgentMode(['--capture', dir], (evt) => onEvent && onEvent(evt), { maxRestarts: 0, graceMs: 4000 });
  } catch (err) {
    if (onEvent) onEvent({ type: 'native-capture', state: 'unavailable', error: err.message });
    return null;
  }
}

// ---------- upload preparation ----------

function decodeChannelActivity(ffmpeg, src, channel) {
  // Decode one channel of audio.webm to 16 kHz mono PCM and measure it, streaming.
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', src, '-af', `pan=mono|c0=c${channel}`,
      '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'];
    let child;
    try { child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { return resolve(null); }
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? activityFromPcm(Buffer.concat(chunks)) : null));
  });
}

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').pop()}`))));
  });
}

// Reads what the recorder logged: when its audio started, and its 15 s level windows.
async function readCaptureLog(dir) {
  const out = { recorderStartedAt: null, levels: [] };
  let raw = '';
  try { raw = await fsp.readFile(path.join(dir, 'capture.jsonl'), 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.includes('audio-recorder-started') && !line.includes('"levels"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'audio-recorder-started' && out.recorderStartedAt == null) out.recorderStartedAt = e.at || e.ts;
      else if (e.type === 'levels') out.levels.push(e);
    } catch { /* partial line */ }
  }
  return out;
}

// Returns the path of the audio file to transcribe when the native track should be used, or null
// to transcribe audio.webm as before. log(step, extra) receives the decision for pipeline.jsonl.
async function prepareUpload(dir, log = () => {}) {
  const pcmPath = path.join(dir, 'system.pcm');
  const metaPath = path.join(dir, 'system.json');
  const webm = path.join(dir, 'audio.webm');
  const out = path.join(dir, OUT_NAME);
  // After a successful transcription the pipeline deletes system.pcm (~115 MB/hour). A Retry then
  // reuses the remix built from it, if the native track was the one chosen.
  if (!fs.existsSync(pcmPath)) return fs.existsSync(out) ? out : null;
  if (!fs.existsSync(metaPath) || !fs.existsSync(webm)) return null;

  // Retry transcription: reuse a remix built from these exact inputs.
  try {
    const o = fs.statSync(out);
    if (o.mtimeMs >= fs.statSync(pcmPath).mtimeMs && o.mtimeMs >= fs.statSync(webm).mtimeMs) return out;
  } catch { /* not built yet */ }

  const { ffmpegPath } = require('./ffmpeg');
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) { log('native-audio', { use: 'chrome', reason: 'no-ffmpeg' }); return null; }

  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  const capLog = await readCaptureLog(dir);
  const offset = alignmentOffset(meta.startedAtMs, capLog.recorderStartedAt);
  if (offset == null) { log('native-audio', { use: 'chrome', reason: 'no-alignment' }); return null; }

  const nativeAct = activityFromPcm(await fsp.readFile(pcmPath));
  let recMeta = {};
  try { recMeta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch { /* none */ }
  // The recorder ended without the user stopping it (crash, capture death): audio.webm stops
  // there, but native capture kept recording until the recording was finalized. Use it for the
  // whole length — found by the crash stress test, which otherwise kept 13 of 37 seconds.
  const endedEarly = recMeta.stopReason === 'unexpected';
  const nativeTailSec = Math.max(0, nativeAct.length - Math.max(0, offset));
  let decision;
  if (endedEarly && countActive(nativeAct) > 0) {
    decision = { use: 'native', reason: 'recorder-ended-early', lengthSec: nativeTailSec };
  } else if (capLog.levels.some((l) => typeof l.sysActive === 'number')) {
    // Fast path: the recorder logged where it heard sound, so no decode is needed.
    const missed = secondsMissedByChrome(capLog.levels, nativeAct, meta.startedAtMs);
    decision = countActive(nativeAct) === 0 ? { use: 'chrome', reason: 'native-silent' }
      : missed >= MISSED_SECONDS_TO_SWITCH ? { use: 'native', reason: 'chrome-missed-sound', missedSec: missed }
        : { use: 'chrome', reason: 'equivalent', missedSec: missed };
  } else {
    // Recordings without per-window activity: decode Chromium's channel and compare totals.
    const skip = Math.max(0, Math.floor(offset)); // drop native seconds before the recorder started
    decision = chooseSystemTrack(nativeAct.slice(skip), await decodeChannelActivity(ffmpeg, webm, 1));
    if (decision.reason === 'equivalent') decision = { ...decision, use: 'chrome' };
  }
  log('native-audio', { ...decision, offsetSec: Number(offset.toFixed(3)) });
  if (decision.use !== 'native') return null;

  // 16 kHz is all speech recognition uses; compression_level 3 encodes ~3.5x faster than the
  // default at a size difference Deepgram does not care about (measured: 4.3 s vs 15.8 s for a
  // 7-minute meeting).
  const part = `${out}.part`;
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', webm,
    '-f', 's16le', '-ar', String(meta.sampleRate || SAMPLE_RATE), '-ac', '1', '-i', pcmPath,
    '-filter_complex', remixFilter(offset, { padMic: endedEarly }),
    '-map', '[out]',
    ...(endedEarly ? ['-t', String(Math.max(1, Math.ceil(nativeTailSec)))] : ['-shortest']),
    '-c:a', 'libopus', '-b:a', '32k', '-compression_level', '3', '-f', 'webm', part,
  ]);
  await fsp.rename(part, out);
  return out;
}

module.exports = {
  start, prepareUpload,
  activityFromPcm, chooseSystemTrack, alignmentOffset, remixFilter, secondsMissedByChrome, OUT_NAME,
};
