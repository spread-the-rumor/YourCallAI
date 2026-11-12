// Server-as-truth sync (main process). Meeting data (transcript/summary/chat/notes/history)
// lives in Supabase per user; recordings stay local. Last-write-wins per meeting via updatedAt.
// Push-on-write (from store.js) with an offline queue; pull-on-login / on-start (from auth.js).
//
// Permanent deletes are TOMBSTONES, not server-side DELETEs. A hard delete left nothing behind,
// so any other device (or this one's reconcile, if the local removal raced the pull) saw "local
// has it, server doesn't" and pushed the meeting straight back. A tombstone row
// { id, purged: true, deletedAt, updatedAt } in the same table/columns propagates the delete.
//
// Ownership: every meeting pushed/pulled/created while signed in is stamped `ownerId`. A meeting
// stamped for another account is never pushed into the current one (account switch on a shared
// machine used to upload user A's meetings into user B's account). Unstamped meetings are adopted
// by the first account that syncs them, as before. ownerId syncs with the row (harmless).
const fs = require('fs');
const path = require('path');
const { JsonFile } = require('./jsonFile');

const TABLE = 'meetings';
// Local-only fields — never sync (localhost URLs are machine-specific; recompute on pull).
const LOCAL_FIELDS = ['videoUrl', 'transcriptUrl'];

function electronApp() { return require('electron').app; }

let queueFile = null;
function getQueueFile() {
  if (!queueFile) queueFile = new JsonFile(path.join(electronApp().getPath('userData'), 'sync-queue.json'), { ids: [] });
  return queueFile;
}

// Test hook: inject { client, user, queueFile } instead of auth/electron. Pass null to clear.
let testDeps = null;
function _setTestDeps(d) { testDeps = d || null; if (d && d.queueFile) queueFile = d.queueFile; }

function auth() { return require('./auth'); }
function store() { return require('./store'); }
function currentUser() {
  if (testDeps) return testDeps.user || null;
  return auth().getUser();
}
function activeClient() {
  if (testDeps) return testDeps.user ? testDeps.client : null;
  const a = auth();
  return a.getUser() ? a.getClient() : null; // null when signed out → all sync is a no-op
}

function tombstoneData(m) {
  const d = { id: m.id, purged: true, deletedAt: m.deletedAt || m.updatedAt || null, updatedAt: m.updatedAt || null };
  if (m.ownerId) d.ownerId = m.ownerId;
  return d;
}

function stripLocal(m) {
  if (m && m.purged) return tombstoneData(m);
  const out = store().compactMeeting({ ...m }); // never upload per-word timing (93% of the bytes)
  for (const f of LOCAL_FIELDS) delete out[f];
  return out;
}

// Recompute localhost URLs, but only if the recording actually exists on THIS machine.
//
// This used to hardcode 'video.webm'. Once the pipeline started producing video.mp4 that check
// went false, videoUrl came back null, putRaw shallow-merged the null over a perfectly good
// local record, and renderActionRow (which gates on m.videoUrl) silently dropped the ▶ Recording
// and ⬇ Download buttons — for signed-in users only, on every launch, with the file sitting
// right there on disk. Resolve the real filename instead. The folder is named by recordingId.
function rehydrate(m) {
  const recId = m.recordingId || m.id;
  const dir = path.join(electronApp().getPath('userData'), 'recordings', recId);
  const server = require('./server');
  const media = require('./media');
  const hasTranscript = fs.existsSync(path.join(dir, 'transcript.json'));
  return {
    ...m,
    videoUrl: media.mediaUrl(recId, dir, server.PORT),
    transcriptUrl: hasTranscript ? `http://localhost:${server.PORT}/recordings/${recId}/transcript.json` : null,
  };
}

function toRow(m) {
  return {
    id: m.id,
    data: stripLocal(m),
    updated_at: m.updatedAt || new Date().toISOString(),
    deleted_at: m.deletedAt || null,
  };
}

// ---------- offline queue ----------

let flushing = null; // Set of ids enqueued while flushQueue runs (null when not flushing)

async function enqueue(id) {
  if (flushing) flushing.add(id);
  await getQueueFile().update((d) => {
    if (!Array.isArray(d.ids)) d.ids = [];
    if (!d.ids.includes(id)) d.ids.push(id);
  });
}

// The queue after a flush: what failed, plus anything enqueued while the flush ran (whether it
// was new or re-enqueued mid-flush). Overwriting the file with only the failures — the old
// behaviour — silently dropped every id queued during the flush.
function _rebuildQueue({ snapshot, failed, current, during }) {
  const snap = new Set(snapshot || []);
  const out = [];
  const add = (id) => { if (id != null && !out.includes(id)) out.push(id); };
  for (const id of failed || []) add(id);
  for (const id of current || []) if (!snap.has(id)) add(id);
  for (const id of during || []) add(id);
  return out;
}

