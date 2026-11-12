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

// Lifecycle events go into speakers.jsonl alongside the observations, so the pipeline can tell
// "the agent found nobody" from "the agent never ran" — previously indistinguishable, which made a
// silent Layer 1 failure in a shipped installer invisible. parseSpeakerEvents ignores unknown
// `type` values, so older readers are unaffected.
const status = (state, extra) => JSON.stringify({ ts: Date.now(), type: 'agent-status', state, ...extra });

// onLine receives each raw stdout JSON line. Returns { stop() }.
function startNameAgent(platform, onLine) {
  const bin = agentBinaryPath();
  if (!bin) {
    console.log('[agent] no native name agent binary — speaker names fall back to AI inference / rename UI');
    onLine(status('missing-binary', { platform }));
    return { stop: () => {} };
  }

  let child = null, stopped = false, restarts = 0;

  const launch = () => {
    if (stopped) return;
    child = spawn(bin, [platform], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    child.stderr.on('data', (d) => {
      const text = d.toString('utf8').trim();
      console.warn('[agent:stderr]', text);
      // The agent announces its heuristics version on startup; record it so a transcript can be
      // traced back to the selector set that produced its names.
      const m = /heuristics=(\S+)/.exec(text);
      if (m) onLine(status('started', { platform, heuristics: m[1] }));
    });
    child.on('error', (err) => {
      console.warn('[agent] spawn failed:', err.message);
      onLine(status('spawn-failed', { platform, error: err.message }));
    });
    child.on('exit', (code) => {
      if (stopped || code === 0) return;
      if (++restarts <= 3) {
        console.warn(`[agent] exited (${code}), restarting ${restarts}/3`);
        onLine(status('exited', { platform, code, restarts }));
        setTimeout(launch, 1000);
      } else {
        console.warn('[agent] gave up after 3 restarts — layers 2–3 take over');
        onLine(status('gave-up', { platform, code }));
      }
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

// Long-running agent modes (--capture, --watch). Line-oriented JSON on stdout; restarted on a
// crash up to `maxRestarts`. stop() asks politely over stdin ("stop", then EOF) so the native side
// can flush its files, and only kills after `graceMs`. Resolves once the process is gone.
function startAgentMode(args, onLine, { maxRestarts = 3, graceMs = 3000, onExit } = {}) {
  const bin = agentBinaryPath();
  if (!bin) return null;
  let child = null, stopped = false, restarts = 0;
  const launch = () => {
    if (stopped) return;
    child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { onLine(JSON.parse(line)); } catch { /* not JSON: ignore */ } }
      }
    });
    child.stdin.on('error', () => {}); // EPIPE once the child has exited
    child.on('error', (err) => onLine({ type: 'agent-mode-error', args: args[0], error: err.message }));
    child.on('exit', (code) => {
      if (onExit) onExit(code);
      if (stopped || code === 0) return;
      if (++restarts <= maxRestarts) {
        onLine({ type: 'agent-mode-restart', args: args[0], code, restarts });
        setTimeout(launch, 1000);
      }
    });
  };
  launch();
  return {
    isAlive: () => !!child && child.exitCode == null && !child.killed,
    stop: () => new Promise((resolve) => {
      stopped = true;
      const c = child;
      if (!c || c.exitCode != null || c.killed) return resolve();
      const timer = setTimeout(() => { try { c.kill(); } catch {} resolve(); }, graceMs);
      c.once('exit', () => { clearTimeout(timer); resolve(); });
      try { c.stdin.end('stop\n'); } catch { /* already closed */ }
    }),
  };
}

module.exports = { startNameAgent, startAgentMode, agentBinaryPath };
