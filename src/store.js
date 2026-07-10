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
  return getMeeting(meeting.id);
}

async function updateMeeting(id, patch) {
  await getFile().update((data) => {
    const m = data.meetings.find((x) => x.id === id);
    if (m) Object.assign(m, patch, { updatedAt: new Date().toISOString() });
  });
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
  return getMeeting(id);
}

async function deletePermanent(id, recordingsDir) {
  await getFile().update((data) => {
    data.meetings = data.meetings.filter((m) => m.id !== id);
  });
  if (recordingsDir) {
    await fsp.rm(path.join(recordingsDir, id), { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { loadMeetings, loadTrash, getMeeting, upsertMeeting, updateMeeting, softDelete, restore, deletePermanent };
