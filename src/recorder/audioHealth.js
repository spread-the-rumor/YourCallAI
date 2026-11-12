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
const DEAD_RMS = 1e-5;          // ~ -100 dBFS. Kept for the WARM-UP verdict only (see below).

// Measured across 51 real recovery probes from 7 captured meetings (Sept 2026, wired headset +
// external display). The probe results did NOT form two clusters around DEAD_RMS — they formed
// ONE cluster straddling it: 15 probes at 8.9e-6..9.8e-6 (called dead) and 25 at 1.0e-5..2.0e-5
// (called ALIVE), i.e. 69% of every "alive" verdict landed in a band that is physically
// indistinguishable from the dead one. Only 4 probes of 51 ever saw real audio (>= 1e-3).
//
// So DEAD_RMS is the wrong gate for ACCEPTING a replacement stream. An idle-but-functional
// endpoint and a genuinely dead one both sit at ~1e-5; what separates a stream worth swapping
// in is real signal, an order of magnitude up. ALIVE_RMS is that bar. Consequence, and it is
// deliberate: a candidate that reads 1.2e-5 is no longer accepted as proof of life, so we stop
// swapping a working graph for a coin flip.
const ALIVE_RMS = 1e-4;         // ~ -80 dBFS: the bottom of a real noise floor, 10x above the
                                // ambiguous band. Used to ACCEPT a recovery candidate.
const WARMUP_MS = 8000;         // 3s risks a false alarm mid Bluetooth HFP handshake (1-3s);
                                // 30s loses half a meeting before we say anything.
const WARMUP_GRACE_MS = 1500;   // WASAPI/AudioContext genuinely emit zeros while ramping up.
const SILENCE_RMS = 0.0025;     // ~ -52 dBFS; below this = effectively silent (existing UX)
const SILENCE_MS = 30000;       // no sound this long → "still recording?" popup
// System audio at digital zero this long WHILE the mic carries signal → the endpoint is dead,
// not the room. Measured: a healthy loopback throws isolated zero samples that recover next
// tick, so this must be sustained; 12s also outlasts a Bluetooth profile switch.
const SYSTEM_DEATH_MS = 12000;
// BOTH channels at digital zero this long. This is the case the mic-gated detector above can
// structurally never see: it requires the mic to carry signal, so "everything is dead" — the
// single worst outcome — was the one state that suppressed the alarm forever. Measured on the
// 2026-09-17 meeting: mic and system both hit 0 at t=154s and stayed there for 45 minutes with
// no event of any kind. Longer than SYSTEM_DEATH_MS because a real room CAN be bit-exactly
// quiet briefly (everyone muted, nothing playing); 45s of literal digital zero cannot happen
// on a live path, which always carries a noise floor.
const TOTAL_DEATH_MS = 45000;
// While the system stream STAYS dead, re-report this often. It used to latch after one report and
// only clear on a live sample — which an ENDED track can never produce — so a track that died for
// good was reported once and then never retried for the rest of the meeting (ge2s, 2026-11-10).
const SYSTEM_DEATH_REPEAT_MS = 30000;

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
    totalDeathMs = TOTAL_DEATH_MS,
    deathRepeatMs = SYSTEM_DEATH_REPEAT_MS,
  } = opts;
  let sysDeathReportedAt = 0;

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
  let allDeadSince = 0;
  let allDeathReported = false;

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
      // Clear the death latches as well. rearm() means "we just changed the graph, judge it
      // fresh" — leaving a latch set would suppress the alarm on the NEW stream.
      sysDeadSince = 0;
      sysDeathReported = false;
      allDeadSince = 0;
      allDeathReported = false;
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

      // TOTAL death: every channel at digital zero. Checked FIRST and deliberately ungated —
      // the system-dead detector below requires mic signal, which makes it blind to exactly
      // this case. A null RMS (track absent) counts as dead, not as "no reading".
      // <=, not <: the 2026-09-17 capture logged sysRms exactly 0.00001. A reading sitting ON
      // the dead floor is not evidence of life, and a strict < let that exact case through.
      const micFlat = micRms == null || micRms <= deadRms;
      const sysFlat = sysRms == null || sysRms <= deadRms;
      if (warmupDone && micFlat && sysFlat) {
        if (!allDeadSince) allDeadSince = now;
        if (!allDeathReported && now - allDeadSince >= totalDeathMs) {
          allDeathReported = true;
          return { type: 'all-dead', since: allDeadSince };
        }
      } else if (!micFlat || !sysFlat) {
        allDeadSince = 0;
        allDeathReported = false;
      }

      // Sustained-death detector for the system stream, and the reason it is SUSTAINED:
      // measured on real hardware, a healthy loopback emits an isolated ~0.000006 sample
      // mid-playback and recovers on the very next tick. One dead reading proves nothing.
      // It also requires the MIC to be carrying signal — otherwise a genuinely silent meeting
      // (nobody talking, nothing playing) is indistinguishable from a dead endpoint, and we
      // would re-acquire in a loop through every quiet stretch.
      if (sysRms != null && sysRms < deadRms && micRms != null && micRms >= deadRms) {
        if (!sysDeadSince) sysDeadSince = now;
        const due = !sysDeathReported
          ? now - sysDeadSince >= deathMs
          : now - sysDeathReportedAt >= deathRepeatMs;
        if (due) {
          const repeat = sysDeathReported;
          sysDeathReported = true;
          sysDeathReportedAt = now;
          return { type: 'system-dead', since: sysDeadSince, repeat };
        }
      } else if (sysRms != null && sysRms >= deadRms) {
        sysDeadSince = 0;
        sysDeathReported = false;
      }

      // Existing 30s silence UX, now fed by both streams rather than their sum. Evaluated
      // LAST on purpose: 'silence' is a soft "still recording?" nudge, while 'all-dead' means
      // nothing is reaching disk. Silence fires at 30s and all-dead at 45s, so if silence
      // returned first it would mask the real failure on every single dead capture.
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
  TOTAL_DEATH_MS,
  SYSTEM_DEATH_REPEAT_MS,
  ALIVE_RMS,
};
