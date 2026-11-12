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
let writeChain = Promise.resolve();
// Generation counters instead of a `dirty` flag. `gen` bumps on every change; `savedGen` is the
// newest generation known to be on disk (renamed into place). A plain flag cleared at the START of
// an async write lied while that write was in flight: flushSync (will-quit) saw "clean", did
// nothing, and the process exited before the rename — losing the last changes.
let gen = 0;
let savedGen = 0;
let inFlight = 0;        // async writes between "body serialized" and "renamed or abandoned"
const isDirty = () => gen !== savedGen;

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
      if (/^meetings\.json\.(sync\.)?\d+(\.\d+)?\.tmp$/.test(f)) await fsp.rm(path.join(dataDir(), f), { force: true });
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
        gen++;
        await flush();
      }
      cache = data;
      return cache;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

let tmpSeq = 0;
async function writeNow() {
  if (!cache || !isDirty()) return;
  const myGen = gen;
  const body = JSON.stringify(cache); // compact: the 2-space indent alone doubled the file
  const target = filePath();
  const tmp = `${target}.${Date.now()}.${++tmpSeq}.tmp`;
  inFlight++;
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(body, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    // flushSync may have written a NEWER snapshot while this one was being written. The check and
    // the rename are both synchronous, so nothing can run between them: either flushSync ran
    // before (we abandon this older body) or it runs after (its newer body replaces ours).
    if (savedGen >= myGen) { fs.rmSync(tmp, { force: true }); return; }
    fs.renameSync(tmp, target);
    savedGen = myGen; // changes made during the write keep gen > savedGen, so they stay dirty
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    inFlight--;
  }
}

// Resolves once everything changed so far is on disk.
function flush() {
  clearTimeout(writeTimer);
  writeTimer = null;
  const run = () => writeNow().catch((e) => { console.error('[store] write failed:', e.message); });
  writeChain = writeChain.then(run, run);
  return writeChain;
}

function scheduleWrite() {
  gen++;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flush(); }, WRITE_DELAY_MS);
}

