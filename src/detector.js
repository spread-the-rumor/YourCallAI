// Meeting detection (§8).
//
// "In a call" is decided by WHICH PROCESS HOLDS THE MICROPHONE, not by window titles. Titles were
// the old primary signal and failed in every direction: modern Teams meeting windows carry no
// "Meeting"/"Call", the shipped app could only see ONE title per process (the get-windows module
// never made it into the installer, so a PowerShell poll stood in), and anything that was not
// Meet/Zoom/Teams — Slack huddles, Webex, RingCentral, Firefox, Arc — was invisible.
//
// Sources, best first:
//   1. The native agent's --watch stream (Windows): per-process microphone and playback sessions
//      plus every visible window title, every 2 s. Works for any app.
//   2. Fallback (no agent, macOS): the registry mic-in-use flag + a window-title poll.
//
// Ending is just as important as starting — three meetings recorded 6 to 73 minutes past their
// end because ROOM NOISE on the user's own mic counted as "meeting still live". Now a meeting
// stays alive only while the call app holds the mic, its call window is open, or MEETING audio
// (the system stream, not the mic) is playing.
//
// All interpretation is pure (classifySnapshot, createTracker) and unit-tested; I/O is at the edge.
const { execFile } = require('child_process');

const AGENT_POLL_MS = 2000;
const FALLBACK_POLL_MS = 5000;
const KNOWN_START_MS = 4000;     // a known call app holding the mic this long → announce
const UNKNOWN_START_MS = 30000;  // an unrecognised mic user must persist longer (dictation, voice notes)
const END_GRACE_MS = 20000;      // every liveness signal absent this long → the meeting is over

const BROWSER_RE = /^(chrome|msedge|edge|chromium|brave|opera|vivaldi|firefox|arc|comet|thebrowsercompany|librewolf|waterfox|zen)$/;

// Processes that use the microphone for reasons other than a call. Our own app is here: the
// recorder holds the mic for the whole recording.
const IGNORE_MIC = /^(your call ai|yourcallagent|electron|obs\d*|obs-browser-page|audacity|soundrecorder|voicerecorder|textinputhost|searchhost|searchapp|searchui|cortana|krisp|nvidia broadcast|nvbroadcast|rtxvoice|voicemeeter.*|audiodg|systemsettings|ctfmon|steelseriessonar.*|wavesmaxxaudio.*)$/;

// Desktop call apps by process name.
const APPS = [
  { re: /^(zoom|cpthost|zoomwebview\w*)$/, platform: 'zoom' },
  { re: /^(ms-teams|teams|msteams)$/, platform: 'teams' },
  { re: /^slack$/, platform: 'slack' },
  { re: /^(webex|ciscowebex\w*|webexmta|atmgr|ciscocollabhost)$/, platform: 'webex' },
  { re: /^(ringcentral\w*|rcmeetings\w*|glip)$/, platform: 'ringcentral' },
  { re: /^(g2mcomm|g2mstart|gotomeeting|goto)$/, platform: 'goto' },
  { re: /^discord$/, platform: 'discord' },
  { re: /^(skype|lync)$/, platform: 'skype' },
  { re: /^(whatsapp\w*)$/, platform: 'whatsapp' },
  { re: /^(telegram)$/, platform: 'telegram' },
  { re: /^(facetime)$/, platform: 'facetime' },
];

// Meeting-looking browser tab titles → platform.
const TAB_HINTS = [
  { re: /^Meet [–-] |meet\.google\.com|Google Meet/i, platform: 'google-meet' },
  { re: /\bZoom Meeting\b|app\.zoom\.us|zoom\.us\/wc/i, platform: 'zoom' },
  { re: /\|\s*Microsoft Teams|teams\.microsoft\.com|teams\.live\.com/i, platform: 'teams' },
  { re: /Webex/i, platform: 'webex' },
  { re: /\bHuddle\b.*Slack|Slack.*\bHuddle\b/i, platform: 'slack' },
  { re: /Whereby|Jitsi|8x8|Around|Gather|Discord/i, platform: 'browser' },
];

// Windows that only exist DURING a call, for keep-alive (not for starting).
const CALL_WINDOW = [
  { platform: 'zoom', re: /^Zoom Meeting|Zoom Webinar|^Meeting$/i },
  { platform: 'google-meet', re: /^Meet [–-] /i },
  // Word-bounded so the "Calls" and "Meetings" TABS of the main window do not count as a call.
  { platform: 'teams', re: /\bMeeting\b|\bCall\b|Compact meeting/i },
  { platform: 'slack', re: /Huddle/i },
];

function appPlatform(proc) {
  for (const a of APPS) if (a.re.test(proc)) return a.platform;
  return null;
}

function tabHint(title) {
  for (const h of TAB_HINTS) if (h.re.test(title || '')) return h.platform;
  return null;
}