// ---------- push ----------

// Push one meeting (upsert; a tombstone pushes the purge). Returns true when nothing is left to
// do (pushed, or it belongs to another account and must not be pushed here), false when it has
// to be retried (queued, or signed out).
// opts.asUser: only push if that account is still the signed-in one (a full sync computed for
// user A must not finish pushing into user B's account after a mid-sync account switch).
async function pushMeeting(m, opts = {}) {
  if (!m || !m.id) return true;
  const sb = activeClient();
  const user = currentUser();
  if (opts.asUser && (!user || user.id !== opts.asUser)) return false;
  if (!sb || !user) {
    // Signed out. Ordinary edits are picked up by the next reconcile (local newer → push), but a
    // permanent delete must not depend on that: queue it explicitly so sign-in flushes it.
    if (m.purged) await enqueue(m.id);
    return false;
  }
  if (m.ownerId && m.ownerId !== user.id) return true; // another account's meeting
  if (!m.ownerId) {
    await store().stampOwner([m.id], user.id);
    m = { ...m, ownerId: user.id };
  }
  try {
    const { error } = await sb.from(TABLE).upsert({ ...toRow(m), user_id: user.id });
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.warn('[sync] push queued:', e.message);
    await enqueue(m.id);
    return false;
  }
}

// Permanent delete server-side = push a tombstone. Kept for callers of the old API and for queue
// entries written by older versions (which queued hard deletes by id with no local record left).
async function deleteMeeting(id) {
  const st = store();
  let m = await st.getMeetingRaw(id);
  if (!m || !st.isTombstone(m)) {
    const now = new Date().toISOString();
    m = st.makeTombstone(m || { id }, now);
    await st.withSyncSuppressed(() => st.putManyRaw([m]));
  }
  return pushMeeting(m);
}

// ---------- pull ----------

const PULL_BATCH = 20;

// Pull and reconcile against local by updatedAt (last-write-wins). Throws if the server cannot
// be listed at all; partial failures are returned in `errors`.
//
// Two phases. Listing first selects only ids and timestamps; the full `data` (which carries the
// transcript) is fetched just for rows that are actually newer on the server.
async function pullAll() {
  const sb = activeClient();
  const user = currentUser();
  if (!sb || !user) throw new Error('Not signed in');
  const st = store();
  const { data: heads, error } = await sb.from(TABLE).select('id,updated_at').eq('user_id', user.id);
  if (error) throw new Error(`Sync failed: could not list meetings (${error.message})`);

  const local = await st.loadAllRaw(); // includes trashed + tombstones
  const localById = new Map(local.map((m) => [m.id, m]));

  // Existing libraries predate ownerId: anything this account's server already holds is its own.
  const unowned = (heads || []).filter((r) => localById.get(r.id) && !localById.get(r.id).ownerId).map((r) => r.id);
  if (unowned.length) await st.stampOwner(unowned, user.id);

  const { toLocal, toServer } = _reconcilePlan(
    local.map((m) => ({ id: m.id, updatedAt: m.updatedAt, ownerId: m.ownerId })),
    (heads || []).map((r) => ({ id: r.id, updatedAt: r.updated_at })),
    { userId: user.id },
  );

  const errors = [];
  const pulled = [];
  const repush = [];
  for (let i = 0; i < toLocal.length; i += PULL_BATCH) {
    const ids = toLocal.slice(i, i + PULL_BATCH);
    const { data: rows, error: e2 } = await sb.from(TABLE).select('id,data').in('id', ids).eq('user_id', user.id);
    if (e2) { console.warn('[sync] pull batch failed:', e2.message); errors.push(e2.message); continue; }
    for (const row of rows || []) {
      if (!row.data) continue;
      const d = { ...row.data, id: row.id, ownerId: user.id };
      // Purged here, edited elsewhere later: the purge wins. Re-push the tombstone (fresh
      // updatedAt) so the server and every other device converge on "deleted".
      if (st.isTombstone(localById.get(row.id)) && !d.purged) { repush.push(row.id); continue; }
      pulled.push(d.purged ? d : rehydrate(d));
    }
  }
  if (pulled.length) await st.withSyncSuppressed(() => st.putManyRaw(pulled));

  let pushFailed = 0;
  if (repush.length) {
    const now = new Date().toISOString();
    const tombs = repush.map((id) => ({ ...localById.get(id), updatedAt: now }));
    await st.withSyncSuppressed(() => st.putManyRaw(tombs));
    for (const t of tombs) if (!(await pushMeeting(await st.getMeetingRaw(t.id), { asUser: user.id }))) pushFailed++;
  }

  // Local meetings the server is missing, or where local is newer → push up.
  for (const id of toServer) {
    const m = await st.getMeetingRaw(id);
    if (m && !(await pushMeeting(m, { asUser: user.id }))) pushFailed++;
  }
  return { pulled: pulled.length, pushed: toServer.length + repush.length - pushFailed, pushFailed, errors };
}