// Last-chance synchronous write for will-quit, where nothing async is awaited. Small now that
// transcripts are compact (single-digit MB). Writes whenever anything is unsaved OR an async write
// is still in flight (its rename may never happen if the process exits now). Uses its own tmp name
// so it can never collide with the in-flight async tmp file.
function flushSync() {
  clearTimeout(writeTimer);
  writeTimer = null;
  if (!cache || (!isDirty() && !inFlight)) return;
  const myGen = gen;
  const target = filePath();
  const tmp = `${target}.sync.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(cache), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
  savedGen = myGen;
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
// Signed-in user id, or null. Guarded: the store must work with no auth wired (tests, no login).
function currentUserId() {
  try { return require('./auth').getUser()?.id || null; } catch { return null; }
}

// Callers get copies: the cache is the only truth, and a caller mutating a returned record (the
// pipeline does mutate transcripts in place) must never change it behind the store's back.
const copy = (m) => (m ? structuredClone(m) : null);

// A permanently deleted meeting leaves a minimal TOMBSTONE { id, recordingId, purged, deletedAt,
// updatedAt, ownerId? } instead of vanishing. Without it, the next reconcile sees "server has it,
// local doesn't" (or another device still has it) and the meeting comes back. Tombstones are
// invisible to every public reader; only the raw sync accessors see them.
const isTombstone = (m) => !!(m && m.purged);
function makeTombstone(m, at) {
  const t = { id: m.id, recordingId: m.recordingId || m.id, purged: true, deletedAt: m.deletedAt || at, updatedAt: at };
  if (m.ownerId) t.ownerId = m.ownerId;
  return t;
}

// ---------- raw accessors used by sync.js — no filtering/sorting, and no sync echo ----------

async function loadAllRaw() {
  const { meetings } = await load();
  return meetings; // read-only by contract (sync only reads ids/updatedAt and serializes)
}
// Includes tombstones (getMeeting hides them) — the offline queue must be able to re-push one.
async function getMeetingRaw(id) {
  const { meetings } = await load();
  return copy(meetings.find((m) => m.id === id));
}

// Insert-or-replace from the server pull, many at once (one write, not one rewrite per row).
// A purged incoming row replaces the local record with a tombstone. A local tombstone is sticky:
// a non-purged incoming row never resurrects it (sync re-pushes the tombstone instead).
async function putManyRaw(list) {
  const data = await load();
  const index = new Map(data.meetings.map((m, i) => [m.id, i]));
  let changed = 0;
  for (const incoming of list || []) {
    if (!incoming || !incoming.id) continue;
    const i = index.get(incoming.id);
    const local = i != null ? data.meetings[i] : null;
    let next;
    if (isTombstone(incoming)) {
      next = makeTombstone({ ...incoming, recordingId: incoming.recordingId || local?.recordingId, ownerId: incoming.ownerId || local?.ownerId },
        incoming.updatedAt || new Date().toISOString());
      searchCache.delete(incoming.id);
    } else if (isTombstone(local)) {
      continue;
    } else {
      const meeting = compactMeeting(incoming);
      next = local ? { ...local, ...meeting } : meeting;
    }
    if (i != null) data.meetings[i] = next;
    else { index.set(next.id, data.meetings.length); data.meetings.push(next); }
    changed++;
  }
  if (changed) scheduleWrite();
}
async function putRaw(meeting) { return putManyRaw([meeting]); }

// Stamp ownerId on meetings that have none, WITHOUT bumping updatedAt (it is bookkeeping, not an
// edit, and must not make the meeting look newer than the server's copy). Returns ids stamped.
async function stampOwner(ids, ownerId) {
  if (!ownerId) return [];
  const data = await load();
  const want = new Set(ids || []);
  const stamped = [];
  for (const m of data.meetings) {
    if (want.has(m.id) && !m.ownerId) { m.ownerId = ownerId; stamped.push(m.id); }
  }
  if (stamped.length) scheduleWrite();
  return stamped;
}

// ---------- public API ----------

const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);

async function loadMeetings() {
  const { meetings } = await load();
  return meetings.filter((m) => !m.deletedAt && !isTombstone(m)).sort(byDateDesc);
}

async function loadTrash() {
  const { meetings } = await load();
  return meetings.filter((m) => m.deletedAt && !isTombstone(m)).sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
}

async function getMeeting(id) {
  const { meetings } = await load();
  const m = meetings.find((x) => x.id === id);
  return isTombstone(m) ? null : copy(m);
}

// The recording folder name for a meeting (recordingId, falling back to id), or null if the
// meeting is unknown or already purged. Lets main check "is the pipeline holding this?" first.
async function recordingIdFor(id) {
  const m = await getMeeting(id);
  return m ? (m.recordingId || m.id) : null;
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
  const live = meetings.filter((m) => !isTombstone(m));
  if (!q) return live.map((m) => m.id);
  return live.filter((m) => haystack(m).includes(q)).map((m) => m.id);
}

// Insert or replace by recordingId — dedups re-runs of the pipeline.
// A purged meeting stays purged: an upsert onto its tombstone is refused (returns null).
async function upsertMeeting(meeting) {
  const data = await load();
  const incoming = compactMeeting(structuredClone(meeting));
  const now = new Date().toISOString();
  const i = data.meetings.findIndex((m) => m.recordingId === incoming.recordingId);
  if (i >= 0 && isTombstone(data.meetings[i])) return null;
  let saved;
  if (i >= 0) saved = data.meetings[i] = { ...data.meetings[i], ...incoming, updatedAt: now };
  else {
    saved = { ...incoming, createdAt: now, updatedAt: now };
    const owner = currentUserId();
    if (owner && !saved.ownerId) saved.ownerId = owner; // created while signed in → this account's
    data.meetings.push(saved);
  }
  scheduleWrite();
  syncPush(copy(saved));
  return copy(saved);
}

async function updateMeeting(id, patch) {
  const data = await load();
  const m = data.meetings.find((x) => x.id === id);
  if (!m || isTombstone(m)) return null;
  Object.assign(m, compactMeeting(structuredClone(patch || {})), { updatedAt: new Date().toISOString() });
  scheduleWrite();
  syncPush(copy(m)); // covers softDelete (deletedAt), which routes through here
  return copy(m);
}

async function softDelete(id) {
  return updateMeeting(id, { deletedAt: new Date().toISOString() });
}

// deletedAt is set to null, NOT deleted: sync applies rows with a shallow merge, so an absent key
// left the other device's deletedAt in place and the meeting stayed in its trash forever.
async function restore(id) {
  const data = await load();
  const m = data.meetings.find((x) => x.id === id);
  if (!m || isTombstone(m)) return null;
  m.deletedAt = null;
  m.updatedAt = new Date().toISOString();
  scheduleWrite();
  syncPush(copy(m));
  return copy(m);
}

// Permanently delete: leaves a tombstone (pushed to the server so other devices drop it too) and
// removes the recording folder, which is named by recordingId (falls back to id).
// opts.isBusy(recordingId) → true refuses the delete (e.g. the pipeline is still writing it).
// Returns { ok: true } or { ok: false, error }.
async function deletePermanent(id, recordingsDir, opts = {}) {
  const data = await load();
  const i = data.meetings.findIndex((m) => m.id === id);
  if (i < 0 || isTombstone(data.meetings[i])) return { ok: false, error: 'Meeting not found.' };
  const m = data.meetings[i];
  const recId = m.recordingId || m.id;
  if (typeof opts.isBusy === 'function' && opts.isBusy(recId)) {
    return { ok: false, error: 'This meeting is still processing.' };
  }
  const tomb = makeTombstone(m, new Date().toISOString());
  data.meetings[i] = tomb;
  searchCache.delete(id);
  scheduleWrite();
  syncPush(copy(tomb)); // the tombstone itself is what syncs (see sync.pushMeeting)
  // recId comes from synced data: never let it name anything outside recordingsDir.
  if (recordingsDir && recId && path.basename(String(recId)) === String(recId) && recId !== '.' && recId !== '..') {
    await fsp.rm(path.join(recordingsDir, String(recId)), { recursive: true, force: true }).catch(() => {});
  }
  return { ok: true };
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
  cache = null; loading = null; writeTimer = null; writeChain = Promise.resolve();
  gen = 0; savedGen = 0; inFlight = 0;
  searchCache.clear();
}

module.exports = {
  load, flush, flushSync,
  loadMeetings, loadTrash, getMeeting, searchMeetings, upsertMeeting, updateMeeting,
  softDelete, restore, deletePermanent, recordingIdFor,
  _writeState: () => ({ gen, savedGen, inFlight }),
  loadAllRaw, getMeetingRaw, putRaw, putManyRaw, stampOwner, withSyncSuppressed,
  isTombstone, makeTombstone,
  compactSegment, compactTranscript, compactMeeting, _reset,
};
