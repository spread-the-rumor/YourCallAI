// Meeting note store: single meetings.json in userData, shape { meetings: [...] } (§4.3).
//
// Held in memory and written back in the background. The old store re-read and re-parsed the
// whole file on EVERY read and rewrote it on every write — measured on a real library at 243 MB,
// that was ~1.3 s per parse and ~5 s of blocked main thread per edit, and it grew 1.5 MB per
// meeting. Now: parse once, mutate in memory, coalesce writes (WRITE_DELAY_MS), compact JSON.
//
// Transcripts are stored COMPACT (see compactSegment): no per-word timing array. Words were 93%
// of the file and nothing outside the pipeline needs them — the pipeline reads the full
// transcript straight from Deepgram, and <recording>/transcript.json keeps every word on disk.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const WRITE_DELAY_MS = 300;

let userDataDir = null; // injectable for tests; defaults to Electron's userData
function dataDir() {
  if (!userDataDir) userDataDir = require('electron').app.getPath('userData');
  return userDataDir;
}
const filePath = () => path.join(dataDir(), 'meetings.json');

let cache = null;        // { meetings: [...] } — the single in-memory truth once loaded
let loading = null;      // in-flight load promise
let writeTimer = null;
let dirty = false;
let writeChain = Promise.resolve();

// ---------- compact transcript shape ----------

// A Deepgram-derived segment carries `words: [{text, start_timestamp, end_timestamp}]`. Keep the
// text (rebuilt from words so it reads exactly as before) and the segment's own start/end, both
// relative seconds and absolute ISO, which is all anything outside the pipeline ever used.
function compactSegment(seg) {
  if (!seg || !Array.isArray(seg.words)) return seg;
  const { words, ...rest } = seg;
  const out = { ...rest };
  if (words.length) {
    out.text = words.map((w) => w.text).join(' ');
    const a = words[0].start_timestamp;
    const b = words[words.length - 1].end_timestamp;
    if (a) { out.start = a.relative; out.startAt = a.absolute; }
    if (b) { out.end = b.relative; out.endAt = b.absolute; }
  }
  return out;
}
function compactTranscript(t) {
  if (!Array.isArray(t)) return t;
  return t.some((s) => s && Array.isArray(s.words)) ? t.map(compactSegment) : t;
}
function compactMeeting(m) {
  if (!m || !Array.isArray(m.transcript)) return m;
  const t = compactTranscript(m.transcript);
  return t === m.transcript ? m : { ...m, transcript: t };
}

// ---------- load / persist ----------

async function cleanupStaleTemps() {
  // A write interrupted between writeFile and rename leaves `meetings.json.<ts>.tmp` forever —
  // one real library had a 185 MB orphan. Safe here: load runs before this process writes.
  try {
    for (const f of await fsp.readdir(dataDir())) {
      if (/^meetings\.json\.\d+\.tmp$/.test(f)) await fsp.rm(path.join(dataDir(), f), { force: true });
    }
  } catch { /* best effort */ }
}

