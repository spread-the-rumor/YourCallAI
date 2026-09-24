// Windows audio-endpoint control (§5 capture recovery).
//
// Chromium's loopback ALWAYS binds to the Windows default render endpoint — Electron 37's
// setDisplayMediaRequestHandler takes 'loopback' | 'loopbackWithMute' | WebFrameMain and nothing
// else, so there is no way to ask for a named device. When Windows picks a default nobody plays
// to (connecting an external display makes its speakers the default), re-acquiring getDisplayMedia
// returns the same silent endpoint every time. Measured live 2026-09-22: six recovery attempts
// across 18 minutes, all re-binding to a monitor while the meeting played out of the laptop
// speakers, and the far end was never recorded.
//
// The only lever is to change the Windows default itself, which needs native code — hence the
// `--audio` mode on the agent binary we already ship. This module is the JS side of that.
//
// EVERY function degrades to null/false rather than throwing. A missing binary (dev checkout with
// an empty agents/dist), an older binary without --audio, or a Windows build where IPolicyConfig
// has gone away must all leave the app exactly where it is today: warn the user, keep recording.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Same resolution order as src/agents.js agentBinaryPath() — keep them in step. The two
// resources/ candidates are the packaging hedge documented in src/agents.js.
function agentBinaryPath() {
  if (process.platform !== 'win32') return null; // --audio is Windows-only by construction
  // Wrapped because this sits on the recovery path: it runs while a meeting is being recorded,
  // and an exception here would propagate into capture handling. `app` is also undefined when
  // this module is required outside Electron (tests, tooling), which must return null, not throw.
  try {
    const name = 'YourCallAgent.exe';
    const candidates = app && app.isPackaged
      ? [path.join(process.resourcesPath, 'dist', name), path.join(process.resourcesPath, 'agents', 'dist', name)]
      : [path.join(app.getAppPath(), 'agents', 'dist', name)];
    return candidates.find((p) => fs.existsSync(p)) || null;
  } catch {
    return null; // no capability → caller degrades to notify-only, i.e. today's behaviour
  }
}

// `list` samples the meter for ~1s inside the native side, so the timeout has to clear that with
// room to spare; a wedged COM call must not hang the main process.
const TIMEOUT_MS = 8000;

// Peak level above which an endpoint is considered to be carrying real audio.
//
// This is IAudioMeterInformation's peak sample (0..1 linear), NOT the RMS the renderer computes,
// so ALIVE_RMS (1e-4) is the wrong scale to reuse directly — a peak is always well above the RMS
// of the same signal. Measured on this machine: silence reads exactly 0.000000 and ordinary
// speech playback reads 0.56. Sitting the bar at 0.01 keeps it far above a dithering endpoint and
// far below anything audible.
const LIVE_PEAK = 0.01;

// Never rejects. Resolves the parsed JSON line, or null.
function runAudio(args) {
  const bin = agentBinaryPath();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['--audio', ...args], { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      // A non-zero exit still prints valid JSON ({"ok":false,...}), so parse before judging err:
      // "IPolicyConfig unavailable" is a capability answer, not a spawn failure, and the caller
      // needs to tell those apart.
      const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
      if (!line) { resolve(null); return; }
      try { resolve(JSON.parse(line)); } catch { resolve(null); }
    });
  });
}

// Resolves [{ id, name, isDefault, peak }] or null when the capability is unavailable.
async function listEndpoints() {
  const res = await runAudio(['list']);
  if (!res || !res.ok || !Array.isArray(res.endpoints)) return null;
  return res.endpoints;
}

// Resolves { ok, code, error }. ok:false with code 'no-policy-config' means Windows would not give
// us the interface — the caller must fall back to telling the user, never retry in a loop.
async function setDefaultEndpoint(id) {
  const res = await runAudio(['set', id]);
  if (!res) return { ok: false, code: 'unavailable', error: 'audio endpoint control unavailable' };
  return res;
}

// Find an endpoint that is carrying audio and is NOT the one Windows currently defaults to.
//
// The "not the default" condition is the whole point: if the default were the live one, loopback
// would already be recording it and we would not be here. Returns null when nothing else is
// playing, which is the honest answer for "the meeting really is silent" — and it is why this
// can never thrash: with nothing to switch to, it reports nothing and the caller just warns.
// Pure so it is unit-testable without spawning anything — the interesting behaviour is the
// selection rule, not the COM plumbing.
function chooseLiveEndpoint(endpoints, livePeak = LIVE_PEAK) {
  if (!Array.isArray(endpoints) || endpoints.length < 2) return null; // nothing to switch TO
  const candidates = endpoints
    .filter((e) => e && !e.isDefault && typeof e.peak === 'number' && e.peak >= livePeak)
    .sort((a, b) => b.peak - a.peak);
  return candidates[0] || null;
}

async function pickLiveEndpoint() {
  return chooseLiveEndpoint(await listEndpoints());
}

// For the warning message when we cannot fix it automatically: naming the device Windows is
// pointed at is the difference between "meeting audio not captured" (which tells the user
// nothing) and an instruction they can act on.
async function currentDefault() {
  const endpoints = await listEndpoints();
  if (!endpoints) return null;
  return endpoints.find((e) => e.isDefault) || null;
}

function isAvailable() {
  return !!agentBinaryPath();
}

module.exports = {
  chooseLiveEndpoint,
  listEndpoints,
  setDefaultEndpoint,
  pickLiveEndpoint,
  currentDefault,
  isAvailable,
  LIVE_PEAK,
};
