// Video normalization queue (§5): turns whatever MediaRecorder wrote into a progressive,
// +faststart video.mp4 that actually seeks.
//
// This runs OUTSIDE runPipeline's status machine, deliberately. runPipeline writes
// meta.status:'complete' before its final upsert, and recoverAndRequeue only requeues
// recorded/transcribing/failed — so a long step keyed off status and finishing late would be
// unresumable forever once the app is quit (and quit is guaranteed: before-quit waits a hard 12s
// then calls app.quit()). Worse, re-running runPipeline to retry a file operation would re-bill
// Deepgram and clobber cached actionItems.
//
// So the state machine is the FILESYSTEM (see media.needsNormalize): the presence of a capture.*
// file is the "needs normalizing" flag, and sweep() re-derives everything at launch. Meta fields
// are diagnostics and loop-breaking only.
//
// Invariants:
//   - Never throws. A failure keeps the capture file and leaves the recording playable as-is.
//   - Never deletes the source before the destination is renamed into place.
//   - Never runs while a recording is live: a saturated CPU drops capture frames and can glitch
//     the WASAPI loopback, which would trade a cosmetic problem for a corrupted recording.
const fsp = require('fs/promises');
const path = require('path');

const media = require('./media');
const ffmpeg = require('./ffmpeg');

const MAX_ATTEMPTS = 3;        // an undecodable source must not be retried on every launch forever
const MAX_ENCODERS_PER_JOB = 2; // so a 90-minute file cannot burn hours failing three encoders
// Output shorter than this fraction of the WALL-CLOCK span counts as partial (keep the source).
// Calibrated against the real library, not guessed: content/wall runs 86.5%-100% on complete
// recordings (median 99.6%) because capture starts slightly after startedAt and getDisplayMedia
// suppresses unchanged frames, while a genuinely truncated capture measured 46%. 0.95 flagged a
// quarter of healthy recordings as partial and never reclaimed their disk.
const ACCEPT_RATIO = 0.75;
const DISK_HEADROOM = 1.3;     // source and output coexist until the rename

// ffmpeg exits non-zero for two very different reasons, and conflating them is expensive: a
// broken SOURCE is not evidence that the encoder is broken. Without this distinction, one
// unreadable recording would blacklist a perfectly good hardware encoder and invalidate the
// cached choice, so every later conversion in the session silently fell back to a slower one.
const INPUT_ERROR = /Error opening input|Invalid data found|No such file or directory|moov atom not found|End of file/i;

let cfg = null;
const queue = [];
const queued = new Set();
// id -> [resolve]. Lets ensureMp4() await a job that the queue owns, without giving the caller
// its own conversion code path.
const waiters = new Map();
let current = null; // { id, child, killed }
let draining = false;
// Survives within a process; persisted via cfg.saveEncoder.
let encoderCache = null;

// NOT read at module load: main.js requires this file at startup, but settingsStore.applyToEnv()
// only runs later inside app.whenReady() — and it DELETES unset KEYS, so at require() time
// process.env.VIDEO_ENCODER is always undefined. Reading it here, from configure(), is what
// actually makes the "validate the encoder once per install" cache work.
function configure(next) {
  cfg = { ...(cfg || {}), ...next };
  if (!encoderCache && process.env.VIDEO_ENCODER) encoderCache = process.env.VIDEO_ENCODER;
}
function isBusy() { return !!current; }
function currentId() { return current ? current.id : null; }

function log(...a) { console.log('[normalize]', ...a); }

// ---------- queue ----------

function enqueue(recordingId, { silent = false, priority = false } = {}) {
  if (!cfg || !recordingId) return;
  if (current && current.id === recordingId) return; // already running
  if (queued.has(recordingId)) {
    // Already waiting. A user-initiated request promotes it to the front and makes it visible.
    const i = queue.findIndex((j) => j.id === recordingId);
    if (priority && i > 0) {
      const [j] = queue.splice(i, 1);
      j.silent = j.silent && silent;
      queue.unshift(j);
    } else if (i >= 0 && !silent) {
      queue[i].silent = false;
    }
    return;
  }
  queued.add(recordingId);
  queue[priority ? 'unshift' : 'push']({ id: recordingId, silent });
  drain();
}

function waitFor(id) {
  return new Promise((resolve) => {
    if (!waiters.has(id)) waiters.set(id, []);
    waiters.get(id).push(resolve);
  });
}