async function load() {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      await cleanupStaleTemps();
      let data = null;
      let raw = null;
      try { raw = await fsp.readFile(filePath(), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (raw != null) {
        try { data = JSON.parse(raw); } catch (e) {
          // The old store returned the empty fallback on a parse error and then OVERWROTE the file
          // on the next write, silently erasing every meeting. Set the bad file aside instead.
          const aside = path.join(dataDir(), `meetings.corrupt-${Date.now()}.json`);
          await fsp.rename(filePath(), aside).catch(() => {});
          console.error(`[store] meetings.json unreadable (${e.message}); moved to ${aside}`);
        }
      }
      if (!data || !Array.isArray(data.meetings)) data = { meetings: [] };

      // One-time migration to the compact shape. Back the original up first: it is the only
      // copy of word timings for meetings whose recording folder no longer exists.
      if (data.meetings.some((m) => Array.isArray(m?.transcript) && m.transcript.some((s) => s && Array.isArray(s.words)))) {
        const backup = path.join(dataDir(), 'meetings.backup-pre-compact.json');
        if (raw != null && !fs.existsSync(backup)) await fsp.writeFile(backup, raw, 'utf8');
        data.meetings = data.meetings.map(compactMeeting);
        cache = data;
        dirty = true;
        await flush();
      }
      cache = data;
      return cache;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

async function writeNow() {
  if (!cache || !dirty) return;
  dirty = false;
  const body = JSON.stringify(cache); // compact: the 2-space indent alone doubled the file
  const target = filePath();
  const tmp = `${target}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(body, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, target);
}

// Resolves once everything changed so far is on disk.
function flush() {
  clearTimeout(writeTimer);
  writeTimer = null;
  const run = () => writeNow().catch((e) => { dirty = true; console.error('[store] write failed:', e.message); });
  writeChain = writeChain.then(run, run);
  return writeChain;
}

function scheduleWrite() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flush(); }, WRITE_DELAY_MS);
}

// Last-chance synchronous write for will-quit, where nothing async is awaited. Small now that
// transcripts are compact (single-digit MB).
function flushSync() {
  clearTimeout(writeTimer);
  writeTimer = null;
  if (!cache || !dirty) return;
  dirty = false;
  const target = filePath();
  const tmp = `${target}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
  fs.renameSync(tmp, target);
}

// ---------- sync hooks ----------

// Push a meeting to the server after a local write, if signed in. Lazy-required to avoid a
// require cycle (store ↔ sync ↔ auth) and guarded so the store works even if sync isn't wired.
let syncSuppressed = false;
function syncPush(m) {
  if (syncSuppressed || !m) return;
  Promise.resolve().then(() => require('./sync').pushMeeting(m))
    .catch((e) => console.warn('[store] sync push:', e.message));
}
function syncDelete(id) {
  if (syncSuppressed) return;
  Promise.resolve().then(() => require('./sync').deleteMeeting(id)).catch((e) => console.warn('[store] sync delete:', e.message));
}

// Callers get copies: the cache is the only truth, and a caller mutating a returned record (the
// pipeline does mutate transcripts in place) must never change it behind the store's back.
const copy = (m) => (m ? structuredClone(m) : null);

// ---------- raw accessors used by sync.js — no filtering/sorting, and no sync echo ----------

async function loadAllRaw() {
  const { meetings } = await load();
  return meetings; // read-only by contract (sync only reads ids/updatedAt and serializes)
}
async function getMeetingRaw(id) { return getMeeting(id); }

// Insert-or-replace from the server pull, many at once (one write, not one rewrite per row).
async function putManyRaw(list) {
  const data = await load();
  const index = new Map(data.meetings.map((m, i) => [m.id, i]));
  for (const incoming of list || []) {
    const meeting = compactMeeting(incoming);
    const i = index.get(meeting.id);
    if (i != null) data.meetings[i] = { ...data.meetings[i], ...meeting };
    else { index.set(meeting.id, data.meetings.length); data.meetings.push(meeting); }
  }
  if ((list || []).length) scheduleWrite();
}
async function putRaw(meeting) { return putManyRaw([meeting]); }

// ---------- public API ----------

const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);

async function loadMeetings() {
  const { meetings } = await load();
  return meetings.filter((m) => !m.deletedAt).sort(byDateDesc);
}

async function loadTrash() {
  const { meetings } = await load();
  return meetings.filter((m) => m.deletedAt).sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
}

async function getMeeting(id) {
  const { meetings } = await load();
  return copy(meetings.find((m) => m.id === id));
}

// Case-insensitive substring search over title, notes and transcript text, done here because
// main holds the transcripts — the renderer's list no longer carries them.
// Lowercased haystack per meeting, rebuilt only when that meeting's updatedAt changes. Without it
// every keystroke re-lowercased every transcript (74 ms at 1,155 meetings, measured).
const searchCache = new Map(); // id -> { stamp, text }
function haystack(m) {
  const stamp = `${m.updatedAt || ''}|${(m.transcript || []).length}|${m.title || ''}`;
  const hit = searchCache.get(m.id);
  if (hit && hit.stamp === stamp) return hit.text;
  const text = [m.title || '', m.content || '', ...(m.transcript || []).map((s) => s.text || '')].join('\n').toLowerCase();
  searchCache.set(m.id, { stamp, text });
  return text;
}

async function searchMeetings(query) {
  const q = String(query || '').trim().toLowerCase();
  const { meetings } = await load();
  if (!q) return meetings.map((m) => m.id);
  return meetings.filter((m) => haystack(m).includes(q)).map((m) => m.id);
}

// Insert or replace by recordingId — dedups re-runs of the pipeline.
async function upsertMeeting(meeting) {
  const data = await load();
  const incoming = compactMeeting(structuredClone(meeting));
  const now = new Date().toISOString();
  const i = data.meetings.findIndex((m) => m.recordingId === incoming.recordingId);
  let saved;
  if (i >= 0) saved = data.meetings[i] = { ...data.meetings[i], ...incoming, updatedAt: now };
  else data.meetings.push(saved = { ...incoming, createdAt: now, updatedAt: now });
  scheduleWrite();
  syncPush(copy(saved));
  return copy(saved);
}

async function updateMeeting(id, patch) {
  const data = await load();
  const m = data.meetings.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, compactMeeting(structuredClone(patch || {})), { updatedAt: new Date().toISOString() });
  scheduleWrite();
  syncPush(copy(m)); // covers softDelete (deletedAt), which routes through here
  return copy(m);
}

async function softDelete(id) {
  return updateMeeting(id, { deletedAt: new Date().toISOString() });
}

async function restore(id) {
  const data = await load();
  const m = data.meetings.find((x) => x.id === id);
  if (!m) return null;
  delete m.deletedAt;
  m.updatedAt = new Date().toISOString();
  scheduleWrite();
  syncPush(copy(m));
  return copy(m);
}

async function deletePermanent(id, recordingsDir) {
  const data = await load();
  data.meetings = data.meetings.filter((m) => m.id !== id);
  scheduleWrite();
  syncDelete(id); // hard-delete server-side (soft delete syncs via deletedAt instead)
  if (recordingsDir) {
    await fsp.rm(path.join(recordingsDir, id), { recursive: true, force: true }).catch(() => {});
  }
}

// Suppress the push-on-write echo while sync applies server rows.
async function withSyncSuppressed(fn) {
  syncSuppressed = true;
  try { return await fn(); } finally { syncSuppressed = false; }
}

// Test hook: point the store at another directory and drop all in-memory state.
function _reset(dir) {
  clearTimeout(writeTimer);
  userDataDir = dir || null;
  cache = null; loading = null; writeTimer = null; dirty = false; writeChain = Promise.resolve();
}

module.exports = {
  load, flush, flushSync,
  loadMeetings, loadTrash, getMeeting, searchMeetings, upsertMeeting, updateMeeting,
  softDelete, restore, deletePermanent,
  loadAllRaw, getMeetingRaw, putRaw, putManyRaw, withSyncSuppressed,
  compactSegment, compactTranscript, compactMeeting, _reset,
};
