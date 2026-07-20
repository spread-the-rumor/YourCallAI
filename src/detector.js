// Meeting detection (§8): poll window titles + mic-in-use every 5s, debounce 2 hits / 3 misses.
// Primary: get-windows (ESM, dynamic import). Fallback: PowerShell (win) / AppleScript (mac).
//
// Liveness is COMPOSITE: once a meeting is announced, it stays alive while ANY of
//   (W) a matching window/title is present,
//   (M) the meeting app still holds the OS microphone,
//   (A) meeting audio is still flowing (isAudioActive, supplied by main while recording),
// is true. It only "closes" when ALL are absent for MISSES_TO_CLOSE polls. This survives tab
// switches / screen share / PiP / mute / dial-in, and stops only when the meeting really ended.
const { execFile } = require('child_process');

const POLL_MS = 5000;
const HITS_TO_DETECT = 2;
const MISSES_TO_CLOSE = 3;

// Browser families that can host a meeting (Chromium-based). Titles from these are tab titles.
const BROWSER_RE = /chrome|msedge|edge|chromium|brave|opera|vivaldi/;

// Returns { platform, transport, title } or null. transport ∈ 'app' | 'browser'.
function matchMeeting(windows) {
  for (const w of windows) {
    const title = w.title || '';
    const app = (w.app || '').toLowerCase();
    const isBrowser = BROWSER_RE.test(app);
    // Google Meet — always browser. "Meet – <code>" is the tab title; the "meet.google.com is
    // sharing…" banner title shows during screen share.
    if ((/^Meet [–-] /.test(title) || /meet\.google\.com/i.test(title)) && isBrowser) {
      return { platform: 'google-meet', transport: 'browser', title };
    }
    // Zoom desktop app.
    if (/zoom/.test(app) && /Zoom Meeting/i.test(title)) {
      return { platform: 'zoom', transport: 'app', title };
    }
    // Zoom in a browser tab — the in-call title is "Zoom Meeting" / the web client is app.zoom.us.
    if (isBrowser && (/\bzoom meeting\b/i.test(title) || /app\.zoom\.us/i.test(title))) {
      return { platform: 'zoom', transport: 'browser', title };
    }
    // Teams desktop app — newer titles lack a Meeting/Call marker (mic fallback covers those).
    if (/Microsoft Teams/i.test(title) && /(Meeting|Call)/i.test(title) && !isBrowser) {
      return { platform: 'teams', transport: 'app', title };
    }
    // Teams in a browser tab is NOT matched on title — "… | Microsoft Teams" is ambiguous (chat,
    // activity, etc.). Browser-Teams is detected via the mic (holders) instead.
  }
  return null;
}

// Does a browser window show any meeting-ish tab title? Used to gate browser-mic-only detection.
function browserMeetingHint(windows) {
  for (const w of windows) {
    const title = w.title || '';
    if (!BROWSER_RE.test((w.app || '').toLowerCase())) continue;
    if (/^Meet [–-] /.test(title) || /meet\.google\.com/i.test(title)) return 'google-meet';
    if (/\bzoom\b/i.test(title) || /app\.zoom\.us/i.test(title)) return 'zoom';
    if (/Microsoft Teams/i.test(title)) return 'teams';
  }
  return null;
}

let getWindowsMod = null;
let getWindowsFailed = false;

// Resolves to an array of { title, app }, or null if enumeration failed (distinct from "no windows").
async function listWindows() {
  if (!getWindowsFailed) {
    try {
      if (!getWindowsMod) {
        // webpackIgnore keeps this a real dynamic import: CJS main can import the ESM package.
        getWindowsMod = await import(/* webpackIgnore: true */ 'get-windows');
      }
      const wins = await getWindowsMod.openWindows();
      return wins.map((w) => ({ title: w.title, app: w.owner?.name || '' }));
    } catch (err) {
      getWindowsFailed = true;
      console.warn('[detector] get-windows unavailable, using platform fallback:', err.message);
    }
  }
  return platformListWindows();
}

function platformListWindows() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const ps = "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const i = line.indexOf('|');
          return { app: line.slice(0, i), title: line.slice(i + 1) };
        }));
      });
    } else if (process.platform === 'darwin') {
      const script = 'tell application "System Events" to get {name, name of windows} of (processes whose background only is false)';
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
          return { app: line.slice(0, i), title: line.slice(i + 1) };
        }));
      });
      void script;
    } else resolve([]);
  });
}

