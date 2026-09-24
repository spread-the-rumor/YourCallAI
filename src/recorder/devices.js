// What did we ACTUALLY bind to? Capture used to record nothing about its own devices, so a
// "it captured nothing" report was unfalsifiable after the fact. This snapshot is written to
// capture.jsonl next to the recording.

const { looksBluetooth, ALIVE_RMS } = require('./audioHealth');

const slim = (d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label, kind: d.kind });
const safeSettings = (t) => { try { return t.getSettings(); } catch { return null; } };

const describeTrack = (t) => (t ? {
  label: t.label || null,
  readyState: t.readyState,
  muted: t.muted,   // true here is itself a smoking gun
  enabled: t.enabled,
  settings: safeSettings(t),
} : null);

// Returns the current default audiooutput, or null. This is our best proxy for "which endpoint
// did WASAPI loopback bind to": a Chromium loopback track is not an enumerated device, so its
// getSettings() carries no endpoint identity. The default output is the endpoint loopback
// WOULD have picked — an inference, labelled as one in the log.
function defaultOutputOf(devices) {
  const outs = devices.filter((d) => d.kind === 'audiooutput');
  return outs.find((d) => d.deviceId === 'default') || outs[0] || null;
}

// MUST be called AFTER getUserMedia: enumerateDevices() returns blank labels until a
// permission grant exists for the origin, so enumerating first yields useless "" labels.
async function snapshotDevices(micTrack, sysTrack) {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); }
  catch { /* non-fatal: the snapshot is diagnostics, never a gate */ }
  const defaultOutput = defaultOutputOf(devices);
  return {
    mic: describeTrack(micTrack),
    system: describeTrack(sysTrack),
    // Inferred, not read from the loopback track — see defaultOutputOf().
    inferredLoopbackEndpoint: defaultOutput ? slim(defaultOutput) : null,
    defaultOutputLooksBluetooth: looksBluetooth(defaultOutput),
    outputs: devices.filter((d) => d.kind === 'audiooutput').map(slim),
    inputs: devices.filter((d) => d.kind === 'audioinput').map(slim),
  };
}

// Identity of the default output, for detecting a mid-recording swap. Label+groupId rather
// than deviceId: the deviceId of the "default" entry stays the literal string "default" even
// when the underlying hardware changes.
function defaultOutputKey(snapshot) {
  const d = snapshot && snapshot.inferredLoopbackEndpoint;
  return d ? `${d.groupId || ''}|${d.label || ''}` : '';
}

// Prove a candidate loopback stream is actually alive BEFORE committing to it. Re-acquiring
// can hand back a stream bound to the same dead endpoint, so we measure first and only swap on
// evidence — never disconnect a working source for an unverified replacement.
//
// The bar is ALIVE_RMS (1e-4), NOT DEAD_RMS (1e-5), and that change is the core fix. Measured
// over 51 real probes: 69% of "alive" verdicts sat in 1.0e-5..2.0e-5, the same band as the
// readings we called dead — the threshold was inside the noise, so the verdict was decided by
// jitter. A probe that cannot tell alive from dead is worse than no probe: it launders a
// coin flip into recorded evidence ("recover-ok, maxRms: 0.0000102") and then swaps a working
// source out for a dead one, which is precisely how the 2026-09-17 meeting lost 45 minutes.
//
// Resolves { alive, maxRms }. Never throws.
async function probeStreamAlive(ctx, stream, { ms = 2000, aliveRms = ALIVE_RMS } = {}) {
  const track = stream && stream.getAudioTracks()[0];
  if (!track) return { alive: false, maxRms: 0 };
  let src;
  try {
    src = ctx.createMediaStreamSource(new MediaStream([track]));
  } catch {
    return { alive: false, maxRms: 0 };
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser); // analyser has no onward connection, so this is silent — never reaches output
  const buf = new Float32Array(analyser.fftSize);
  let maxRms = 0;
  const started = Date.now();
  while (Date.now() - started < ms) {
    await new Promise((r) => setTimeout(r, 100));
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    maxRms = Math.max(maxRms, Math.sqrt(sum / buf.length));
    // Early exit only on UNAMBIGUOUS signal. The old code broke as soon as it crossed 1e-5,
    // which meant it usually stopped listening ~100ms in, on a noise-floor reading, and never
    // gave real audio a chance to appear. Waiting out the window is what makes a quiet-but-live
    // endpoint distinguishable from a dead one.
    if (maxRms >= aliveRms) break;
  }
  try { src.disconnect(); } catch { /* already torn down */ }
  return { alive: maxRms >= aliveRms, maxRms };
}

module.exports = { snapshotDevices, defaultOutputKey, defaultOutputOf, probeStreamAlive };
