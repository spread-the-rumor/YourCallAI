// Meeting note store: single meetings.json in userData, shape { meetings: [...] } (§4.3).
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { app } = require('electron');
const { JsonFile } = require('./jsonFile');

let file;
function getFile() {
  if (!file) file = new JsonFile(path.join(app.getPath('userData'), 'meetings.json'), { meetings: [] });
  return file;
}

// Push a meeting to the server after a local write, if signed in. Lazy-required to avoid a
// require cycle (store ↔ sync ↔ auth) and guarded so the store works even if sync isn't wired.
// ponytail: single choke point — every durable write funnels through here, not each IPC caller.
function syncPush(id) {
  if (syncSuppressed) return; // don't echo writes that sync itself just applied
  Promise.resolve().then(async () => {
    const m = await getMeeting(id);
    if (m) await require('./sync').pushMeeting(m);
  }).catch((e) => console.warn('[store] sync push:', e.message));
}
function syncDelete(id) {
  if (syncSuppressed) return;
  Promise.resolve().then(() => require('./sync').deleteMeeting(id)).catch((e) => console.warn('[store] sync delete:', e.message));
}

// Raw accessors used by sync.js — no filtering/sorting, and no sync echo.
let syncSuppressed = false;
async function loadAllRaw() {
  const { meetings } = await getFile().read();
  return meetings;
}
async function getMeetingRaw(id) { return getMeeting(id); }
// Insert-or-replace by id from the server pull; suppressed so it doesn't re-push.
async function putRaw(meeting) {
  syncSuppressed = true;
  try {
    await getFile().update((data) => {
      const i = data.meetings.findIndex((m) => m.id === meeting.id);
      if (i >= 0) data.meetings[i] = { ...data.meetings[i], ...meeting };
      else data.meetings.push(meeting);
    });
  } finally { syncSuppressed = false; }
}

async function loadMeetings() {
  const { meetings } = await getFile().read();
  return meetings.filter((m) => !m.deletedAt).sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function loadTrash() {
  const { meetings } = await getFile().read();
  return meetings.filter((m) => m.deletedAt).sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
}

async function getMeeting(id) {
  const { meetings } = await getFile().read();
  return meetings.find((m) => m.id === id) || null;
}

// Insert or replace by recordingId — dedups re-runs of the pipeline.
async function upsertMeeting(meeting) {
  await getFile().update((data) => {
    const i = data.meetings.findIndex((m) => m.recordingId === meeting.recordingId);
    const now = new Date().toISOString();
    if (i >= 0) data.meetings[i] = { ...data.meetings[i], ...meeting, updatedAt: now };
    else data.meetings.push({ ...meeting, createdAt: now, updatedAt: now });
  });
  syncPush(meeting.id);
  return getMeeting(meeting.id);
}

async function updateMeeting(id, patch) {
  await getFile().update((data) => {
    const m = data.meetings.find((x) => x.id === id);
    if (m) Object.assign(m, patch, { updatedAt: new Date().toISOString() });
  });
  syncPush(id); // covers softDelete (deletedAt) and restore, which route through here
  return getMeeting(id);
}

async function softDelete(id) {
  return updateMeeting(id, { deletedAt: new Date().toISOString() });
}

async function restore(id) {
  await getFile().update((data) => {
    const m = data.meetings.find((x) => x.id === id);
    if (m) { delete m.deletedAt; m.updatedAt = new Date().toISOString(); }
  });
  syncPush(id);
  return getMeeting(id);
}

async function deletePermanent(id, recordingsDir) {
  await getFile().update((data) => {
    data.meetings = data.meetings.filter((m) => m.id !== id);
  });
  syncDelete(id); // hard-delete server-side (soft delete syncs via deletedAt instead)
  if (recordingsDir) {
    await fsp.rm(path.join(recordingsDir, id), { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { loadMeetings, loadTrash, getMeeting, upsertMeeting, updateMeeting, softDelete, restore, deletePermanent, loadAllRaw, getMeetingRaw, putRaw };
