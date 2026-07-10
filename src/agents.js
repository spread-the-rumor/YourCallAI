// Spawns the native active-speaker agent (§7 Layer 1) while recording.
// Binaries ship via extraResource (agents/dist). Total absence of the binary or of
// events is normal — layers 2–3 take over. Restarts on crash, max 3×.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function agentBinaryPath() {
  const name = process.platform === 'win32' ? 'YourCallAgent.exe' : 'YourCallAgent';
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'dist', name), path.join(process.resourcesPath, 'agents', 'dist', name)]
    : [path.join(app.getAppPath(), 'agents', 'dist', name)];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// onLine receives each raw stdout JSON line. Returns { stop() }.
function startNameAgent(platform, onLine) {
  const bin = agentBinaryPath();
  if (!bin) {
    console.log('[agent] no native name agent binary — speaker names fall back to AI inference / rename UI');
    return { stop: () => {} };
  }

  let child = null, stopped = false, restarts = 0;

  const launch = () => {
    if (stopped) return;
    child = spawn(bin, [platform], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => console.warn('[agent:stderr]', d.toString('utf8').trim()));
    child.on('error', (err) => console.warn('[agent] spawn failed:', err.message));
    child.on('exit', (code) => {
      if (stopped || code === 0) return;
      if (++restarts <= 3) {
        console.warn(`[agent] exited (${code}), restarting ${restarts}/3`);
        setTimeout(launch, 1000);
      } else console.warn('[agent] gave up after 3 restarts — layers 2–3 take over');
    });
  };
  launch();

  return {
    stop: () => {
      stopped = true;
      if (child && !child.killed) { try { child.kill(); } catch { /* already gone */ } }
    },
  };
}

module.exports = { startNameAgent };