function settleWaiters(id) {
  const ws = waiters.get(id);
  if (!ws) return;
  waiters.delete(id);
  for (const r of ws) r();
}

async function drain() {
  if (draining || current) return;
  draining = true;
  try {
    while (queue.length) {
      // Recording takes absolute priority. Leave the item queued and stop draining; stopRecording
      // calls resume() to pick up where we left off.
      if (cfg.isRecording && cfg.isRecording()) return;
      const job = queue.shift();
      queued.delete(job.id);
      current = { id: job.id, child: null, killed: false };
      try { await runJob(job); }
      catch (err) { log(job.id, 'unexpected failure:', err && err.message); }
      finally {
        // A killed job is always redoable from an untouched source, so put it back in line rather
        // than dropping it. This cannot be done from killCurrent(): `current` is still set there,
        // so enqueue() would hit its own "already running" guard and silently discard the job —
        // which is exactly how a preempted conversion, and every job displaced by a recording,
        // used to vanish until the next launch's sweep.
        const requeue = !!(current && current.requeue);
        current = null;
        if (requeue) {
          enqueue(job.id, { silent: job.silent });
        } else {
          settleWaiters(job.id); // a requeued job settles its waiters when it really finishes
          if (!job.silent && cfg.onJobDone) cfg.onJobDone();
        }
      }
    }
  } finally {
    draining = false;
  }
}

function resume() { drain(); }

// Kills the running job. The source file is untouched, so the work is always redoable — which is
// why quitting mid-transcode is safe and why we never block quit on it.
//
// requeue defaults to true: a job we interrupted should be retried. On quit it must be false, or
// the requeue would start a fresh ffmpeg while the app is shutting down.
function killCurrent(reason, { requeue = true } = {}) {
  if (!current) return false;
  current.killed = true;
  current.requeue = requeue;
  log(current.id, `killed (${reason})`);
  if (current.child) {
    try { current.child.kill(); } catch { /* already gone */ }
  }
  return true;
}

// Recording takes absolute priority. The interrupted job is requeued and picked up by resume().
function pauseForRecording() {
  killCurrent('recording-started');
}

function isAvailable() { return !!ffmpeg.ffmpegPath(); }

// Convert-on-demand. Everything else here is background work; this is the one path a user is
// actively waiting on, so it preempts and jumps the queue.
//
// This exists because gating conversion to new recordings made the whole feature invisible: an
// established library is 100% legacy files, so every Download and Open still handed back WebM.
async function ensureMp4(recordingId) {
  if (!cfg) return { ok: false, error: 'Not ready yet — try again in a moment.' };
  const dir = path.join(cfg.recordingsDir, recordingId);

  const found = media.resolveMedia(dir);
  if (!found) return { ok: false, error: 'Recording file not found (may have been auto-deleted).' };
  if (found.normalized) return { ok: true, media: found }; // the common case: one stat, no work
  if (!isAvailable()) return { ok: false, error: 'Video conversion is unavailable in this install.' };
  // Converting while capturing would drop frames from the live recording — the one thing that is
  // unrecoverable. Refuse rather than queue, so the user gets an answer instead of a hang.
  if (cfg.isRecording && cfg.isRecording()) {
    return { ok: false, error: 'Cannot convert while recording. Try again once the recording stops.' };
  }

  // A legacy video.webm is deliberately invisible to needsNormalize()/sweep(). Renaming it makes
  // it an ordinary job, so it goes through the same acceptance check, .part -> fsync -> rename
  // ordering and crash recovery as a fresh recording. No second conversion path.
  if (media.LEGACY_NAMES.includes(found.name)) {
    try {
      await fsp.rename(found.path, path.join(dir, 'capture.webm'));
      await writeState(dir, { attempts: 0, legacy: true, lastError: null });
    } catch (err) {
      return { ok: false, error: `Could not prepare the recording: ${err.message}` };
    }
  }

  // Preempt background work: it is fully redoable from an untouched source, so putting it back in
  // line costs nothing and the person clicking a button should not wait behind a sweep.
  if (current && current.id !== recordingId) killCurrent('preempted by an on-demand conversion');

  const done = waitFor(recordingId);
  enqueue(recordingId, { priority: true });
  await done;

  const out = media.resolveMedia(dir);
  if (out && out.normalized) return { ok: true, media: out };
  const st = await readState(dir);
  return { ok: false, error: st.lastError ? String(st.lastError).slice(0, 200) : 'Conversion failed.' };
}