const ts = (v) => (v ? new Date(v).getTime() : 0);

// Flush the offline queue: re-push each queued meeting (tombstones included).
// Returns { pushed, failed: [ids] }.
async function flushQueue() {
  const sb = activeClient();
  if (!sb || flushing) return { pushed: 0, failed: [] };
  const { ids: rawIds } = await getQueueFile().read();
  const ids = Array.isArray(rawIds) ? rawIds : [];
  if (!ids.length) return { pushed: 0, failed: [] };
  flushing = new Set();
  const failed = [];
  try {
    for (const id of ids) {
      let ok = false;
      try {
        const m = await store().getMeetingRaw(id);
        ok = m ? await pushMeeting(m) : await deleteMeeting(id);
      } catch (e) { console.warn('[sync] queue item failed:', e.message); }
      if (!ok) failed.push(id);
    }
  } finally {
    const during = [...flushing];
    flushing = null;
    await getQueueFile().update((d) => ({
      ids: _rebuildQueue({ snapshot: ids, failed, current: Array.isArray(d.ids) ? d.ids : [], during }),
    }));
  }
  return { pushed: ids.length - failed.length, failed };
}

// Single-flight: login sync and "Sync now" used to run two full syncs concurrently, doubling every
// push and racing the queue file. Throws when anything failed, so callers report an error.
// Resolves to { pulled, pushed } on success.
let syncing = null;
function fullSync() {
  if (!syncing) {
    syncing = (async () => {
      const pull = await pullAll();
      const q = await flushQueue();
      const problems = [];
      if (pull.errors.length) problems.push(`${pull.errors.length} download batch(es) failed (${pull.errors[0]})`);
      if (q.failed.length) problems.push(`${q.failed.length} meeting(s) failed to upload and stay queued`);
      if (problems.length) throw new Error(`Sync incomplete: ${problems.join('; ')}`);
      return { pulled: pull.pulled, pushed: pull.pushed + q.pushed };
    })().finally(() => { syncing = null; });
  }
  return syncing;
}

module.exports = {
  pushMeeting, deleteMeeting, pullAll, flushQueue, fullSync, stripLocal, rehydrate,
  _reconcilePlan, _rebuildQueue, _setTestDeps,
};

// ---- pure reconcile core, extracted for the self-check (no Supabase / fs needed) ----
// Given local + server meeting arrays, returns { toLocal:[ids], toServer:[ids] } by LWW.
// opts.userId: local meetings stamped with a DIFFERENT ownerId are excluded both ways — they
// belong to another account and must neither be pushed into this one nor overwritten from it.
function _reconcilePlan(local, server, opts = {}) {
  const foreign = (l) => !!(l && l.ownerId && opts.userId && l.ownerId !== opts.userId);
  const localById = new Map(local.map((m) => [m.id, m]));
  const serverById = new Map(server.map((m) => [m.id, m]));
  const toLocal = [], toServer = [];
  for (const s of server) {
    const l = localById.get(s.id);
    if (foreign(l)) continue;
    if (!l || ts(s.updatedAt) > ts(l.updatedAt)) toLocal.push(s.id);
  }
  for (const l of local) {
    if (foreign(l)) continue;
    const s = serverById.get(l.id);
    if (!s || ts(l.updatedAt) > ts(s.updatedAt)) toServer.push(l.id);
  }
  return { toLocal, toServer };
}

// ponytail: assert-based self-check, run with `node src/sync.js`
if (require.main === module) {
  const assert = require('assert');
  const local = [
    { id: 'a', updatedAt: '2026-01-02T00:00:00Z' }, // newer locally
    { id: 'b', updatedAt: '2026-01-01T00:00:00Z' }, // older locally
    { id: 'c', updatedAt: '2026-01-01T00:00:00Z' }, // local-only
  ];
  const server = [
    { id: 'a', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'b', updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'd', updatedAt: '2026-01-01T00:00:00Z' }, // server-only
  ];
  const { toLocal, toServer } = _reconcilePlan(local, server);
  assert.deepStrictEqual(toLocal.sort(), ['b', 'd'], 'server-newer + server-only pull down');
  assert.deepStrictEqual(toServer.sort(), ['a', 'c'], 'local-newer + local-only push up');
  assert.deepStrictEqual(stripLocal({ id: 'x', videoUrl: 'v', summary: 's' }), { id: 'x', summary: 's' });
  console.log('sync reconcile self-check OK');
}
