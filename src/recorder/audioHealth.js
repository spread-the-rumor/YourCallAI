// Pure capture-health logic (no DOM, no Web Audio) so test/selfcheck.js can drive it directly.
//
// Why this module exists: capture used to bind to whatever Windows called the "default" device
// and never verify a single sample arrived. Four separate mechanisms silently produce a dead
// stream (WASAPI not following default-device changes; loopback delivering nothing when no
// playback session is active; the Bluetooth A2DP→HFP switch our own getUserMedia triggers;
// endpoints that fail outright, e.g. Electron #15829). The single shared AnalyserNode summed
// mic+system, so none of them were even distinguishable from "the meeting is quiet".

// Digital silence vs. a quiet room — the whole premise of the warm-up check:
// a LIVE path always carries a noise floor (ADC dither, preamp noise, driver comfort noise),
// roughly 1e-4..1e-3 RMS. A BROKEN path delivers memset-zero buffers: bit-exactly 0.0, forever.
// SILENCE_RMS (0.0025) sits ABOVE the live noise floor, which is exactly why it can only say
// "quiet" and can never say "dead". DEAD_RMS sits below it, in the gap.
const DEAD_RMS = 1e-5;          // ~ -100 dBFS
const WARMUP_MS = 8000;         // 3s risks a false alarm mid Bluetooth HFP handshake (1-3s);
                                // 30s loses half a meeting before we say anything.
const WARMUP_GRACE_MS = 1500;   // WASAPI/AudioContext genuinely emit zeros while ramping up.
const SILENCE_RMS = 0.0025;     // ~ -52 dBFS; below this = effectively silent (existing UX)
const SILENCE_MS = 30000;       // no sound this long → "still recording?" popup
// System audio at digital zero this long WHILE the mic carries signal → the endpoint is dead,
// not the room. Measured: a healthy loopback throws isolated zero samples that recover next
// tick, so this must be sustained; 12s also outlasts a Bluetooth profile switch.
const SYSTEM_DEATH_MS = 12000;

function computeRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Time is injected (caller passes `now`) so the state machine is testable without timers.
// tick() returns at most one event per call: { type: 'warmup', ... } | { type: 'silence' } | null
function createHealth(opts = {}) {
  const {
    startedAt = 0,
    warmupMs = WARMUP_MS,
    graceMs = WARMUP_GRACE_MS,
    deadRms = DEAD_RMS,
    silenceRms = SILENCE_RMS,
    silenceMs = SILENCE_MS,
    deathMs = SYSTEM_DEATH_MS,
  } = opts;

  let micMax = 0;
  let sysMax = 0;
  let warmupDone = false;
  let warmupFrom = startedAt;
  let micAbsent = false;
  let sysAbsent = false;
  let lastSoundTs = startedAt;
  let silenceFired = false;
  let sysDeadSince = 0;
  let sysDeathReported = false;

  return {
    // Re-run the warm-up verdict over a fresh window. Used when the default output device
    // changes mid-recording: WASAPI does not follow that change, so the loopback we already
    // hold may now be watching an endpoint nobody plays to. Re-arming answers "did it survive?"
    rearm(now) {
      micMax = 0;
      sysMax = 0;
      micAbsent = false;
      sysAbsent = false;
      warmupDone = false;
      warmupFrom = now;
    },

    tick(now, micRms, sysRms) {
      const dt = now - warmupFrom;
      if (!warmupDone) {
        // A null RMS means the stream is absent entirely (no track), which is its own failure.
        if (micRms == null) micAbsent = true;
        if (sysRms == null) sysAbsent = true;
        // Ignore the grace window: startup zeros are normal, not evidence of a dead device.
        if (dt >= graceMs) {
          if (micRms != null) micMax = Math.max(micMax, micRms);
          if (sysRms != null) sysMax = Math.max(sysMax, sysRms);
        }
        if (dt >= warmupMs) {
          warmupDone = true;
          // Verdict is max-over-window, not mean: ONE non-zero sample proves the path is alive.
          // That is what keeps a genuinely silent meeting from being reported as broken.
          const micDead = micAbsent || micMax < deadRms;
          const sysDead = sysAbsent || sysMax < deadRms;
          // Always returned, pass or fail: a healthy run must leave a baseline in the log,
          // otherwise "no warmup line" is ambiguous between "healthy" and "never ran".
          return { type: 'warmup', micDead, sysDead, micMax, sysMax };
        }
      }

      // Sustained-death detector for the system stream, and the reason it is SUSTAINED:
      // measured on real hardware, a healthy loopback emits an isolated ~0.000006 sample
      // mid-playback and recovers on the very next tick. One dead reading proves nothing.
      // It also requires the MIC to be carrying signal — otherwise a genuinely silent meeting
      // (nobody talking, nothing playing) is indistinguishable from a dead endpoint, and we
      // would re-acquire in a loop through every quiet stretch.
      if (sysRms != null && sysRms < deadRms && micRms != null && micRms >= deadRms) {
        if (!sysDeadSince) sysDeadSince = now;
        if (!sysDeathReported && now - sysDeadSince >= deathMs) {
          sysDeathReported = true;
          return { type: 'system-dead', since: sysDeadSince };
        }
      } else if (sysRms != null && sysRms >= deadRms) {
        sysDeadSince = 0;
        sysDeathReported = false;
      }

      // Existing 30s silence UX, now fed by both streams rather than their sum.
      const loud = Math.max(micRms == null ? 0 : micRms, sysRms == null ? 0 : sysRms) >= silenceRms;
      if (loud) {
        lastSoundTs = now;
        silenceFired = false;
      } else if (!silenceFired && now - lastSoundTs >= silenceMs) {
        silenceFired = true; // fire once; re-arms when sound returns
        return { type: 'silence' };
      }
      return null;
    },
  };
}

// getUserMedia/getDisplayMedia rejections used to collapse into one generic string naming
// neither the stream nor the device. NotReadableError is the one that matters here — it is how
// a broken/busy endpoint surfaces (the Electron #15829 class).
function describeMediaError(which, err) {
  const name = err && err.name;
  const map = {
    NotAllowedError: `Permission to use the ${which} was denied.`,
    NotFoundError: `No ${which} device was found.`,
    NotReadableError: `The ${which} is in use by another app, or its driver failed.`,
    OverconstrainedError: `The requested ${which} device is unavailable.`,
    AbortError: `The ${which} stopped unexpectedly.`,
  };
  const head = map[name] || `Could not start the ${which}.`;
  return `${head} (${name || 'Error'}: ${(err && err.message) || 'no detail'})`;
}

// Best-effort ONLY: labels are vendor/localization dependent and Windows often names a
// Bluetooth device with no "bluetooth" token at all. Used purely to enrich a warning message
// that has already been triggered by measurement — never to gate behaviour.
const BT_HINT = /\b(bluetooth|airpods|hands[- ]?free|headset|buds|beats|jabra|bose|wh-|wf-)\b/i;
function looksBluetooth(device) {
  return !!device && BT_HINT.test(device.label || '');
}

module.exports = {
  computeRms,
  createHealth,
  describeMediaError,
  looksBluetooth,
  DEAD_RMS,
  WARMUP_MS,
  WARMUP_GRACE_MS,
  SILENCE_RMS,
  SILENCE_MS,
  SYSTEM_DEATH_MS,
};
