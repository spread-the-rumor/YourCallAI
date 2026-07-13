// Electron main: orchestrates settings/config, backend, detector, recorder window,
// recording state, the post-recording pipeline, persistence, and all IPC (§3.1).
// CRITICAL: never process.exit / throw at module load — missing keys degrade per-feature.
const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog, shell, screen, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

if (require('electron-squirrel-startup')) app.quit();

const store = require('./store');
const settingsStore = require('./settingsStore');
const server = require('./server');
const detector = require('./detector');
const { startNameAgent } = require('./agents');
const { transcribeRecording } = require('./transcribe');
const { alignSpeakers } = require('./align');
const { summarizeTranscript, summaryFailed } = require('./ai/summarize');
const { askMeeting } = require('./ai/chat');
const { extractActionItems } = require('./ai/extractActionItems');
const { inferSpeakerNames } = require('./ai/inferSpeakerNames');
const slack = require('./integrations/slack');
const getoverview = require('./integrations/getoverview');
const auth = require('./auth');
const sync = require('./sync');
const { transcriptToText, segSpeaker, segText, meetingDate } = require('./transcriptUtils');

// Webpack magic constants (injected by @electron-forge/plugin-webpack)
/* global MAIN_WINDOW_WEBPACK_ENTRY, MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
   POPUP_WINDOW_WEBPACK_ENTRY, POPUP_WINDOW_PRELOAD_WEBPACK_ENTRY,
   RECORDER_WINDOW_WEBPACK_ENTRY, RECORDER_WINDOW_PRELOAD_WEBPACK_ENTRY */

let mainWindow = null;
let popupWindow = null;
let recorderWindow = null;
let recordingsDir = null;
let detectorHandle = null;
let pendingMeeting = null;   // { platform, title } while a meeting is detected
let quitting = false;

// Active recording state
let rec = null; // { id, dir, meta, videoStream, audioStream, speakersStream, agent, stopResolve }
const pipelineRunning = new Set();

// ---------- helpers ----------

