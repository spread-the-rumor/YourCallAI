// Server-as-truth sync (main process). Meeting data (transcript/summary/chat/notes/history)
// lives in Supabase per user; recordings stay local. Last-write-wins per meeting via updatedAt.
// Push-on-write (from store.js) with an offline queue; pull-on-login / on-start (from auth.js).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { JsonFile } = require('./jsonFile');

const TABLE = 'meetings';
// Local-only fields — never sync (localhost URLs are machine-specific; recompute on pull).
const LOCAL_FIELDS = ['videoUrl', 'transcriptUrl'];

let queueFile = null;
function getQueueFile() {
  if (!queueFile) queueFile = new JsonFile(path.join(app.getPath('userData'), 'sync-queue.json'), { ids: [] });
  return queueFile;
}

function auth() { return require('./auth'); }
function store() { return require('./store'); }
function activeClient() {
  const a = auth();
  return a.getUser() ? a.getClient() : null; // null when signed out → all sync is a no-op
}

function stripLocal(m) {
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
// right there on disk. Resolve the real filename instead.
function rehydrate(m) {
  const dir = path.join(app.getPath('userData'), 'recordings', m.id);
  const server = require('./server');
  const media = require('./media');
  const hasTranscript = fs.existsSync(path.join(dir, 'transcript.json'));
  return {
    ...m,
    videoUrl: media.mediaUrl(m.id, dir, server.PORT),
    transcriptUrl: hasTranscript ? `http://localhost:${server.PORT}/recordings/${m.id}/transcript.json` : null,
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

async function enqueue(id) {
  await getQueueFile().update((d) => { if (!d.ids.includes(id)) d.ids.push(id); });
}

// Push one meeting (upsert). Fire-and-forget; on failure, queue for later flush.
async function pushMeeting(m) {
  const sb = activeClient();
  if (!sb || !m) return;
  const user = auth().getUser();
  const { error } = await sb.from(TABLE).upsert({ ...toRow(m), user_id: user.id });
  if (error) { console.warn('[sync] push queued:', error.message); await enqueue(m.id); }
}

// Hard-delete a meeting server-side (permanent delete only; soft delete syncs via deletedAt).
async function deleteMeeting(id) {
  const sb = activeClient();
  if (!sb) return;
  const { error } = await sb.from(TABLE).delete().eq('id', id);
  if (error) { console.warn('[sync] delete queued:', error.message); await enqueue(id); }
}

const PULL_BATCH = 20;

// Pull and reconcile against local by updatedAt (last-write-wins).
//
// Two phases. Listing first selects only ids and timestamps; the full `data` (which carries the
// transcript) is fetched just for rows that are actually newer on the server. The old version
// selected `data` for every row on every launch — the whole library, transcripts included, each
// time — and then rewrote the local store once per row.
//
// Comparison uses the row's `updated_at` column, which toRow() sets from the meeting's updatedAt,
// so it is the same value the old code read out of `data`.
async function pullAll() {
  const sb = activeClient();
  if (!sb) return;
  const { data: heads, error } = await sb.from(TABLE).select('id,updated_at');
  if (error) { console.warn('[sync] pull failed:', error.message); return; }

  const local = await store().loadAllRaw(); // includes trashed
  const localById = new Map(local.map((m) => [m.id, m]));
  const serverById = new Map((heads || []).map((r) => [r.id, r]));

  const { toLocal, toServer } = _reconcilePlan(
    local.map((m) => ({ id: m.id, updatedAt: m.updatedAt })),
    (heads || []).map((r) => ({ id: r.id, updatedAt: r.updated_at })),
  );

  const pulled = [];
  for (let i = 0; i < toLocal.length; i += PULL_BATCH) {
    const ids = toLocal.slice(i, i + PULL_BATCH);
    const { data: rows, error: e2 } = await sb.from(TABLE).select('id,data').in('id', ids);
    if (e2) { console.warn('[sync] pull batch failed:', e2.message); continue; }
    for (const row of rows || []) if (row.data) pulled.push(rehydrate(row.data));
  }
  if (pulled.length) await store().withSyncSuppressed(() => store().putManyRaw(pulled));

  // Local meetings the server is missing, or where local is newer → push up.
  for (const id of toServer) {
    const m = localById.get(id);
    if (m && (!serverById.has(id) || ts(m.updatedAt) > ts(serverById.get(id).updated_at))) await pushMeeting(m);
  }
}

const ts = (v) => (v ? new Date(v).getTime() : 0);

// Flush the offline queue: re-push each queued meeting still present locally.
async function flushQueue() {
  const sb = activeClient();
  if (!sb) return;
  const { ids } = await getQueueFile().read();
  if (!ids.length) return;
  const remaining = [];
  for (const id of ids) {
    const m = await store().getMeetingRaw(id);
    try {
      if (m) await pushMeeting(m); else await deleteMeeting(id);
    } catch { remaining.push(id); }
  }
  await getQueueFile().update(() => ({ ids: remaining }));
}

async function fullSync() {
  await pullAll();
  await flushQueue();
}

module.exports = { pushMeeting, deleteMeeting, pullAll, flushQueue, fullSync, stripLocal, rehydrate, _reconcilePlan };

// ---- pure reconcile core, extracted for the self-check (no Supabase / fs needed) ----
// Given local + server meeting arrays, returns { toLocal:[ids], toServer:[ids] } by LWW.
function _reconcilePlan(local, server) {
  const localById = new Map(local.map((m) => [m.id, m]));
  const serverById = new Map(server.map((m) => [m.id, m]));
  const toLocal = [], toServer = [];
  for (const s of server) {
    const l = localById.get(s.id);
    if (!l || ts(s.updatedAt) > ts(l.updatedAt)) toLocal.push(s.id);
  }
  for (const l of local) {
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
