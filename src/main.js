// Electron main: orchestrates settings/config, backend, detector, recorder window,
// recording state, the post-recording pipeline, persistence, and all IPC (§3.1).
// CRITICAL: never process.exit / throw at module load — missing keys degrade per-feature.
const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog, shell, screen, systemPreferences, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

if (require('electron-squirrel-startup')) app.quit();

const store = require('./store');
const settingsStore = require('./settingsStore');
const server = require('./server');
const media = require('./media');
const normalize = require('./normalize');
const detector = require('./detector');
const { startNameAgent } = require('./agents');
const audioEndpoints = require('./audioEndpoints');
const { transcribeRecording } = require('./transcribe');
const { alignSpeakers } = require('./align');
const { mergeRoster } = require('./roster');
const { resolveSpeakers, readSpeakerMap, sampleFor } = require('./speakerResolve');
const { summarizeTranscript, summaryFailed } = require('./ai/summarize');
const { askMeeting } = require('./ai/chat');
const { extractActionItems } = require('./ai/extractActionItems');
const { inferSpeakerNames } = require('./ai/inferSpeakerNames');
const slack = require('./integrations/slack');
const getoverview = require('./integrations/getoverview');
const asana = require('./integrations/asana');
const auth = require('./auth');
const sync = require('./sync');
const { transcriptToText, segSpeaker, segText, meetingDate } = require('./transcriptUtils');

// Webpack magic constants (injected by @electron-forge/plugin-webpack)
/* global MAIN_WINDOW_WEBPACK_ENTRY, MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
   POPUP_WINDOW_WEBPACK_ENTRY, POPUP_WINDOW_PRELOAD_WEBPACK_ENTRY,
   RECORDER_WINDOW_WEBPACK_ENTRY, RECORDER_WINDOW_PRELOAD_WEBPACK_ENTRY */

let mainWindow = null;
let popupWindow = null;
let popupReady = false;      // popup webContents finished loading (guards the content race)
let pendingPopupInfo = null; // info to send once the popup is ready
let recorderWindow = null;
let recordingsDir = null;
let detectorHandle = null;
let pendingMeeting = null;   // { platform, title } while a meeting is detected
let quitting = false;

// Active recording state
let rec = null; // { id, dir, meta, videoStream, audioStream, speakersStream, agent, stopResolve }
const pipelineRunning = new Set();

// Composite liveness: last time the recorder reported meeting audio, and the cancelable
// "meeting ended" countdown. isAudioActive() is one of the detector's keep-alive signals.
let lastFarEndSoundTs = 0;
let pendingStop = null; // { timer, watch } while the ending countdown runs
const AUDIO_ACTIVE_MS = 20000;
const STOP_COUNTDOWN_MS = 15000;
const isAudioActive = () => !!rec && (Date.now() - lastFarEndSoundTs < AUDIO_ACTIVE_MS);