const nowIso = () => new Date().toISOString();
const rid = () => `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

function emitStatus(state, detail = '') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', { state, detail });
  }
}
function emitProgress(recordingId, stage, detail = '') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcribe-progress', { recordingId, stage, detail });
  }
}
// state ∈ 'syncing' | 'synced' | 'error'. 'synced' = this run didn't throw
// (offline queue may still hold items). auth.js emits the same channel on login/startup sync.
function emitSyncStatus(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-status', { state });
  }
}

async function readMeta(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); }
  catch { return null; }
}
async function patchMeta(dir, patch) {
  const meta = (await readMeta(dir)) || {};
  Object.assign(meta, patch);
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

// ---------- windows ----------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1C1C1C',
    // Dev-only taskbar icon; packaged app gets its icon from forge packagerConfig.
    ...(app.isPackaged ? {} : { icon: path.join(process.cwd(), 'assets', 'icon.png') }),

    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  // Anchor tags with target=_blank (video playback link) → default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 360,
    height: 96,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: POPUP_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  popupWindow.loadURL(POPUP_WINDOW_WEBPACK_ENTRY);
  popupWindow.on('closed', () => { popupWindow = null; });
}

function showPopup(info) {
  if (!popupWindow || popupWindow.isDestroyed()) createPopupWindow();
  const { workArea } = screen.getPrimaryDisplay();
  popupWindow.setPosition(workArea.x + workArea.width - 376, workArea.y + 16);
  popupWindow.webContents.send('meeting-info', info);
  popupWindow.showInactive();
}
function hidePopup() {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
}

function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: RECORDER_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // or capture stalls when the app is minimized
    },
  });
  recorderWindow.loadURL(RECORDER_WINDOW_WEBPACK_ENTRY);
  recorderWindow.on('closed', () => { recorderWindow = null; });
  return recorderWindow;
}

// ---------- macOS permissions (§12) ----------

async function ensureMacPermissions() {
  if (process.platform !== 'darwin') return { ok: true };
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      if (!granted) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
        return { ok: false, error: 'Microphone permission required — enable it in System Settings, then retry.' };
      }
    }
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return { ok: false, error: 'Screen Recording permission required — enable it in System Settings, then retry.' };
    }
  } catch (err) {
    console.warn('[permissions]', err.message);
  }
  return { ok: true };
}

// ---------- recording ----------

async function checkDiskSpace() {
  try {
    const s = await fsp.statfs(app.getPath('userData'));
    if (s.bsize * s.bavail < 5 * 1024 ** 3) {
      emitStatus('recording', 'Warning: less than 5 GB free disk space');
    }
  } catch { /* statfs unsupported — skip the warning */ }
}

async function startRecording(source, platform = '', title = '') {
  if (rec) return { ok: false, error: 'Already recording.' };
  const perms = await ensureMacPermissions();
  if (!perms.ok) { emitStatus('error', perms.error); return perms; }

  const id = rid();
  const dir = path.join(recordingsDir, id);
  await fsp.mkdir(dir, { recursive: true });
  const meta = {
    id, startedAt: nowIso(), endedAt: null, status: 'recording',
    source, platform: platform || null, title: title || null,
  };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  rec = {
    id, dir, meta,
    videoStream: fs.createWriteStream(path.join(dir, 'video.webm')),
    audioStream: fs.createWriteStream(path.join(dir, 'audio.webm')),
    speakersStream: fs.createWriteStream(path.join(dir, 'speakers.jsonl'), { flags: 'a' }),
    agent: null,
    stopResolve: null,
  };
  rec.agent = startNameAgent(platform || 'auto', (line) => {
    if (rec && rec.id === id) rec.speakersStream.write(line + '\n');
  });

  const win = createRecorderWindow();
  win.webContents.once('did-finish-load', () => win.webContents.send('start-capture'));

  hidePopup();
  emitStatus('recording', platform ? `Recording ${platform}` : 'Recording huddle');
  checkDiskSpace();
  return { ok: true, recordingId: id };
}

function closeStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed) return resolve();
    stream.end(resolve);
  });
}

async function finalizeRecording(failedMessage = null) {
  if (!rec) return null;
  const current = rec;
  rec = null;
  current.agent?.stop();
  await Promise.all([
    closeStream(current.videoStream),
    closeStream(current.audioStream),
    closeStream(current.speakersStream),
  ]);
  await patchMeta(current.dir, {
    endedAt: nowIso(),
    status: failedMessage ? 'failed' : 'recorded',
    ...(failedMessage ? { error: failedMessage } : {}),
  });
  if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.destroy();
  return current.id;
}

async function stopRecording() {
  if (!rec) return { ok: false, error: 'Not recording.' };
  const stopped = new Promise((resolve) => { rec.stopResolve = resolve; });
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('stop-capture');
  }
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 10000))]);
  const id = await finalizeRecording();
  emitStatus('processing', 'Recording saved — transcribing…');
  if (id && !quitting) runPipeline(id); // fire-and-forget; queue recovers it on next launch otherwise
  return { ok: true, recordingId: id };
}

ipcMain.on('capture-chunk', (e, { rec: which, buf }) => {
  if (!rec) return;
  const stream = which === 'video' ? rec.videoStream : rec.audioStream;
  try { stream.write(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }
  catch (err) { console.error('[capture] chunk write failed:', err.message); }
});
ipcMain.on('capture-stopped', () => { rec?.stopResolve?.(); });
ipcMain.on('capture-error', async (e, message) => {
  console.error('[capture]', message);
  await finalizeRecording(message);
  emitStatus('error', message);
});

// ---------- post-recording pipeline (§11) ----------

function buildTitle(dateIso) {
  const d = new Date(dateIso);
  return `Meeting · ${d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })}`;
}

async function runPipeline(recordingId) {
  if (pipelineRunning.has(recordingId)) return;
  pipelineRunning.add(recordingId);
  const dir = path.join(recordingsDir, recordingId);
  try {
    const meta = await readMeta(dir);
    if (!meta) return;

    await patchMeta(dir, { status: 'transcribing' });
    emitStatus('transcribing', 'Transcribing with Deepgram…');
    emitProgress(recordingId, 'transcribing');

    let transcript = null;
    let transcribeError = null;
    try {
      transcript = await transcribeRecording(dir, meta.startedAt);
    } catch (err) {
      transcribeError = err.message;
      console.error('[pipeline] transcription failed:', err.message);
      await patchMeta(dir, { status: 'failed', error: err.message });
    }

    let summary;
    if (transcript) {
      // §7 Layer 1: native-agent alignment; Layer 2: AI inference for leftovers
      emitProgress(recordingId, 'resolving-names');
      const { roster } = alignSpeakers(transcript, path.join(dir, 'speakers.jsonl'));
      const inferred = await inferSpeakerNames(transcript, roster);
      for (const seg of transcript) {
        if (inferred[seg.speaker]) seg.speaker = inferred[seg.speaker];
      }
      await fsp.writeFile(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 2));

      emitStatus('processing', 'Generating summary…');
      emitProgress(recordingId, 'summarizing');
      summary = await summarizeTranscript(transcript, (delta) =>
        emitProgress(recordingId, 'summarizing', delta));
      await patchMeta(dir, { status: 'complete' });
    } else {
      summary = `Summary unavailable — transcription failed (${transcribeError}). Use Retry transcription.`;
    }

    const date = meetingDate(transcript) || meta.startedAt;
    const existing = await store.getMeeting(recordingId);
    const meeting = {
      id: recordingId,
      recordingId,
      title: existing?.title || buildTitle(date),
      date,
      content: existing?.content && existing.content !== existing.summary ? existing.content : summary,
      summary,
      transcript,
      videoUrl: `http://localhost:${server.PORT}/recordings/${recordingId}/video.webm`,
      transcriptUrl: transcript ? `http://localhost:${server.PORT}/recordings/${recordingId}/transcript.json` : null,
      speakerMap: existing?.speakerMap || {},
      chat: existing?.chat || [],
    };

    // Persist BEFORE forwarding; if the disk write fails, still forward the in-memory meeting.
    let saved = meeting;
    try { saved = await store.upsertMeeting(meeting); }
    catch (err) { console.error('[pipeline] persist failed:', err.message); }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-complete', saved);
    }
  } catch (err) {
    console.error('[pipeline] fatal:', err);
    await patchMeta(dir, { status: 'failed', error: err.message }).catch(() => {});
  } finally {
    pipelineRunning.delete(recordingId);
    emitStatus(rec ? 'recording' : 'idle');
  }
}

