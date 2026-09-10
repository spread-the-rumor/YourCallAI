// Recording media resolution (§5). The ONE place that knows what a recording's video file is
// called, because that answer is no longer a constant.
//
// Why this exists: `video.webm` used to be hardcoded in seven places (main.js x5, sync.js,
// scripts/recover-meeting.js). Once the pipeline started producing an MP4, every one of them
// was a latent bug — most dangerously sync.js's rehydrate(), which gates videoUrl on the file
// existing and would otherwise null it on every launch, silently hiding the play/download
// buttons for every synced meeting.
//
// Two-name scheme, and the reason for it:
//   capture.{mp4,mkv,webm}  what MediaRecorder wrote, live-muxed and NOT seekable
//   video.mp4               the normalized, progressive +faststart output
// The presence of a `capture.*` file IS the "needs normalizing" flag. Keying off the filesystem
// instead of meta.status is deliberate: runPipeline writes status:'complete' before its final
// upsert, and recoverAndRequeue only requeues recorded/transcribing/failed — so anything keyed
// off status and running late would be unresumable forever after a quit.
//
// MUST NOT require('electron') at module scope: scripts/recover-meeting.js loads this as plain
// Node with the app closed. Callers pass directories in; nothing here derives them.
const fs = require('fs');
const path = require('path');

const NORMALIZED_NAME = 'video.mp4';
const PART_NAME = 'video.mp4.part';
// Best-first. capture.mp4 is fragmented MP4 (also unseekable — fMP4 written live has no
// top-level index), but remuxing it to progressive is a lossless stream copy taking seconds.
const CAPTURE_NAMES = ['capture.mp4', 'capture.mkv', 'capture.webm'];
// Written by every release before this change. Still played and downloaded exactly as before;
// deliberately NOT auto-converted (see normalize.sweep) so an update can't kick off hours of
// unasked-for transcoding across a user's whole library.
const LEGACY_NAMES = ['video.webm'];

const AUDIO_NAME = 'audio.webm'; // recB / Deepgram. Never renamed — src/transcribe.js reads it.

// Resolution order. Normalized first so it wins the moment it lands; legacy last so a
// half-converted folder still resolves to something playable.
const PROBE_ORDER = [NORMALIZED_NAME, ...CAPTURE_NAMES, ...LEGACY_NAMES];

function captureNameFor(mimeType) {
  const m = String(mimeType || '');
  if (/^video\/mp4/i.test(m)) return 'capture.mp4';
  if (/matroska/i.test(m)) return 'capture.mkv';
  return 'capture.webm';
}

// A zero-byte file is NOT media. It happens when the recorder errors immediately after
// 'capture-format' opened the write stream: the empty capture file would otherwise resolve as a
// playable URL (a dead ▶ link) and make needsNormalize report 'normalize', burning all three
// conversion attempts on nothing.
function hasMedia(p) {
  try { const st = fs.statSync(p); return st.isFile() && st.size > 0; } catch { return false; }
}

// Sync on purpose: sync.js's rehydrate() is synchronous and is called from the pull path.
// Three to five stats is microseconds.
function resolveMedia(dir) {
  if (!dir) return null;
  for (const name of PROBE_ORDER) {
    const p = path.join(dir, name);
    if (hasMedia(p)) {
      return { name, path: p, ext: path.extname(name), normalized: name === NORMALIZED_NAME };
    }
  }
  return null;
}

function mediaUrl(recordingId, dir, port) {
  const media = resolveMedia(dir);
  if (!media || !recordingId) return null;
  const p = port || require('./server').PORT;
  return `http://localhost:${p}/recordings/${recordingId}/${media.name}`;
}

// Every video artifact we might have written, for retention. Retention previously rm'd the two
// literal names, so an mp4 would have survived AUTO_DELETE_DAYS forever — a disk bug and, given
// what these files contain, a privacy one.
function allMediaNames() {
  return [NORMALIZED_NAME, PART_NAME, ...CAPTURE_NAMES, ...LEGACY_NAMES];
}

// The whole normalize state machine, read off the filesystem.
function needsNormalize(dir) {
  const has = (n) => hasMedia(path.join(dir, n));
  const src = CAPTURE_NAMES.find(has) || null;
  // A .part is never salvageable: +faststart rewrites the file at the end to move `moov` to the
  // front, so a partial one has no usable index by construction.
  // existsSync, not hasMedia: a 0-byte .part still needs deleting.
  const stale = fs.existsSync(path.join(dir, PART_NAME)) ? path.join(dir, PART_NAME) : null;
  if (has(NORMALIZED_NAME)) {
    // Crashed between rename and unlink, or a deliberately-kept partial source.
    return { action: src || stale ? 'cleanup' : 'none', src: src && path.join(dir, src), stale };
  }
  if (src) return { action: 'normalize', src: path.join(dir, src), stale };
  return { action: 'none', src: null, stale };
}

const BAD_FILENAME_CHARS = /[\\/:*?"<>|·]/g;
const FILTERS = {
  '.mp4': { name: 'MP4 video', extensions: ['mp4'] },
  '.mkv': { name: 'Matroska video', extensions: ['mkv'] },
  '.webm': { name: 'WebM video', extensions: ['webm'] },
};

// Derived from the file that actually exists. Offering a .mp4 filter over a .webm file produces
// something Windows refuses to open, which is worse than the honest extension.
function downloadName(title, media) {
  const base = String(title || 'recording').replace(BAD_FILENAME_CHARS, '-');
  return `${base}${(media && media.ext) || '.webm'}`;
}

function downloadFilter(media) {
  return FILTERS[(media && media.ext) || '.webm'] || FILTERS['.webm'];
}

module.exports = {
  NORMALIZED_NAME, PART_NAME, CAPTURE_NAMES, LEGACY_NAMES, AUDIO_NAME,
  captureNameFor, resolveMedia, mediaUrl, allMediaNames, needsNormalize,
  downloadName, downloadFilter,
};