// Health-monitor watchdog. lastTickTs is stamped by every 'capture-alive'; if those stop while
// a recording is live, the renderer's monitor (and therefore every capture detector) is gone.
let lastTickTs = 0;
let monitorWatchdog = null;
let monitorDeadReported = false;
// 45s, not 15s. Measured across 23 real recordings on this machine, the gap between
// startRecording() and the renderer's first capture event reached 15.9s on a cold start
// (window creation + getUserMedia + the 400ms profile-settle + getDisplayMedia). A 15s
// threshold therefore false-alarms on a slow but perfectly healthy start, and a warning the
// user learns to dismiss is worse than no warning. 45s is ~3x the measured worst case and
// still catches a dead monitor inside the first minute.
const MONITOR_DEAD_MS = 45000;
const PLATFORM_LABELS = { 'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' };

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
  popupReady = false;
  popupWindow = new BrowserWindow({
    width: 380,
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
  // Appear on whatever virtual desktop / fullscreen space the user is currently in.
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popupWindow.loadURL(POPUP_WINDOW_WEBPACK_ENTRY);
  // Content race: don't send until the renderer is listening, or it shows the "—" placeholder.
  popupWindow.webContents.on('did-finish-load', () => {
    popupReady = true;
    if (pendingPopupInfo && popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('popup-show', pendingPopupInfo);
      pendingPopupInfo = null;
    }
  });
  popupWindow.on('closed', () => { popupWindow = null; popupReady = false; });
}

// info = { kind: 'detected' | 'silence' | 'ending', platform, title, seconds }
function showPopup(info) {
  if (!popupWindow || popupWindow.isDestroyed()) createPopupWindow();
  // Position on the display nearest the cursor, not always the primary monitor.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  popupWindow.setPosition(workArea.x + workArea.width - 396, workArea.y + 16);
  if (popupReady) popupWindow.webContents.send('popup-show', info);
  else pendingPopupInfo = info;
  popupWindow.showInactive();
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  popupWindow.moveTop();
  notify(info); // native toast — reliable even when the popup lands on another desktop
}
function hidePopup() {
  pendingPopupInfo = null;
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
}

// Native OS notification as a cross-desktop / fullscreen safety net for the popup.
function notify(info) {
  try {
    if (!Notification.isSupported()) return;
    const platform = PLATFORM_LABELS[info.platform] || info.platform || 'Meeting';
    let title, body;
    if (info.kind === 'silence') { title = 'Still recording?'; body = 'No one has spoken for 30s — open Your Call AI to stop.'; }
    else if (info.kind === 'ending') { title = 'Meeting ended'; body = 'Stopping the recording shortly…'; }
    else if (info.kind === 'capture-degraded') {
      title = info.videoDead ? 'Video capture problem' : 'Audio capture problem';
      body = info.videoDead ? 'The screen video isn’t being recorded — audio and transcript are unaffected.'
        : info.micDead && info.sysDead ? 'No audio is reaching the recorder — still recording.'
          : info.sysDead ? 'Meeting audio isn’t being captured — still recording.'
            : 'Your microphone isn’t being captured — still recording.';
    }
    else if (info.kind === 'capture-endpoint-switched') {
      title = 'Meeting audio recovered';
      body = `Switched Windows output to ${info.deviceName} — still recording.`;
    }
    else { title = 'Meeting detected'; body = `${platform} — open Your Call AI to start recording.`; }
    const n = new Notification({ title, body });
    n.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
    n.show();
  } catch { /* toast unsupported — in-app popup + status still cover it */ }
}

// Cancelable "meeting ended" auto-stop (user chose a countdown over a silent stop).
function beginPendingStop() {
  if (pendingStop || !rec) return;
  showPopup({ kind: 'ending', platform: rec.meta.platform, title: rec.meta.title, seconds: STOP_COUNTDOWN_MS / 1000 });
  const timer = setTimeout(() => {
    clearInterval(pendingStop.watch);
    pendingStop = null;
    hidePopup();
    stopRecording().catch((e) => console.error('[detector] auto-stop failed:', e.message));
  }, STOP_COUNTDOWN_MS);
  // If meeting audio returns mid-countdown, the meeting didn't really end — cancel.
  const watch = setInterval(() => { if (isAudioActive()) cancelPendingStop('audio resumed'); }, 1000);
  pendingStop = { timer, watch };
}
function cancelPendingStop(reason) {
  if (!pendingStop) return;
  clearTimeout(pendingStop.timer);
  clearInterval(pendingStop.watch);
  pendingStop = null;
  hidePopup();
  console.warn('[detector] pending stop canceled:', reason);
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
  cancelPendingStop('new recording');
  // A transcode saturating the CPU during capture drops video frames and can glitch the WASAPI
  // loopback — that would trade a cosmetic seeking problem for a corrupted recording. The queue
  // resumes in stopRecording; the source file is untouched so the work is never lost.
  normalize.pauseForRecording();
  lastFarEndSoundTs = Date.now(); // assume the meeting is live at the moment we start

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
    // videoStream stays null until 'capture-format' tells us which container MediaRecorder
    // actually chose — the filename depends on it (capture.mp4 / .mkv / .webm) and only the
    // renderer knows. 'capture-chunk' opens it lazily as a backstop; the first chunk is a
    // whole timeslice away, so the format message always wins the race in practice.
    videoStream: null,
    videoFile: null,
    audioStream: openRecStream(dir, media.AUDIO_NAME),
    speakersStream: openRecStream(dir, 'speakers.jsonl', { flags: 'a' }),
    captureStream: openRecStream(dir, 'capture.jsonl', { flags: 'a' }),
    agent: null,
    stopResolve: null,
  };
  rec.agent = startNameAgent(platform || 'auto', (line) => {
    if (rec && rec.id === id) rec.speakersStream.write(line + '\n');
  });

  const win = createRecorderWindow();
  win.webContents.once('did-finish-load', () => win.webContents.send('start-capture', {
    forceVideoMime: process.env.YCAI_FORCE_VIDEO_MIME || '',
  }));

  hidePopup();
  emitStatus('recording', platform ? `Recording ${platform}` : 'Recording huddle');
  checkDiskSpace();
  // Armed here rather than on the first tick: if the renderer never starts its monitor at all
  // (window failed to load, capture threw during setup), that is exactly the silent failure
  // this is meant to catch, and waiting for a first tick would mean waiting forever.
  startMonitorWatchdog();
  return { ok: true, recordingId: id };
}

// A WriteStream that emits 'error' with no listener throws an uncaught exception in the MAIN
// process — the app dies mid-recording and takes the audio with it. The try/catch around
// stream.write() does NOT cover this: fs stream write errors surface asynchronously via the
// event, not from the write call. Disk-full is the realistic trigger, and video normalization
// doubles peak disk use, so guard every stream rather than only the new one.
function openRecStream(dir, name, opts) {
  const s = fs.createWriteStream(path.join(dir, name), opts);
  s.on('error', (err) => {
    console.error(`[capture] ${name} write failed:`, err.message);
    if (!rec || rec.dir !== dir) return;
    const full = err.code === 'ENOSPC';
    patchMeta(dir, { captureHealth: { streamError: `${name}: ${err.message}`, at: nowIso() } }).catch(() => {});
    // Warn, never finalize — the other streams may still be writing fine (same contract as
    // capture-degraded).
    emitStatus('recording', full ? `⚠ Disk full — ${name} stopped recording` : `⚠ Cannot write ${name}`);
  });
  return s;
}

function closeStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed) return resolve();
    stream.end(resolve);
  });
}

// A minimal, always-persistable meeting record with a playable video and no transcript yet.
// runPipeline later updates this same record; the id/recordingId/title/date match what the
// pipeline produces (buildTitle from the recording date) so the later write doesn't drift.
function buildPlaceholderMeeting(id, meta, failedMessage) {
  const date = meta?.startedAt || nowIso();
  const summary = failedMessage
    ? `Recording saved. Transcription failed — ${failedMessage}. Use Retry transcription.`
    : 'Recording saved. Transcript and summary are being generated…';
  return {
    id,
    recordingId: id,
    title: buildTitle(date),
    date,
    content: summary,
    summary,
    transcript: null,
    videoUrl: media.mediaUrl(id, path.join(recordingsDir, id)),
    transcriptUrl: null,
    speakerMap: {},
    chat: [],
  };
}

// Starts the health-monitor watchdog. Separate from the capture detectors on purpose: those
// all live in the renderer, so they cannot report their own death. This runs in main.
function startMonitorWatchdog() {
  clearInterval(monitorWatchdog);
  lastTickTs = Date.now();
  monitorDeadReported = false;
  monitorWatchdog = setInterval(() => {
    if (!rec || monitorDeadReported) return;
    if (Date.now() - lastTickTs < MONITOR_DEAD_MS) return;
    monitorDeadReported = true; // once per recording; the user gets one popup, not one a second
    const detail = 'Capture health monitor stopped — recording may be incomplete';
    appendCaptureDiag({ type: 'monitor-dead', sinceMs: Date.now() - lastTickTs });
    patchMeta(rec.dir, { captureHealth: { monitorDead: true, at: nowIso() } }).catch(() => {});
    emitStatus('recording', `⚠ ${detail}`);
    showPopup({ kind: 'capture-degraded', micDead: true, sysDead: true, reason: 'monitor-dead',
      platform: rec.meta.platform, title: rec.meta.title });
  }, 5000);
}
function stopMonitorWatchdog() {
  clearInterval(monitorWatchdog);
  monitorWatchdog = null;
}

async function finalizeRecording(failedMessage = null) {
  if (!rec) return null;
  stopMonitorWatchdog();
  const current = rec;
  rec = null;
  current.agent?.stop();
  await Promise.all([
    closeStream(current.videoStream),
    closeStream(current.audioStream),
    closeStream(current.speakersStream),
    closeStream(current.captureStream),
  ]);
  await patchMeta(current.dir, {
    endedAt: nowIso(),
    status: failedMessage ? 'failed' : 'recorded',
    ...(failedMessage ? { error: failedMessage } : {}),
  });
  if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.destroy();

  // Persist a meeting card the instant capture stops, BEFORE the pipeline runs. This guarantees
  // the recording (and playable video) is always visible in the UI even if transcription fails or
  // the app is closed mid-pipeline. runPipeline upserts by recordingId, so it updates this record.
  try {
    const placeholder = buildPlaceholderMeeting(current.id, current.meta, failedMessage);
    const saved = await store.upsertMeeting(placeholder);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-complete', saved);
    }
  } catch (err) {
    console.error('[finalize] could not persist meeting card:', err.message);
  }

  return current.id;
}

async function stopRecording() {
  if (!rec) return { ok: false, error: 'Not recording.' };
  cancelPendingStop('recording stopped'); // clear any in-flight ending countdown
  const stopped = new Promise((resolve) => { rec.stopResolve = resolve; });
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('stop-capture');
  }
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 10000))]);
  const id = await finalizeRecording();
  // AFTER finalizeRecording, which is what clears `rec`. This used to be a setTimeout(…, 0) at
  // the top of the function, which fired during the await above — while rec was still set — so
  // drain()'s `if (isRecording()) return` swallowed it every single time and the queue this
  // recording displaced was never resumed.
  normalize.resume();
  emitStatus('processing', 'Recording saved — transcribing…');
  if (id && !quitting) runPipeline(id); // fire-and-forget; queue recovers it on next launch otherwise
  return { ok: true, recordingId: id };
}