// ---------- launch recovery, requeue, retention (§5, §11) ----------

async function recoverAndRequeue() {
  let entries = [];
  try { entries = await fsp.readdir(recordingsDir); } catch { return; }
  const interrupted = [];
  const requeue = [];
  for (const id of entries) {
    const meta = await readMeta(path.join(recordingsDir, id));
    if (!meta) continue;
    if (meta.status === 'recording') {
      await patchMeta(path.join(recordingsDir, id), { status: 'interrupted', endedAt: meta.endedAt || nowIso() });
      interrupted.push(id);
    } else if (['recorded', 'transcribing', 'failed'].includes(meta.status)) {
      requeue.push(id);
    }
  }
  if (interrupted.length) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Recover', 'Later'],
      defaultId: 0,
      message: `${interrupted.length} interrupted recording(s) found`,
      detail: 'The app closed while recording. Partial recordings can still be transcribed. Recover now?',
    });
    if (response === 0) requeue.push(...interrupted);
  }
  if (requeue.length && process.env.DEEPGRAM_API_KEY) {
    for (const id of requeue) runPipeline(id);
  }
}

async function retentionSweep() {
  const days = Number(process.env.AUTO_DELETE_DAYS) || 0;
  if (!days) return;
  const cutoff = Date.now() - days * 86400_000;
  const meetings = await store.loadMeetings().catch(() => []);
  for (const m of meetings) {
    if (m.videoUrl && new Date(m.date).getTime() < cutoff) {
      const dir = path.join(recordingsDir, m.recordingId);
      await fsp.rm(path.join(dir, 'video.webm'), { force: true }).catch(() => {});
      await fsp.rm(path.join(dir, 'audio.webm'), { force: true }).catch(() => {});
      await store.updateMeeting(m.id, { videoUrl: null });
    }
  }
}

// ---------- IPC: meetings ----------

ipcMain.handle('list-meetings', () => store.loadMeetings());
ipcMain.handle('update-meeting', (e, id, patch) => {
  const allowed = {};
  for (const k of ['title', 'content', 'chat']) if (k in (patch || {})) allowed[k] = patch[k];
  return store.updateMeeting(id, allowed);
});
ipcMain.handle('delete-meeting', (e, id) => store.softDelete(id));
ipcMain.handle('list-trash', () => store.loadTrash());
ipcMain.handle('restore-meeting', (e, id) => store.restore(id));
ipcMain.handle('delete-meeting-permanent', async (e, id) => {
  await store.deletePermanent(id, recordingsDir);
  return { ok: true };
});