// ---------- launch sweep ----------

// Reads the filesystem, not meta.status. This is the test that matters: a recording whose
// pipeline already finished (status 'complete') and whose transcode was then interrupted MUST
// still be picked up here.
async function sweep() {
  if (!cfg) return;
  let entries = [];
  try { entries = await fsp.readdir(cfg.recordingsDir); } catch { return; }
  for (const id of entries) {
    const dir = path.join(cfg.recordingsDir, id);
    let state;
    try { state = media.needsNormalize(dir); } catch { continue; }

    // A .part is never valid: +faststart relocates `moov` at the very end, so a partial one has
    // no usable index by construction.
    if (state.stale) await fsp.rm(state.stale, { force: true }).catch(() => {});

    if (state.action === 'cleanup') {
      // Crashed between rename and unlink. Unless the job deliberately kept the source because
      // the output was short, in which case leave both alone.
      // src can be null here (a stale .part next to a finished video.mp4), and fs.rm(null)
      // rejects with ERR_INVALID_ARG_TYPE — swallowed, but it logged a lie.
      if (!state.src) continue;
      const st = await readState(dir);
      if (st.partial) continue;
      log(id, 'cleanup: dropping leftover capture file');
      await fsp.rm(state.src, { force: true }).catch(() => {});
    } else if (state.action === 'normalize') {
      const st = await readState(dir);
      if ((st.attempts || 0) >= MAX_ATTEMPTS) continue;
      // Silent: a crash-recovery sweep can hold a dozen recordings, and driving the global
      // status pill from it would leave "Preparing video…" up for an hour after every launch.
      enqueue(id, { silent: true });
    }
  }
}

// Recordings made before this change are named video.webm, and media.needsNormalize
// deliberately reports 'none' for them so sweep() never touches them: a user with 40 old
// meetings would otherwise get hours of unrequested 100%-CPU transcoding on the first launch
// after updating, on files they may never reopen.
//
// This is the explicit opt-in. Renaming video.webm -> capture.webm turns each one into an
// ordinary job, which means it goes through the same queue, the same acceptance check and the
// same crash recovery as a fresh recording — no second code path.
async function countLegacy() {
  if (!cfg) return 0;
  let entries = [];
  try { entries = await fsp.readdir(cfg.recordingsDir); } catch { return 0; }
  let n = 0;
  for (const id of entries) {
    for (const name of media.LEGACY_NAMES) {
      try { await fsp.access(path.join(cfg.recordingsDir, id, name)); n++; break; } catch { /* not this one */ }
    }
  }
  return n;
}

async function convertLegacy() {
  if (!cfg) return { ok: false, error: 'not ready' };
  if (!ffmpeg.ffmpegPath()) return { ok: false, error: 'ffmpeg is not available in this install' };
  let entries = [];
  try { entries = await fsp.readdir(cfg.recordingsDir); } catch { return { ok: true, queued: 0 }; }
  let queuedCount = 0;
  for (const id of entries) {
    const dir = path.join(cfg.recordingsDir, id);
    // Never touch a recording that already has (or is getting) an mp4.
    if (media.needsNormalize(dir).action !== 'none') continue;
    for (const name of media.LEGACY_NAMES) {
      const from = path.join(dir, name);
      try { await fsp.access(from); } catch { continue; }
      const to = path.join(dir, 'capture.webm');
      try {
        await fsp.rename(from, to);
        // Reset the attempt counter: this is a fresh, user-requested conversion.
        await writeState(dir, { attempts: 0, legacy: true, lastError: null });
        enqueue(id);
        queuedCount++;
      } catch (err) { log(id, 'legacy rename failed:', err.message); }
      break;
    }
  }
  log(`legacy conversion queued for ${queuedCount} recording(s)`);
  return { ok: true, queued: queuedCount };
}

// meta.json is READ-ONLY here (we need startedAt/endedAt for the progress denominator).
// main.js owns writing it.
async function readMetaSafe(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); }
  catch { return null; }
}