// Windows mic-in-use registry: LastUsedTimeStop=0x0 under the ConsentStore means that app is
// holding the microphone right now. The recursive scan covers packaged (e.g. MSTeams_…) and
// NonPackaged (e.g. …\chrome.exe) subtrees. Returns a Set of platform-family tokens currently
// holding the mic ('browser' | 'zoom' | 'teams'), or null if the registry could not be read
// (null = unknown, never treated as "released"). Our own Electron mic-hold matches none of these.
function micHolders() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
      '/s'], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const holders = new Set();
      let keyToken = null; // family token for the key section currently being scanned
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('HKEY_')) {
          const low = line.toLowerCase();
          if (BROWSER_RE.test(low)) keyToken = 'browser';
          else if (/zoom|cpthost/.test(low)) keyToken = 'zoom';
          else if (/teams|msteams/.test(low)) keyToken = 'teams';
          else keyToken = null;
        } else if (keyToken && /^LastUsedTimeStop\s+REG_QWORD\s+0x0$/.test(line)) {
          holders.add(keyToken);
        }
      }
      resolve(holders);
    });
  });
}

// Back-compat thin wrappers (used elsewhere / tests).
const teamsMicActive = async () => { const h = await micHolders(); return !!h && h.has('teams'); };
const browserMicActive = async () => { const h = await micHolders(); return !!h && h.has('browser'); };

// The mic-family token that keeps a given meeting alive.
function micTokenFor(meeting) {
  if (!meeting) return null;
  if (meeting.transport === 'browser') return 'browser';
  return meeting.platform === 'zoom' ? 'zoom' : 'teams'; // app transport
}

function start({ onDetected, onClosed, isAudioActive }) {
  let hits = 0, misses = 0, announced = false, stopped = false;
  let current = null; // last announced { platform, transport }, reused by mic/audio sustain

  const tick = async () => {
    if (stopped) return;
    try {
      const [windows, holders] = await Promise.all([listWindows(), micHolders()]);

      // Enumeration failure = unknown; hold state rather than faking a miss.
      if (windows === null && holders === null) {
        if (!stopped) setTimeout(tick, POLL_MS);
        return;
      }
      const wins = windows || [];

      let meeting = matchMeeting(wins); // (W) confident title match

      if (!announced) {
        // Gate browser-transport title matches on the mic so a stray tab (a "zoom" article, an
        // idle Teams/Meet tab) can't trigger a false popup. `holders === null` = unknown (mac /
        // registry read failed) → don't block, fall back to title alone.
        if (meeting && meeting.transport === 'browser' && holders && !holders.has('browser')) {
          meeting = null;
        }
        // Announce path: title match, OR a dedicated app holds the mic (no title needed), OR a
        // browser holds the mic AND some browser tab looks meeting-ish.
        if (!meeting && holders) {
          if (holders.has('zoom')) meeting = { platform: 'zoom', transport: 'app', title: 'Zoom Meeting' };
          else if (holders.has('teams')) meeting = { platform: 'teams', transport: 'app', title: 'Microsoft Teams' };
          else if (holders.has('browser')) {
            const hint = browserMeetingHint(wins);
            if (hint) meeting = { platform: hint, transport: 'browser', title: '' };
          }
        }
      } else {
        // Keep-alive path — composite (W) || (M) || (A). matchMeeting must agree on platform.
        const windowAlive = !!meeting && meeting.platform === current.platform;
        const micAlive = !!holders && holders.has(micTokenFor(current));
        const audioAlive = !!isAudioActive && isAudioActive();
        meeting = (windowAlive || micAlive || audioAlive) ? current : null;
      }

      if (meeting) {
        hits++; misses = 0;
        if (hits >= HITS_TO_DETECT && !announced) {
          announced = true;
          current = { platform: meeting.platform, transport: meeting.transport };
          onDetected(meeting);
        }
      } else {
        misses++; hits = 0;
        if (misses >= MISSES_TO_CLOSE && announced) {
          announced = false; current = null; onClosed();
        }
      }
    } catch (err) {
      console.warn('[detector] poll failed:', err.message);
    }
    if (!stopped) setTimeout(tick, POLL_MS);
  };
  tick();

  return { stop: () => { stopped = true; } };
}

module.exports = { start, matchMeeting, micHolders, teamsMicActive, browserMicActive };