ipcMain.handle('ask-meeting', async (e, id, question) => {
  const meeting = await store.getMeeting(id);
  if (!meeting) return { answer: 'Meeting not found.' };
  const answer = await askMeeting(meeting.transcript, meeting.chat, question);
  const chat = [...(meeting.chat || []), { role: 'user', content: question }, { role: 'assistant', content: answer }];
  await store.updateMeeting(id, { chat });
  return { answer };
});

ipcMain.handle('regenerate-summary', async (e, id) => {
  const meeting = await store.getMeeting(id);
  if (!meeting?.transcript) return { ok: false, error: 'No transcript to summarize.' };
  const summary = await summarizeTranscript(meeting.transcript);
  if (summaryFailed(summary)) return { ok: false, error: summary };
  const updated = await store.updateMeeting(id, { content: summary, summary });
  return { ok: true, meeting: updated };
});

ipcMain.handle('retry-transcription', async (e, id) => {
  runPipeline(id);
  return { ok: true };
});

ipcMain.handle('rename-speaker', async (e, id, channel, diarizedSpeaker, newName) => {
  const meeting = await store.getMeeting(id);
  if (!meeting?.transcript) return { ok: false, error: 'No transcript.' };
  const name = String(newName || '').trim();
  if (!name) return { ok: false, error: 'Name is empty.' };
  const transcript = meeting.transcript.map((seg) =>
    seg.channel === channel && seg.diarizedSpeaker === diarizedSpeaker ? { ...seg, speaker: name } : seg);
  const speakerMap = { ...(meeting.speakerMap || {}), [`${channel}:${diarizedSpeaker}`]: name };
  const updated = await store.updateMeeting(id, { transcript, speakerMap });
  return { ok: true, meeting: updated };
});

// ---------- IPC: recording controls ----------

ipcMain.handle('start-huddle', () => startRecording('huddle'));
ipcMain.handle('stop-recording', () => stopRecording());
ipcMain.handle('start-detected-recording', () =>
  startRecording('detected', pendingMeeting?.platform, pendingMeeting?.title));
ipcMain.handle('dismiss-detected-meeting', () => { hidePopup(); return { ok: true }; });
ipcMain.on('popup-start-recording', () => {
  startRecording('detected', pendingMeeting?.platform, pendingMeeting?.title);
});
ipcMain.on('popup-dismiss', () => hidePopup());

// ---------- IPC: integrations ----------

ipcMain.handle('send-to-slack', (e, target, text) => slack.sendToSlack(target, text));
ipcMain.handle('list-slack-channels', () => slack.listSlackChannels());
ipcMain.handle('list-slack-users', () => slack.listSlackUsers());
ipcMain.handle('slack-connect', () => slack.connect());
ipcMain.handle('slack-disconnect', () => slack.disconnect());
ipcMain.handle('slack-status', () => slack.isConnected());
ipcMain.handle('list-getoverview-projects', () => getoverview.listProjects());
ipcMain.handle('create-getoverview-task', (e, projectId, task) => getoverview.createTask(projectId, task));
ipcMain.handle('send-getoverview-transcript', async (e, projectId, meetingId, kind) => {
  const meeting = await store.getMeeting(meetingId);
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  const text = kind === 'transcript'
    ? transcriptToText(meeting.transcript)
    : (meeting.content || meeting.summary || '');
  if (!text.trim()) return { ok: false, error: `No ${kind} to send.` };
  return getoverview.sendTranscript(projectId, { title: meeting.title, text });
});
ipcMain.handle('extract-action-items', async (e, meetingId) => {
  const meeting = await store.getMeeting(meetingId);
  if (!meeting?.transcript) return { items: [], error: 'No transcript.' };
  return extractActionItems(meeting.transcript);
});

// ---------- IPC: export / save ----------

