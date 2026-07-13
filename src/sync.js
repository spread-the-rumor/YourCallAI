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
  const out = { ...m };
  for (const f of LOCAL_FIELDS) delete out[f];
  return out;
}

// Recompute localhost URLs, but only if the recording actually exists on THIS machine.
function rehydrate(m) {
  const recordingsDir = path.join(app.getPath('userData'), 'recordings', m.id);
  const server = require('./server');
  const hasVideo = fs.existsSync(path.join(recordingsDir, 'video.webm'));
  const hasTranscript = fs.existsSync(path.join(recordingsDir, 'transcript.json'));
  return {
    ...m,
    videoUrl: hasVideo ? `http://localhost:${server.PORT}/recordings/${m.id}/video.webm` : null,
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

// Pull all server rows and reconcile against local by updatedAt (last-write-wins).
async function pullAll() {
  const sb = activeClient();
  if (!sb) return;
  const { data: rows, error } = await sb.from(TABLE).select('id,data,updated_at,deleted_at');
  if (error) { console.warn('[sync] pull failed:', error.message); return; }

  const local = await store().loadAllRaw(); // includes trashed
  const localById = new Map(local.map((m) => [m.id, m]));
  const seen = new Set();

  for (const row of rows || []) {
    seen.add(row.id);
    const remote = row.data;
    const localM = localById.get(row.id);
    if (!localM || ts(remote.updatedAt) > ts(localM.updatedAt)) {
      await store().putRaw(rehydrate(remote)); // server newer (or new) → write locally
    }
    // local newer → will be pushed below
  }

  // Local meetings the server is missing, or where local is newer → push up.
  for (const m of local) {
    const row = (rows || []).find((r) => r.id === m.id);
    if (!row || ts(m.updatedAt) > ts(row.data.updatedAt)) await pushMeeting(m);
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
