// Meeting detection (§8): poll window titles every 5s, debounce 2 hits / 3 misses.
// Primary: get-windows (ESM, dynamic import). Fallback: PowerShell (win) / AppleScript (mac).
const { execFile } = require('child_process');

const POLL_MS = 5000;
const HITS_TO_DETECT = 2;
const MISSES_TO_CLOSE = 3;

function matchMeeting(windows) {
  for (const w of windows) {
    const title = w.title || '';
    const app = (w.app || '').toLowerCase();
    // "Meet – <code>" is the tab title; "meet.google.com is sharing..." appears during screen share.
    if ((/^Meet [–-] /.test(title) || /meet\.google\.com/i.test(title)) && /chrome|edge|msedge/.test(app)) {
      return { platform: 'google-meet', title };
    }
    if (/zoom/.test(app) && /Zoom Meeting/.test(title)) return { platform: 'zoom', title };
    if (/Microsoft Teams/.test(title) && /(Meeting|Call)/.test(title)) return { platform: 'teams', title };
  }
  return null;
}

let getWindowsMod = null;
let getWindowsFailed = false;

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
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 }, (err, stdout) => {
        if (err) return resolve([]);
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
        return out`], { timeout: 8000 }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(stdout.split('\n').filter(Boolean).map((line) => {
          const i = line.indexOf('|');
          return { app: line.slice(0, i), title: line.slice(i + 1) };
        }));
      });
      void script;
    } else resolve([]);
  });
}

// Windows mic-in-use registry: LastUsedTimeStop=0x0 under the ConsentStore means the app whose
// key path matches appRe is holding the microphone right now. Survives tab switches / title changes.
function micActive(appRe) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
      '/s'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(false);
      let inAppKey = false;
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('HKEY_')) inAppKey = appRe.test(line);
        else if (inAppKey && /^LastUsedTimeStop\s+REG_QWORD\s+0x0$/.test(line)) return resolve(true);
      }
      resolve(false);
    });
  });
}

// New Teams window titles carry no "Meeting"/"Call" marker (e.g. "Guidion | SBPM | Microsoft Teams").
const teamsMicActive = () => micActive(/teams/i);
// Chrome/Edge hold the mic for the whole Meet call — through tab switches, screen share, and PiP.
const browserMicActive = () => micActive(/chrome|msedge/i);

function start({ onDetected, onClosed }) {
  let hits = 0, misses = 0, announced = false, stopped = false;
  let current = null; // last announced meeting, kept so mic-sustained ticks reuse its identity

  const tick = async () => {
    if (stopped) return;
    try {
      const windows = await listWindows();
      let meeting = matchMeeting(windows);
      if (!meeting && await teamsMicActive()) {
        const w = windows.find((x) => /teams/i.test(x.app) || / Microsoft Teams$/.test(x.title));
        meeting = { platform: 'teams', title: w?.title || 'Microsoft Teams' };
      }
      // A live Meet's title disappears on tab switch / screen share / PiP. Initial detection stays
      // title-gated, but once announced, the browser still holding the mic counts as a hit.
      if (!meeting && announced && current?.platform === 'google-meet' && await browserMicActive()) {
        meeting = current;
      }
      if (meeting) {
        hits++; misses = 0;
        if (hits >= HITS_TO_DETECT && !announced) { announced = true; current = meeting; onDetected(meeting); }
      } else {
        misses++; hits = 0;
        if (misses >= MISSES_TO_CLOSE && announced) { announced = false; current = null; onClosed(); }
      }
    } catch (err) {
      console.warn('[detector] poll failed:', err.message);
    }
    if (!stopped) setTimeout(tick, POLL_MS);
  };
  tick();

  return { stop: () => { stopped = true; } };
}

module.exports = { start, matchMeeting, teamsMicActive, browserMicActive };