const titleFor = (platform, windows, proc) => {
  const own = (windows || []).filter((w) => w.proc === proc && w.title);
  const hinted = own.find((w) => tabHint(w.title));
  return (hinted || own[0] || {}).title || '';
};

// One snapshot → the call it shows, or null.
// snapshot = { mic: [{ proc }], playing: [{ proc }], windows: [{ proc, title }] }
// Returns { platform, transport: 'app'|'browser', app, title, known } where `known` means the app
// is a recognised call app (fast start) rather than an unrecognised mic user (slow start).
function classifySnapshot(snapshot) {
  const s = snapshot || {};
  const windows = s.windows || [];
  const holders = [...new Set((s.mic || []).map((m) => (m.proc || '').toLowerCase()))]
    .filter((p) => p && !IGNORE_MIC.test(p));
  if (!holders.length) return null;

  // Prefer a recognised desktop app over everything else.
  for (const proc of holders) {
    const platform = appPlatform(proc);
    if (platform) return { platform, transport: 'app', app: proc, title: titleFor(platform, windows, proc), known: true };
  }
  // WebView2 hosts new Teams' media; attribute it to Teams when Teams is running.
  if (holders.includes('msedgewebview2') && windows.some((w) => appPlatform(w.proc) === 'teams')) {
    const t = windows.find((w) => appPlatform(w.proc) === 'teams');
    return { platform: 'teams', transport: 'app', app: 'ms-teams', title: t ? t.title : '', known: true };
  }
  for (const proc of holders) {
    if (!BROWSER_RE.test(proc)) continue;
    // Browser tabs live in the browser's main process, the mic in its audio service process —
    // same NAME, different pid. So match titles by process name, not pid.
    const tabs = windows.filter((w) => w.proc === proc);
    for (const t of tabs) {
      const platform = tabHint(t.title);
      if (platform) return { platform, transport: 'browser', app: proc, title: t.title, known: true };
    }
    return { platform: 'browser', transport: 'browser', app: proc, title: (tabs[0] || {}).title || '', known: false };
  }
  const proc = holders[0];
  return { platform: 'other', transport: 'app', app: proc, title: titleFor(null, windows, proc), known: false };
}

// Is the announced call still live? Any one signal is enough.
function stillLive(call, snapshot, { systemAudio = false } = {}) {
  if (!call) return false;
  const s = snapshot || {};
  if (systemAudio) return true; // meeting audio is playing (NOT the user's own mic)
  if ((s.mic || []).some((m) => (m.proc || '').toLowerCase() === call.app)) return true;
  if (call.platform === 'teams' && (s.mic || []).some((m) => m.proc === 'msedgewebview2')) return true;
  const cw = CALL_WINDOW.find((c) => c.platform === call.platform);
  if (cw && (s.windows || []).some((w) => w.proc === call.app && cw.re.test(w.title || ''))) return true;
  return false;
}

// Debounced start/end state machine. Pure: time is passed in.
function createTracker({ knownStartMs = KNOWN_START_MS, unknownStartMs = UNKNOWN_START_MS, endGraceMs = END_GRACE_MS } = {}) {
  let candidate = null, candidateSince = 0;
  let current = null, lastLive = 0;
  const sameCall = (a, b) => a && b && a.platform === b.platform && a.app === b.app;
  return {
    current: () => current,
    // Returns null or { type: 'detected', call } | { type: 'closed', call, silentMs }
    step(now, snapshot, opts = {}) {
      if (!current) {
        const c = classifySnapshot(snapshot);
        if (!c) { candidate = null; return null; }
        if (!sameCall(c, candidate)) { candidate = c; candidateSince = now; }
        else if (c.title) candidate.title = c.title;
        if (now - candidateSince >= (c.known ? knownStartMs : unknownStartMs)) {
          current = candidate; candidate = null; lastLive = now;
          return { type: 'detected', call: current };
        }
        return null;
      }
      if (stillLive(current, snapshot, opts)) { lastLive = now; return null; }
      if (now - lastLive >= endGraceMs) {
        const ended = current;
        current = null; candidate = null;
        return { type: 'closed', call: ended, silentMs: now - lastLive };
      }
      return null;
    },
  };
}

// ---------- fallback sources (no agent / macOS) ----------

