// Meeting detection (§8): poll window titles every 5s, debounce 2 hits / 3 misses.
// Primary: get-windows (ESM, dynamic import). Fallback: PowerShell (win) / AppleScript (mac).
const { execFile } = require('child_process');

const POLL_MS = 5000;

function matchMeeting(windows) {
  for (const w of windows) {
    const title = w.title || '';
    const app = (w.app || '').toLowerCase();
    if (/^Meet [–-] /.test(title) && /chrome|edge|msedge/.test(app)) {
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

// New Teams window titles carry no "Meeting"/"Call" marker (e.g. "Guidion | SBPM | Microsoft Teams"),
// so on Windows we detect Teams meetings via the mic-in-use registry: LastUsedTimeStop=0x0
// under the ConsentStore means the app is holding the microphone right now.
function teamsMicActive() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
      '/s'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(false);
      let inTeamsKey = false;
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('HKEY_')) inTeamsKey = /teams/i.test(line);
        else if (inTeamsKey && /^LastUsedTimeStop\s+REG_QWORD\s+0x0$/.test(line)) return resolve(true);
      }
      resolve(false);
    });
  });
}

function start({ onDetected, onClosed }) {
  let hits = 0, misses = 0, announced = false, stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const windows = await listWindows();
      let meeting = matchMeeting(windows);
      if (!meeting && await teamsMicActive()) {
        const w = windows.find((x) => /teams/i.test(x.app) || / Microsoft Teams$/.test(x.title));
        meeting = { platform: 'teams', title: w?.title || 'Microsoft Teams' };
      }
      if (meeting) {
        hits++; misses = 0;
        if (hits >= 2 && !announced) { announced = true; onDetected(meeting); }
      } else {
        misses++; hits = 0;
        if (misses >= 3 && announced) { announced = false; onClosed(); }
      }
    } catch (err) {
      console.warn('[detector] poll failed:', err.message);
    }
    if (!stopped) setTimeout(tick, POLL_MS);
  };
  tick();

  return { stop: () => { stopped = true; } };
}

module.exports = { start, matchMeeting, teamsMicActive };