// Our own state file. Deliberately NOT meta.json: main.js read-modify-writes that concurrently
// (the conversion is fire-and-forget from runPipeline, so the two interleave in the same tick),
// and a lost update that reverted status:'complete' back to 'transcribing' would make
// recoverAndRequeue re-run the entire pipeline next launch — re-billing Deepgram and nulling
// cached actionItems. Separate files removes the race outright instead of adding a lock.
const STATE_FILE = 'normalize.json';

async function readState(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, STATE_FILE), 'utf8')); }
  catch { return {}; }
}

async function writeState(dir, patch) {
  try {
    const next = { ...(await readState(dir)), ...patch };
    const tmp = path.join(dir, STATE_FILE + '.tmp');
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
    await fsp.rename(tmp, path.join(dir, STATE_FILE));
  } catch { /* diagnostics only — never fail a job over bookkeeping */ }
}

// ---------- the job ----------

async function runJob(job) {
  const { id, silent } = job;
  const dir = path.join(cfg.recordingsDir, id);
  const state = media.needsNormalize(dir);
  if (state.action !== 'normalize') return;

  const bin = ffmpeg.ffmpegPath();
  if (!bin) {
    // Same contract as a missing name agent (src/agents.js): log once, degrade, never throw.
    log(id, 'no ffmpeg binary — keeping', path.basename(state.src));
    await writeState(dir, { lastError: 'no-ffmpeg', at: new Date().toISOString() });
    return;
  }

  const src = state.src;
  const ext = path.extname(src);
  const dst = path.join(dir, media.NORMALIZED_NAME);
  const part = path.join(dir, media.PART_NAME);

  const meta = (await readMetaSafe(dir)) || {}; // read-only: startedAt/endedAt
  const prior = await readState(dir);
  const attempts = (prior.attempts || 0) + 1;

  // Source and output coexist until the rename. checkDiskSpace only warns once at recording
  // start, so this is the only place that actually guards the write.
  let srcSize = 0;
  try { srcSize = (await fsp.stat(src)).size; } catch { return; }
  try {
    const st = await fsp.statfs(dir);
    const free = st.bavail * st.bsize;
    if (free < srcSize * DISK_HEADROOM) {
      // Transient — do NOT count it as an attempt, or a temporarily full disk would permanently
      // disqualify the recording.
      log(id, `skipped: needs ${(srcSize * DISK_HEADROOM / 1048576).toFixed(0)} MB, ${(free / 1048576).toFixed(0)} MB free`);
      await writeState(dir, { lastError: 'insufficient-disk', at: new Date().toISOString() });
      return;
    }
  } catch { /* statfs unsupported — proceed */ }

  // Wall-clock span is the ONLY duration we have: the capture container has no usable duration
  // (that is the bug this whole feature exists to fix), so ffprobe would report N/A.
  const wallMs = meta.startedAt && meta.endedAt
    ? Math.max(1000, Date.parse(meta.endedAt) - Date.parse(meta.startedAt))
    : 0;
  const isCopy = ext === '.mp4' || ext === '.mkv';
  const budget = isCopy
    ? Math.max(60_000, wallMs * 0.25)
    : Math.max(180_000, wallMs * 6);

  await writeState(dir, { attempts, startedAt: new Date().toISOString() });

  const skip = [];
  let result = null;
  let encoder = null;

  for (let tryN = 0; tryN < (isCopy ? 1 : MAX_ENCODERS_PER_JOB); tryN++) {
    if (current && current.killed) return;
    encoder = null;
    if (!isCopy) {
      encoder = await ffmpeg.pickEncoder(bin, { cached: encoderCache, skip });
      if (!encoder) {
        log(id, 'no usable H.264 encoder — keeping', path.basename(src));
        await writeState(dir, { attempts, lastError: 'no-encoder', at: new Date().toISOString() });
        return;
      }
    }

    const args = ffmpeg.buildArgs({
      src, dst: part, ext, encoder,
      threads: isCopy ? 0 : ffmpeg.softwareThreads(),
    });
    const t0 = Date.now();
    log(id, `${isCopy ? 'remux (copy)' : `transcode (${encoder})`} ${path.basename(src)} -> ${media.NORMALIZED_NAME}`);

    let lastPct = -1;
    result = await ffmpeg.run(bin, args, {
      wallMs: budget,
      onChild: (child) => { if (current) current.child = child; },
      onProgress: ({ outMs }) => {
        if (silent || !wallMs || !cfg.emitProgress) return;
        const pct = Math.min(99, Math.floor((outMs / wallMs) * 100));
        if (pct > lastPct) { lastPct = pct; cfg.emitProgress(id, pct); }
      },
    });
    result.ms = Date.now() - t0;

    if (result.ok || (current && current.killed)) break;
    if (isCopy) break;
    // The source is unreadable — trying another encoder cannot help, and must not cost us the
    // validated one.
    if (INPUT_ERROR.test(result.stderr || '')) { log(id, 'source is unreadable — not an encoder problem'); break; }
    log(id, `${encoder} failed (code ${result.code}) — trying the next encoder`);
    skip.push(encoder);
    encoderCache = null; // the cached choice just proved itself wrong
  }

  if (current && current.killed) {
    await fsp.rm(part, { force: true }).catch(() => {});
    return;
  }

  if (!result || !result.ok) {
    await fsp.rm(part, { force: true }).catch(() => {});
    const tail = (result && result.stderr ? result.stderr : '').split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
    log(id, 'failed —', tail || `exit ${result && result.code}`);
    await writeState(dir, {
      attempts, encoder, lastError: tail || `exit ${result && result.code}`, at: new Date().toISOString(),
    });
    return; // capture file untouched; the recording is still playable and downloadable
  }

  // Short output means we mangled something (a truncated capture, a mid-file decode error that
  // -err_detect ignore_err swallowed). Take the mp4 — it is seekable and holds almost everything —
  // but KEEP the source. The 2x disk cost is the right trade for a recording we know is suspect.
  //
  // An EMPTY output is a failure, not a success. `result.outMs && …` treated 0 ms as "complete"
  // (0 is falsy), so a recorder crash left a 261-byte video.mp4 holding no video and DELETED the
  // capture it came from (found by the crash stress test). Unknown length also keeps the source.
  const outSize = (await fsp.stat(part).catch(() => ({ size: 0 }))).size;
  if (!(result.outMs > 0) && outSize < 16 * 1024) {
    await fsp.rm(part, { force: true }).catch(() => {});
    log(id, `empty output (${outSize} bytes) — keeping ${path.basename(src)}`);
    await writeState(dir, { attempts, encoder, lastError: 'empty output', at: new Date().toISOString() });
    return;
  }
  const partial = !!(wallMs && (!(result.outMs > 0) || result.outMs < wallMs * ACCEPT_RATIO));

  try {
    // fsync before the rename: the concern is the page cache, not the rename itself.
    const fh = await fsp.open(part, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(part, dst);
  } catch (err) {
    log(id, 'could not finalize output:', err.message);
    await fsp.rm(part, { force: true }).catch(() => {});
    await writeState(dir, { attempts, encoder, lastError: `finalize: ${err.message}` });
    return;
  }

  if (partial) {
    log(id, `WARNING partial: ${(result.outMs / 1000).toFixed(0)}s of ~${(wallMs / 1000).toFixed(0)}s — keeping ${path.basename(src)}`);
  } else {
    await fsp.rm(src, { force: true }).catch(() => {});
  }

  if (!isCopy && encoder) encoderCache = encoder;
  if (cfg.saveEncoder && encoder) cfg.saveEncoder(encoder);

  await writeState(dir, {
    attempts, encoder: encoder || 'copy', ms: result.ms,
    outMs: Math.round(result.outMs), partial, at: new Date().toISOString(),
    lastError: null,
  });
  log(id, `OK in ${(result.ms / 1000).toFixed(1)}s${partial ? ' (partial)' : ''}`);

  // The URL is derived at read time, so nothing needs patching — but a meeting the user has open
  // right now won't re-render on its own.
  // Pass the truncation facts on. `partial` was previously written to normalize.json and the
  // log and nowhere else — so the app KNEW a 48-minute meeting had produced 2.5 minutes of
  // video and still presented it as a normal recording. Silent correct detection is worth
  // nothing to the user.
  if (cfg.onNormalized) cfg.onNormalized(id, { partial, outMs: Math.round(result.outMs), wallMs });
}

module.exports = {
  configure, enqueue, sweep, killCurrent, pauseForRecording, resume, isBusy, currentId,
  countLegacy, convertLegacy, ensureMp4, isAvailable,
  MAX_ATTEMPTS, ACCEPT_RATIO,
};