// The renderer's chosen video mime, sent before the first chunk. Names the capture file and is
// recorded in meta.json so the normalizer knows what it is parsing and support can tell which
// codec produced any given recording.
function openVideoStream(name) {
  if (!rec || rec.videoStream) return;
  rec.videoFile = name;
  rec.videoStream = openRecStream(rec.dir, name);
}
ipcMain.on('capture-format', (e, info) => {
  if (!rec) return;
  const name = media.captureNameFor(info && info.videoMime);
  openVideoStream(name);
  patchMeta(rec.dir, { video: { mime: (info && info.videoMime) || null, file: name } }).catch(() => {});
});
ipcMain.on('capture-chunk', (e, { rec: which, buf }) => {
  if (!rec) return;
  if (which === 'video' && !rec.videoStream) openVideoStream('capture.webm');
  const stream = which === 'video' ? rec.videoStream : rec.audioStream;
  if (!stream) return; // no video encoder existed; audio-only recording
  try { stream.write(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }
  catch (err) { console.error('[capture] chunk write failed:', err.message); }
});
ipcMain.on('capture-stopped', () => { rec?.stopResolve?.(); });
ipcMain.on('capture-error', async (e, message) => {
  console.error('[capture]', message);
  await finalizeRecording(message);
  emitStatus('error', message);
});
// Recorder liveness heartbeat: meeting audio is flowing → keeps the detector's (A) signal alive.
ipcMain.on('capture-audio', (e, active) => { if (active) lastFarEndSoundTs = Date.now(); });

// Watchdog for the health monitor ITSELF, not for the audio it measures. On 2026-09-17 the
// renderer's level timer stopped at t=150s and the app recorded 46 more minutes having lost
// every detector at once — main had no way to know, because 'capture-audio' only arrives when
// there IS sound, so silence and death look identical from here. 'capture-alive' arrives every
// tick unconditionally, so its ABSENCE is unambiguous evidence the monitor died.
ipcMain.on('capture-alive', () => { lastTickTs = Date.now(); });
// 30s of no speech → ask the user whether to stop (ignored = keep recording).
ipcMain.on('capture-silence', () => {
  if (!rec || pendingStop) return; // don't overlay the "ending" countdown
  showPopup({ kind: 'silence', platform: rec.meta.platform, title: rec.meta.title });
});

// Capture diagnostics. Mirrors speakers.jsonl: append-only JSONL next to the recording, so a
// "it recorded nothing" report can be diagnosed after the fact instead of guessed at.
function appendCaptureDiag(evt) {
  if (!rec) return;
  try { rec.captureStream.write(JSON.stringify({ ts: Date.now(), ...evt }) + '\n'); }
  catch (err) { console.error('[capture] diag write failed:', err.message); }
}
ipcMain.on('capture-diag', (e, evt) => appendCaptureDiag(evt));

// A stream is dead but capture is NOT — never finalize here. Warn and keep recording: a
// half-captured meeting still transcribes (mic-only lands on ch0), a stopped one is gone.
ipcMain.on('capture-degraded', (e, info) => {
  if (!rec || pendingStop) return;
  const both = info.micDead && info.sysDead;
  // videoDead first: without this branch a dead video recorder rendered "Microphone not
  // captured", which is actively wrong and sends the user to the wrong setting.
  const detail = info.videoDead ? 'Screen video not captured — audio still recording'
    : both ? 'No audio reaching the recorder'
      : info.sysDead ? 'Meeting audio not captured' : 'Microphone not captured';
  patchMeta(rec.dir, { captureHealth: { ...info, at: nowIso() } }).catch(() => {});
  emitStatus('recording', `⚠ ${detail} — still recording`);
  showPopup({ kind: 'capture-degraded', ...info, platform: rec.meta.platform, title: rec.meta.title });
});

// The default output changed mid-recording. WASAPI does not follow it, so the loopback may now
// be watching an endpoint nobody plays to — the recorder re-runs its warm-up check to find out.
ipcMain.on('capture-device-changed', () => {
  if (!rec || pendingStop) return;
  emitStatus('recording', 'Audio device changed — reconnecting…');
});

// Loopback was re-bound to the new default output and verified live. Clear the warning and
// dismiss any degraded popup: capture recovered on its own, so leaving an alarm up would lie.
ipcMain.on('capture-recovered', () => {
  if (!rec || pendingStop) return;
  patchMeta(rec.dir, { captureHealth: { recovered: true, at: nowIso() } }).catch(() => {});
  hidePopup();
  emitStatus('recording', rec.meta.platform ? `Recording ${rec.meta.platform}` : 'Recording huddle');
});

// Repeated recovery failure = the Windows default output is an endpoint nobody plays to, and the
// renderer cannot do anything about it: Chromium's loopback follows the default by construction
// (Electron exposes no way to loopback a named device). So main asks the native agent which
// endpoint is actually carrying audio and makes THAT the default. The renderer's existing
// ondevicechange listener then fires and re-binds through the normal recovery path — no new
// splice logic, and the recording never stops.
//
// Per the user's decision this is NOT restored when the recording ends: the switch stands, so the
// notification below is the only signal it happened and must name the device.
ipcMain.on('capture-switch-endpoint', async (e, info) => {
  if (!rec || pendingStop) return;
  const reason = (info && info.reason) || 'unknown';

  if (!audioEndpoints.isAvailable()) {
    appendCaptureDiag({ type: 'endpoint-switch-skipped', reason, why: 'agent-unavailable' });
    return; // the capture-degraded warning already on screen stays; nothing more we can do
  }

  let target = null;
  let current = null;
  try {
    [target, current] = await Promise.all([
      audioEndpoints.pickLiveEndpoint(),
      audioEndpoints.currentDefault(),
    ]);
  } catch (err) {
    appendCaptureDiag({ type: 'endpoint-switch-failed', reason, error: err.message });
    return;
  }

  if (!target) {
    // Nothing else is playing either. That is the honest "the meeting really is silent" answer —
    // but say WHICH device we are listening to, because "Meeting audio not captured" alone tells
    // the user nothing they can act on.
    appendCaptureDiag({ type: 'endpoint-switch-none', reason, currentDefault: current && current.name });
    if (current) {
      showPopup({
        kind: 'capture-degraded', micDead: false, sysDead: true, reason: 'no-live-endpoint',
        deviceName: current.name, platform: rec.meta.platform, title: rec.meta.title,
      });
    }
    return;
  }

  const res = await audioEndpoints.setDefaultEndpoint(target.id);
  if (!res || !res.ok) {
    appendCaptureDiag({ type: 'endpoint-switch-failed', reason, code: res && res.code, error: res && res.error });
    return;
  }

  appendCaptureDiag({
    type: 'endpoint-switched', reason,
    from: current && current.name, to: target.name, peak: target.peak,
  });
  patchMeta(rec.dir, { captureHealth: { endpointSwitched: { to: target.name, at: nowIso() } } }).catch(() => {});
  emitStatus('recording', `Switched meeting audio to ${target.name}`);
  showPopup({
    kind: 'capture-endpoint-switched',
    deviceName: target.name,
    platform: rec.meta.platform,
    title: rec.meta.title,
  });
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

    // Ensure a visible card exists before transcription — covers requeued/orphaned recordings
    // (folder on disk but no meetings.json entry) so they surface immediately, not only if the
    // pipeline reaches its final upsert. Live recordings already got this in finalizeRecording.
    if (!(await store.getMeeting(recordingId))) {
      const ph = buildPlaceholderMeeting(recordingId, meta, meta.status === 'failed' ? (meta.error || null) : null);
      const saved = await store.upsertMeeting(ph);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording-complete', saved);
    }

    // Fire-and-forget, NEVER awaited. transcribeRecording blocks on a Deepgram call that is
    // almost entirely network wait, so the conversion overlaps it for free and (on the stream-copy
    // path) is done in seconds. Not awaiting also keeps pipelineRunning meaning "expensive AI
    // work", so the 12s before-quit grace keeps its current semantics.
    normalize.enqueue(recordingId);

    await patchMeta(dir, { status: 'transcribing' });
    emitStatus('transcribing', 'Transcribing with Deepgram…');
    emitProgress(recordingId, 'transcribing');

    // The channel-0 speaker is whoever is signed in on this machine; the env var is the fallback.
    const userName = auth.getUser()?.name || process.env.USER_DISPLAY_NAME || 'You';

    let transcript = null;
    let transcribeError = null;
    try {
      transcript = await transcribeRecording(dir, meta.startedAt, userName);
    } catch (err) {
      transcribeError = err.message;
      console.error('[pipeline] transcription failed:', err.message);
      await patchMeta(dir, { status: 'failed', error: err.message });
    }

    // Carries the resolution outcome out of the `if (transcript)` block to the meeting record.
    let nameAttribution = null;
    let resolvedSpeakerMap = null;

    let summary;
    if (transcript) {
      // §7 Layer 1: native-agent alignment; Layer 2: roster-constrained AI inference;
      // then resolveSpeakers merges those with the user's prior manual renames.
      emitProgress(recordingId, 'resolving-names');
      const prior = await store.getMeeting(recordingId);
      const { roster, rosterSources, diagnostics, votes } =
        alignSpeakers(transcript, path.join(dir, 'speakers.jsonl'));
      const merged = mergeRoster([
        ...(rosterSources?.length ? rosterSources : [{ names: roster, source: 'agent-roster', confidence: 0.9 }]),
        // Prior manual renames are ground truth for who was in the room.
        { names: Object.values(readSpeakerMap(prior?.speakerMap)).map((e) => e.name), source: 'manual', confidence: 1 },
      ]);
      const inferred = await inferSpeakerNames(transcript, merged, {
        subject: meta.title || null,
        userName,
      });
      const resolved = resolveSpeakers({
        transcript,
        roster: merged,
        priorSpeakerMap: prior?.speakerMap,
        userName,
        inferred,
        alignment: votes && Object.keys(votes).length ? votes : null,
      });
      transcript = resolved.transcript;
      resolvedSpeakerMap = resolved.speakerMap;
      nameAttribution = {
        agent: diagnostics || null,
        roster: merged.map((r) => r.name),
        unresolved: resolved.unresolved,
        sources: resolved.sources,
      };
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
      videoUrl: media.mediaUrl(recordingId, dir),
      transcriptUrl: transcript ? `http://localhost:${server.PORT}/recordings/${recordingId}/transcript.json` : null,
      speakerMap: resolvedSpeakerMap || existing?.speakerMap || {},
      // Why each name was chosen, so the UI can mark low-confidence ones unverified and a support
      // question ("why is this wrong?") is answerable without re-running anything.
      nameAttribution,
      chat: existing?.chat || [],
      // This is a freshly built transcript (first run or Retry transcription), so any cached
      // action items describe the old one. Set explicitly: upsert merges, so omitting would keep them.
      actionItems: null,
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
    // Never let an IO/store throw silently discard the recording: ensure a card still exists.
    try {
      if (!(await store.getMeeting(recordingId))) {
        const meta = await readMeta(dir).catch(() => null);
        const saved = await store.upsertMeeting(buildPlaceholderMeeting(recordingId, meta, err.message));
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording-complete', saved);
      }
    } catch (e) { console.error('[pipeline] fallback persist failed:', e.message); }
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
  if (requeue.length) {
    // Auto-transcribe only when the backend actually has Deepgram configured. The key lives on
    // the Vercel proxy (never on the client), so the old `process.env.DEEPGRAM_API_KEY` gate was
    // ALWAYS false in packaged builds — recovery never ran and interrupted/failed recordings were
    // orphaned forever. Use the cached /api/config flag instead (default to attempting if unknown).
    let deepgramEnabled = true;
    try { deepgramEnabled = (await settingsStore.getConfiguredFlags()).deepgram !== false; } catch { /* assume on */ }
    if (deepgramEnabled) for (const id of requeue) runPipeline(id);
  }
}

async function retentionSweep() {
  const days = Number(process.env.AUTO_DELETE_DAYS) || 0;
  if (!days) return;
  const cutoff = Date.now() - days * 86400_000;
  const meetings = await store.loadMeetings().catch(() => []);
  for (const m of meetings) {
    if (m.videoUrl && new Date(m.date).getTime() < cutoff) {
      // An on-demand or legacy conversion targets exactly these old recordings. Deleting the
      // .part out from under a running ffmpeg fails with EBUSY on Windows and, worse, silently
      // succeeds on macOS/Linux — where ffmpeg keeps writing to the unlinked inode and the
      // finished video.mp4 reappears after retention thought it was gone.
      if (normalize.currentId() === m.recordingId) continue;
      const dir = path.join(recordingsDir, m.recordingId);
      // Every name we might have written, not just the two literals this used to delete — an
      // mp4 recording would otherwise survive AUTO_DELETE_DAYS forever.
      for (const name of media.allMediaNames()) {
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
      }
      await fsp.rm(path.join(dir, media.AUDIO_NAME), { force: true }).catch(() => {});
      await store.updateMeeting(m.id, { videoUrl: null });
    }
  }
}

// ---------- IPC: meetings ----------

// videoUrl is derived here rather than trusted from disk. It is written at three different
// points in a recording's life (placeholder, pipeline upsert, sync rehydrate) and the file it
// names can change afterwards when the normalizer swaps capture.* for video.mp4 — so the stored
// value is treated as a cache nobody reads. This makes a dead ▶ Recording link unrepresentable.
ipcMain.handle('list-meetings', async () => {
  const meetings = await store.loadMeetings();
  return meetings.map((m) => (m.recordingId
    ? { ...m, videoUrl: media.mediaUrl(m.recordingId, path.join(recordingsDir, m.recordingId)) }
    : m));
});
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
  // Pass an onDelta (even though there's no progress channel on this invoke path) so this takes
  // the streaming branch, like the live-recording call above. Buffered requests for a long
  // summary hit the Edge function's time-to-first-byte limit and come back as a 504.
  const summary = await summarizeTranscript(meeting.transcript, () => {});
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
  // Store a speech sample with the rename. Deepgram's diarized ids are not stable across runs, so
  // on Retry transcription this is what lets resolveSpeakers tell "same person, reapply the name"
  // from "different person, don't silently mislabel them".
  const speakerMap = {
    ...(meeting.speakerMap || {}),
    [`${channel}:${diarizedSpeaker}`]: {
      name,
      source: 'manual',
      confidence: 1,
      lockedByUser: true,
      sampleText: sampleFor(meeting.transcript, channel, diarizedSpeaker),
    },
  };
  // Drop cached action items — speaker names feed the assignee field, so they're now stale.
  const updated = await store.updateMeeting(id, { transcript, speakerMap, actionItems: null });
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
ipcMain.on('popup-stop-recording', () => {
  cancelPendingStop('user stopped');
  hidePopup();
  stopRecording().catch((e) => console.error('[popup] stop failed:', e.message));
});
ipcMain.on('popup-keep-recording', () => {
  if (pendingStop) cancelPendingStop('user kept recording'); // ending countdown
  else hidePopup();                                          // silence popup "keep going"
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
// Asana is task-creation only — no summary/transcript export (unlike GetOverview).
ipcMain.handle('asana-connect', () => asana.connect());
ipcMain.handle('asana-disconnect', () => asana.disconnect());
ipcMain.handle('asana-status', () => asana.isConnected());
ipcMain.handle('list-asana-workspaces', () => asana.listWorkspaces());
ipcMain.handle('list-asana-projects', (e, workspaceGid) => asana.listProjects(workspaceGid));
ipcMain.handle('list-asana-users', (e, workspaceGid) => asana.listUsers(workspaceGid));
ipcMain.handle('create-asana-task', (e, projectGid, task) => asana.createTask(projectGid, task));
// Read-through cache: extraction is a full-transcript AI call (~12s), and the renderer rebuilds
// the send panel — discarding the rows — on every destination switch. Persisting the result the
// same way `summary` and `chat` are means only the first extract costs anything.
// Invalidated wherever the transcript changes (rename-speaker, retry-transcription).
ipcMain.handle('extract-action-items', async (e, meetingId, opts = {}) => {
  const meeting = await store.getMeeting(meetingId);
  if (!meeting?.transcript) return { items: [], error: 'No transcript.' };
  if (!opts.force && meeting.actionItems) return { items: meeting.actionItems, cached: true };
  const res = await extractActionItems(meeting.transcript);
  // Only cache success — caching an { items: [], error } would make a transient AI outage sticky.
  if (!res.error) await store.updateMeeting(meetingId, { actionItems: res.items });
  return res;
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

// Hand the recording to whatever plays it best. shell.openPath gives the OS video player —
// frame stepping, playback speed, real fullscreen — but only an MP4 can rely on that: QuickTime
// and Windows Media Player refuse a live-muxed WebM outright, where a browser at least plays it.
// The choice has to live here because only main can resolve which file actually exists.
// Opt-in bulk conversion of pre-change recordings. Never automatic — see convertLegacy().
ipcMain.handle('count-legacy-recordings', () => normalize.countLegacy().catch(() => 0));
ipcMain.handle('convert-legacy-recordings', () => normalize.convertLegacy()
  .catch((err) => ({ ok: false, error: err.message })));

ipcMain.handle('open-recording', async (e, meetingId) => {
  const meeting = await store.getMeeting(meetingId);
  if (!meeting || !meeting.recordingId) return { ok: false, error: 'Meeting not found.' };
  const dir = path.join(recordingsDir, meeting.recordingId);

  // Convert first if this recording has not been converted yet. Instant when it already has.
  const conv = await normalize.ensureMp4(meeting.recordingId);
  const found = conv.ok ? conv.media : media.resolveMedia(dir);
  if (!found) return { ok: false, error: conv.error || 'Recording file not found (may have been auto-deleted).' };

  if (found.ext === '.mp4') {
    const err = await shell.openPath(found.path); // '' on success
    if (!err) return { ok: true, opened: 'os' };
    console.warn('[open-recording] openPath failed, falling back to browser:', err);
  }
  // Still not an mp4 (conversion unavailable or failed): a browser is the only thing that
  // reliably plays a live-muxed WebM — QuickTime and Media Player refuse it outright.
  const url = media.mediaUrl(meeting.recordingId, dir);
  if (!url) return { ok: false, error: conv.error || 'Recording is not being served.' };
  await shell.openExternal(url);
  return { ok: true, opened: 'browser' };
});

ipcMain.handle('save-recording', async (e, meetingId) => {
  const meeting = await store.getMeeting(meetingId);
  // recordingId guard: path.join(dir, undefined) throws ERR_INVALID_ARG_TYPE, which surfaces as
  // an unhandled rejection in the renderer. Reachable for a meeting synced from another machine.
  if (!meeting || !meeting.recordingId) return { ok: false, error: 'Meeting not found.' };
  const dir = path.join(recordingsDir, meeting.recordingId);
  const found = media.resolveMedia(dir);
  if (!found) return { ok: false, error: 'Recording file not found (may have been auto-deleted).' };

  // Decide the extension BEFORE prompting: we offer .mp4 whenever we can actually produce one,
  // and the honest extension otherwise. Offering .mp4 over a file we cannot convert would hand
  // the user something Windows refuses to open.
  const target = found.normalized || normalize.isAvailable() ? { ext: '.mp4' } : found;

  // Dialog FIRST, then convert. A conversion can take minutes, and a modal appearing after the
  // user has switched apps is worse than picking the destination up front.
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: media.downloadName(meeting.title, target),
    filters: [media.downloadFilter(target)],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  let src = found.path;
  if (target.ext === '.mp4') {
    const conv = await normalize.ensureMp4(meeting.recordingId);
    if (!conv.ok) return { ok: false, error: conv.error };
    src = conv.media.path;
  }
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
  // Route a yourcallai:// deep link by host: 'slack', 'asana', or Supabase auth (everything else).
  const routeDeepLink = (url) => {
    if (url.startsWith(`${auth.PROTOCOL}://slack`)) return slack.handleDeepLink(url);
    if (url.startsWith(`${auth.PROTOCOL}://asana`)) return asana.handleDeepLink(url);
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
    // Fire-and-forget: an 8s network call must not gate window creation (offline start still
    // works off the disk cache). But the renderer reads its flags once at boot, so when the
    // fetch lands AFTER the window opened, push the fresh flags — otherwise a newly-enabled
    // integration reads as "not available" until the next restart.
    settingsStore.fetchTeamDefaults().then(async () => {
      await settingsStore.applyToEnv();
      const flags = await settingsStore.getConfiguredFlags();
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('config-changed', flags);
      }
    }).catch(() => {});

    recordingsDir = path.join(app.getPath('userData'), 'recordings');
    normalize.configure({
      recordingsDir,
      isRecording: () => !!rec,
      emitProgress: (id, pct) => emitProgress(id, 'normalizing', `${pct}%`),
      // The URL is derived at read time, so nothing needs repointing — but a meeting the user
      // has open right now will not re-render on its own.
      onNormalized: (id, info) => {
        const patch = {};
        // Persist truncation on the meeting record so it survives a restart and syncs like any
        // other field. Only set when partial: writing `capture: null` on every healthy
        // recording would be noise, and upsertMeeting shallow-merges.
        if (info && info.partial) {
          patch.capture = {
            partial: true,
            capturedMs: info.outMs,
            expectedMs: info.wallMs,
            at: nowIso(),
          };
        }
        // updateMeeting(id, patch), not upsertMeeting(meeting): upsert takes a whole record
        // keyed on recordingId and would need the existing one read first.
        const done = Object.keys(patch).length ? store.updateMeeting(id, patch) : Promise.resolve();
        done.catch(() => {}).then(() => store.getMeeting(id)).then((m) => {
          if (!m || !mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send('meeting-updated', {
            ...m,
            videoUrl: media.mediaUrl(id, path.join(recordingsDir, id)),
          });
        }).catch(() => {});
      },
      saveEncoder: (enc) => settingsStore.saveSettings({ VIDEO_ENCODER: enc }).catch(() => {}),
      // A visible conversion drives the status pill; hand it back when it ends, or the pill
      // stays stuck on "Preparing video 99%" forever.
      onJobDone: () => { if (!pipelineRunning.size) emitStatus(rec ? 'recording' : 'idle'); },
    });
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
      isAudioActive, // composite keep-alive signal (A): meeting audio still flowing
      onDetected: (info) => {
        if (rec) {
          // Already recording. If a "meeting ended" countdown is running, the meeting came back.
          if (pendingStop) cancelPendingStop('meeting resumed');
          return;
        }
        pendingMeeting = info;
        showPopup({ kind: 'detected', platform: info.platform, title: info.title });
        emitStatus('meeting-detected', info.title);
      },
      onClosed: () => {
        pendingMeeting = null;
        // The detector fires this only when window AND mic AND audio have all been gone ~15s.
        if (rec?.meta.source === 'detected') {
          beginPendingStop(); // cancelable countdown, not a silent stop
        } else if (!rec) {
          hidePopup();
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
    // Re-derives what still needs converting purely from the files on disk, so an interrupted
    // transcode resumes even for a recording whose pipeline already reported 'complete'.
    normalize.sweep().catch((e) => console.error('[normalize]', e.message));
    auth.init().catch((e) => console.error('[auth]', e.message)); // restore session + sync if signed in
  });

  app.on('before-quit', async (e) => {
    if (quitting) return;
    // Guard on BOTH an active recording AND an in-flight pipeline. Previously only `rec` was
    // checked, so closing the app during post-recording processing killed the pipeline. That is
    // now recoverable (the card is persisted at stop and recoverAndRequeue re-runs on launch), but
    // we still give a brief grace so the fast final stages (names/summary/persist) can complete.
    // A transcode is fully redoable from an untouched source, so quit must never wait for it —
    // and Electron does not reap children, so an unkilled ffmpeg keeps 100% CPU and a handle on
    // the output file after the window is gone.
    normalize.killCurrent('quit', { requeue: false });
    if (rec || pipelineRunning.size) {
      e.preventDefault();
      quitting = true;
      try { if (rec) await stopRecording(); } catch (err) { console.error('[quit]', err.message); }
      const deadline = Date.now() + 12000;
      while (pipelineRunning.size && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      app.quit(); // anything still transcribing resumes on next launch via the requeue
    }
  });

  // The before-quit path already kills it, but that handler is skipped entirely when nothing is
  // recording and no pipeline is in flight — and an orphaned ffmpeg would hold 100% CPU and a
  // file handle after the app is gone.
  app.on('will-quit', () => { normalize.killCurrent('will-quit', { requeue: false }); });
  process.on('exit', () => { normalize.killCurrent('process-exit', { requeue: false }); });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWindow?.show();
  });
}