function platformListWindows() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const ps = "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const i = line.indexOf('|');
          return { proc: line.slice(0, i).toLowerCase(), title: line.slice(i + 1) };
        }));
      });
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', `
        set out to ""
        tell application "System Events"
          repeat with p in (processes whose background only is false)
            try
              repeat with w in windows of p
                set out to out & (name of p) & "|" & (name of w) & linefeed
              end repeat
            end try
          end repeat
        end tell
        return out`], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.split('\n').filter(Boolean).map((line) => {
          const i = line.indexOf('|');
          return { proc: line.slice(0, i).toLowerCase(), title: line.slice(i + 1) };
        }));
      });
    } else resolve([]);
  });
}

// Windows mic-in-use registry: LastUsedTimeStop = 0x0 under the ConsentStore means that app holds
// the microphone right now. Returns [{ proc }] from the key names (…#chrome.exe → chrome,
// MSTeams_8wekyb3d8bbwe → msteams), or null when the registry could not be read.
function parseMicRegistry(stdout) {
  const out = [];
  let proc = null;
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('HKEY_')) {
      const leaf = line.split('\\').pop() || '';
      const exe = /#([^#]+)\.exe$/i.exec(leaf);
      proc = exe ? exe[1].toLowerCase() : leaf.split('_')[0].toLowerCase();
    } else if (proc && /^LastUsedTimeStop\s+REG_QWORD\s+0x0$/.test(line)) {
      out.push({ proc });
    }
  }
  return out;
}
function registryMic() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
      '/s'], { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err || !stdout ? null : parseMicRegistry(stdout)));
  });
}

// ---------- runner ----------

// opts: { onDetected(call), onClosed(call), isSystemAudioActive(), log(evt) }
function start(opts) {
  const { onDetected, onClosed, isSystemAudioActive, log = () => {} } = opts;
  const tracker = createTracker();
  let stopped = false;
  let latest = null;     // latest agent snapshot
  let latestAt = 0;
  let agent = null;
  let fallbackTimer = null;

  const evaluate = (snapshot) => {
    if (stopped) return;
    const evt = tracker.step(Date.now(), snapshot,
      { systemAudio: !!(isSystemAudioActive && isSystemAudioActive()) });
    if (!evt) return;
    log({ type: evt.type, platform: evt.call.platform, app: evt.call.app, title: evt.call.title,
      known: evt.call.known, source: snapshot.source, silentMs: evt.silentMs });
    if (evt.type === 'detected') onDetected(evt.call);
    else onClosed(evt.call);
  };

  // Native agent: snapshots arrive every 2 s.
  try {
    const { startAgentMode } = require('./agents');
    if (process.platform === 'win32') {
      agent = startAgentMode(['--watch'], (msg) => {
        if (msg.type !== 'calls') return;
        latest = { mic: msg.mic, playing: msg.playing, windows: msg.windows, source: 'agent' };
        latestAt = Date.now();
        evaluate(latest);
      }, { maxRestarts: 10 });
    }
  } catch (err) { log({ type: 'agent-unavailable', error: err.message }); }
  log({ type: 'detector-start', agent: !!agent });

  // Fallback poll runs whenever the agent has not reported recently (missing binary, crashed,
  // macOS).
  const fallback = async () => {
    if (stopped) return;
    if (!latestAt || Date.now() - latestAt > AGENT_POLL_MS * 3) {
      try {
        const [windows, mic] = await Promise.all([platformListWindows(), registryMic()]);
        if (windows !== null || mic !== null) evaluate({ windows: windows || [], mic: mic || [], playing: [], source: 'fallback' });
      } catch (err) { console.warn('[detector] fallback poll failed:', err.message); }
    }
    if (!stopped) fallbackTimer = setTimeout(fallback, FALLBACK_POLL_MS);
  };
  fallbackTimer = setTimeout(fallback, AGENT_POLL_MS * 3);

  return {
    current: () => tracker.current(),
    stop: () => { stopped = true; clearTimeout(fallbackTimer); if (agent) agent.stop(); },
  };
}

// Back-compat for older call sites/tests: title-only match on { app, title } windows.
function matchMeeting(windows) {
  for (const w of windows || []) {
    const proc = (w.app || w.proc || '').toLowerCase();
    const title = w.title || '';
    const isBrowser = /chrome|msedge|edge|chromium|brave|opera|vivaldi/.test(proc);
    if ((/^Meet [–-] /.test(title) || /meet\.google\.com/i.test(title)) && isBrowser) return { platform: 'google-meet', transport: 'browser', title };
    if (/zoom/.test(proc) && /Zoom Meeting/i.test(title)) return { platform: 'zoom', transport: 'app', title };
    if (isBrowser && (/\bzoom meeting\b/i.test(title) || /app\.zoom\.us/i.test(title))) return { platform: 'zoom', transport: 'browser', title };
    if (/Microsoft Teams/i.test(title) && /(Meeting|Call)/i.test(title) && !isBrowser) return { platform: 'teams', transport: 'app', title };
  }
  return null;
}

module.exports = {
  start, classifySnapshot, stillLive, createTracker, parseMicRegistry, matchMeeting,
  KNOWN_START_MS, UNKNOWN_START_MS, END_GRACE_MS,
};