ipcMain.handle('save-transcript', async (e, meetingId, format) => {
  const meeting = await store.getMeeting(meetingId);
  if (!meeting?.transcript) return { ok: false, error: 'No transcript.' };
  const ext = format === 'json' ? 'json' : 'txt';
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${meeting.title.replace(/[\\/:*?"<>|·]/g, '-')}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const body = ext === 'json'
    ? JSON.stringify(meeting.transcript, null, 2)
    : meeting.transcript.map((s) => `${segSpeaker(s)}: ${segText(s)}`).join('\n');
  await fsp.writeFile(filePath, body, 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('save-recording', async (e, meetingId) => {
  const meeting = await store.getMeeting(meetingId);
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  const src = path.join(recordingsDir, meeting.recordingId, 'video.webm');
  try { await fsp.access(src); } catch { return { ok: false, error: 'Recording file not found (may have been auto-deleted).' }; }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${meeting.title.replace(/[\\/:*?"<>|·]/g, '-')}.webm`,
    filters: [{ name: 'WebM video', extensions: ['webm'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  // Stream to disk — never buffer the whole file in memory.
  try {
    await new Promise((resolve, reject) => {
      fs.createReadStream(src).on('error', reject)
        .pipe(fs.createWriteStream(filePath))
        .on('finish', resolve).on('error', reject);
    });
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC: settings / app ----------

ipcMain.handle('get-settings', () => settingsStore.getSettings());
ipcMain.handle('save-settings', async (e, patch) => {
  const saved = await settingsStore.saveSettings(patch);
  retentionSweep();
  return saved;
});
ipcMain.handle('get-effective-config', () => settingsStore.getConfiguredFlags());
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('restart-app', () => { app.relaunch(); app.exit(0); });

ipcMain.handle('auth-sign-in', () => auth.signIn());
ipcMain.handle('auth-sign-out', () => auth.signOut());
ipcMain.handle('auth-get-user', () => ({ enabled: auth.enabled(), user: auth.getUser() }));
ipcMain.handle('sync-now', async () => {
  emitSyncStatus('syncing');
  try { await sync.fullSync(); emitSyncStatus('synced'); return { ok: true }; }
  catch (e) { emitSyncStatus('error'); return { ok: false, error: e.message }; }
});

// ---------- app lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Route a yourcallai:// deep link to Slack (host === 'slack') or Supabase auth (everything else).
  const routeDeepLink = (url) => {
    if (url.startsWith(`${auth.PROTOCOL}://slack`)) return slack.handleDeepLink(url);
    return auth.handleDeepLink(url);
  };

  app.on('second-instance', (e, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    // Windows/Linux deliver the yourcallai:// deep link as an argv on the relaunch.
    const link = argv.find((a) => a.startsWith(`${auth.PROTOCOL}://`));
    if (link) routeDeepLink(link);
  });

  // macOS delivers the deep link via open-url.
  app.on('open-url', (e, url) => { e.preventDefault(); routeDeepLink(url); });

  app.whenReady().then(async () => {
    await settingsStore.applyToEnv().catch((e) => console.error('[settings]', e.message));
    settingsStore.fetchTeamDefaults().then(() => settingsStore.applyToEnv()).catch(() => {});

    recordingsDir = path.join(app.getPath('userData'), 'recordings');
    await fsp.mkdir(recordingsDir, { recursive: true }).catch(() => {});

    // Capture plumbing must exist before the recorder window ever asks (§5)
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      }).catch((err) => {
        console.error('[capture] getSources failed:', err.message);
        callback({});
      });
    }, { useSystemPicker: false });
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(['media', 'display-capture', 'mediaKeySystem'].includes(permission));
    });

    await server.start(recordingsDir);
    createMainWindow();
    createPopupWindow();

    detectorHandle = detector.start({
      onDetected: (info) => {
        if (rec) return; // already recording — don't re-announce
        pendingMeeting = info;
        showPopup(info);
        emitStatus('meeting-detected', info.title);
      },
      onClosed: () => {
        pendingMeeting = null;
        hidePopup();
        if (rec?.meta.source === 'detected') {
          stopRecording().catch((e) => console.error('[detector] auto-stop failed:', e.message));
        } else if (!rec) {
          emitStatus('idle');
        }
      },
    });

    if (app.isPackaged) {
      try { require('update-electron-app').updateElectronApp(); }
      catch (err) { console.warn('[updates]', err.message); }
    }

    recoverAndRequeue().catch((e) => console.error('[recover]', e.message));
    retentionSweep().catch((e) => console.error('[retention]', e.message));
    auth.init().catch((e) => console.error('[auth]', e.message)); // restore session + sync if signed in
  });

  app.on('before-quit', async (e) => {
    if (rec && !quitting) {
      e.preventDefault();
      quitting = true;
      try { await stopRecording(); } catch (err) { console.error('[quit]', err.message); }
      app.quit(); // transcription resumes on next launch via the requeue
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWindow?.show();
  });
}
