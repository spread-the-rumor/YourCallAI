// Hidden recorder window (§5). getDisplayMedia is answered by main's
// setDisplayMediaRequestHandler (primary screen + loopback system audio).
// Two MediaRecorders: A = video + mono mix (playback), B = stereo opus
// (ch0 mic / ch1 system) for Deepgram multichannel. 15s timeslice chunks → IPC → disk.

const { computeRms, createHealth, describeMediaError, SILENCE_RMS, ALIVE_RMS } = require('./audioHealth');
const { snapshotDevices, defaultOutputKey, probeStreamAlive } = require('./devices');

let state = null; // { recA, recB, streams, ctx, pending, levelTimer }

const LEVEL_MS = 1000;         // how often we sample the level
const DIAG_LEVEL_EVERY = 15;   // log a level sample every 15 ticks (~matches the 15s timeslice)
const DEVICE_DEBOUNCE_MS = 750; // one Bluetooth connect fires ondevicechange several times

// Video container/codec preference, best first. Tried in order with a REAL constructor call,
// not just isTypeSupported — see the loop in startCapture for why that distinction matters.
//
// H.264 first because it makes the post-recording normalization a LOSSLESS STREAM COPY (seconds)
// instead of a full transcode (minutes of CPU). Measured on Chromium 138 / Electron 37:
//   video/mp4;codecs=avc1.640028,mp4a.40.2  -> supported; emits FRAGMENTED mp4
//                                              (ftyp moov moof mdat ... mfra), no stss index
//   video/webm;codecs=vp9,opus              -> supported; emits live webm with NO Cues and
//                                              NO usable duration (ffmpeg reads "Duration: N/A")
// Both therefore still need the normalize pass to become seekable — the difference is only what
// that pass costs. Chromium may hand back a lower LEVEL than asked for (640028 came back as
// 64001f); that is fine, the profile is what matters.
//
// The full mime INCLUDING the audio codec is probed on purpose. Asking for bare 'avc1' can get
// you 'video/mp4;codecs=avc1,opus', which passes, muxes happily, and then will not play in
// QuickTime — Opus in MP4 is legal but unsupported there.
const VIDEO_MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2', // High — best for screen text (CABAC, 8x8 transform)
  'video/mp4;codecs=avc1.4D401F,mp4a.40.2', // Main
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // Baseline
  'video/x-matroska;codecs=avc1,opus',      // H.264 without an mp4 muxer: copy video, re-encode audio
  'video/webm;codecs=vp9,opus',             // the pre-change default; full transcode downstream
  'video/webm;codecs=vp8,opus',
];

// 1.5 Mbps was tuned for VP9. H.264 needs roughly 1.5-2x the bits for equivalent screencast
// quality, and small text is exactly where the difference shows.
function videoBitrateFor(mime) {
  return /avc1|h264/i.test(mime) ? 3_000_000 : 1_500_000;
}

async function startCapture({ forceVideoMime = '' } = {}) {
  let mic;
  let display;
  try {
    // Order matters. getUserMedia on a Bluetooth headset flips Windows A2DP→HFP, which can
    // re-route the default OUTPUT endpoint — and WASAPI loopback does NOT follow a default
    // change. Binding loopback first therefore binds it to an endpoint the mic call then
    // abandons. Mic first, brief settle, then loopback, so loopback binds post-switch.
    // (It also fails fast on a denied mic, before we hold a screen-capture stream.)
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    // Mic is fatal: channel 0 anchors the whole speaker-resolution model (§7).
    window.capture.diag({ type: 'error', which: 'mic', name: err && err.name, message: err && err.message });
    return window.capture.error(describeMediaError('microphone', err));
  }

  await new Promise((r) => setTimeout(r, 400)); // let any profile switch settle before loopback binds

  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 15 } },
      audio: true,
    });
  } catch (err) {
    mic.getTracks().forEach((t) => t.stop());
    window.capture.diag({ type: 'error', which: 'display', name: err && err.name, message: err && err.message });
    return window.capture.error(describeMediaError('screen + meeting audio', err));
  }

  try {
    const ctx = new AudioContext();
    const micSrc = ctx.createMediaStreamSource(mic);
    const sysTracks = display.getAudioTracks();
    // `let`: the system source is REPLACEABLE. When the default output device changes, WASAPI
    // keeps the old loopback bound to an endpoint nobody plays to, so we swap in a fresh one.
    let sysSrc = sysTracks.length ? ctx.createMediaStreamSource(new MediaStream(sysTracks)) : null;

    // Mono mix for the playback file
    const monoDest = ctx.createMediaStreamDestination();
    micSrc.connect(monoDest);
    if (sysSrc) sysSrc.connect(monoDest);
    const videoMix = new MediaStream([display.getVideoTracks()[0], ...monoDest.stream.getAudioTracks()]);

    // Stereo: mic → ch0, system → ch1, for multichannel transcription
    const merger = ctx.createChannelMerger(2);
    micSrc.connect(merger, 0, 0);
    if (sysSrc) sysSrc.connect(merger, 0, 1);
    const stereoDest = ctx.createMediaStreamDestination();
    merger.connect(stereoDest);

    // recA is constructed in ITS OWN loop+catch, deliberately. It used to be one statement
    // inside the big try below, so any rejection ran window.capture.error() -> 'capture-error'
    // -> finalizeRecording(message), which closed the AUDIO stream too and failed the whole
    // recording — destroying the transcript of a meeting whose audio was captured perfectly.
    // A dead video recorder must cost the video and NOTHING else: recB is what feeds Deepgram.
    //
    // isTypeSupported is necessary but NOT sufficient — it reports codec-string parseability
    // plus a static capability check, and the muxer/encoder can still fail to initialise for
    // this particular track configuration. So probe, then actually construct, then fall through.
    let recA = null;
    let videoMime = null;
    // YCAI_FORCE_VIDEO_MIME pins the container: it is how the VP9/transcode path gets tested on
    // a machine where mp4 recording works, and how a user on bad hardware is unblocked without
    // waiting for a release. Passed in from main with 'start-capture'.
    const mimes = forceVideoMime ? [forceVideoMime, ...VIDEO_MIMES] : VIDEO_MIMES;
    for (const m of mimes) {
      if (!MediaRecorder.isTypeSupported(m)) continue;
      try {
        recA = new MediaRecorder(videoMix, { mimeType: m, videoBitsPerSecond: videoBitrateFor(m) });
        videoMime = m;
        break;
      } catch (err) {
        window.capture.diag({ type: 'mime-rejected', mime: m, name: err && err.name, message: err && err.message });
      }
    }
    if (recA) {
      window.capture.format({ videoMime });
      window.capture.diag({ type: 'video-format', mime: videoMime });
    } else {
      // Audio-only from here. Every §7/§11 stage downstream reads audio.webm, so the transcript,
      // speaker names, summary and action items are all unaffected by losing the video.
      window.capture.diag({ type: 'error', which: 'video', name: 'NoVideoEncoder', message: 'no usable video mime' });
      window.capture.degraded({ videoDead: true, reason: 'no-video-encoder' });
    }

    // recB stays in the outer try on purpose: no audio really IS fatal (ch0 anchors §7).
    const recB = new MediaRecorder(stereoDest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96_000 });

    // Track in-flight chunk writes so stop can flush everything before signalling main.
    const pending = new Set();
    const pipe = (rec, name) => {
      if (!rec) return; // recA is null when no video encoder could be constructed
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const p = e.data.arrayBuffer().then((buf) => window.capture.sendChunk(name, buf));
        pending.add(p);
        p.finally(() => pending.delete(p));
      };
      // A MediaRecorder that errors mid-meeting simply STOPS emitting chunks, and until now
      // nothing noticed: the liveness heartbeat is driven by the AudioContext SOURCES (the
      // analyser taps below), not by the recorders — so isAudioActive() kept returning true
      // and the user got a 5-minute video of a 50-minute meeting with no warning at all.
      // Warn and keep recording; never finalize, since the other recorder may be perfectly fine.
      rec.onerror = (e) => {
        const err = e && e.error;
        window.capture.diag({ type: 'rec-error', which: name, name: err && err.name, message: err && err.message });
        window.capture.degraded(name === 'video'
          ? { videoDead: true, reason: 'recorder-error' }
          : { micDead: true, sysDead: true, reason: 'recorder-error' });
      };
    };
    pipe(recA, 'video');
    pipe(recB, 'audio');

    // If the user ends screen share from the OS UI, treat it as a stop. Keep this bound to the
    // ONE video track we started with — an identity check guards against a stray track ending
    // the user's recording.
    const videoTrack = display.getVideoTracks()[0];
    videoTrack.onended = () => { if (videoTrack === display.getVideoTracks()[0]) stopCapture(); };

    // An audio track dying mid-recording used to be completely silent — the stream just stopped
    // producing samples and nothing said so.
    // Declared HERE, above watchTrack, not at the recovery function below: watchTrack's
    // onended closure reads it. It is only reachable after recA/recB start (far below), so the
    // old ordering happened to work — but that is an argument about event timing, not a
    // guarantee. Hoisting makes it a guarantee.
    let recovering = false;
    // Escalation state. The probe costs 4s and used to re-fire on every trigger with no counter
    // and no cooldown: measured live 2026-09-22, six attempts across 18 minutes all re-bound to
    // the same silent endpoint, because re-acquiring getDisplayMedia can only ever return the
    // Windows DEFAULT. Retrying that harder is not a fix — the default itself has to change.
    let softFailures = 0;          // consecutive re-acquire attempts that found nothing alive
    let lastAttemptTs = 0;         // for the cooldown
    let endpointSwitchTried = false; // the escalation is one-shot per dead stretch
    const SOFT_ATTEMPTS = 2;       // plain re-acquires before escalating to an endpoint switch
    const RECOVER_COOLDOWN_MS = 20000;
    // Long enough to outlast the burst Windows emits for one hardware change (measured: 4 in a
    // row on a single connect, already debounced by DEVICE_DEBOUNCE_MS) plus the 4s probe.
    const DEVICE_COOLDOWN_MS = 6000;

    const watchTrack = (track, which) => {
      if (!track) return;
      track.onended = () => {
        window.capture.diag({ type: 'trackended', which });
        // This used to ONLY log. On 2026-09-17 the mic track ended 1s after a device swap and
        // the app recorded 45 further minutes of nothing while showing a healthy recording.
        // A track that has ended never revives — it is terminal by spec — so warn immediately
        // rather than waiting out TOTAL_DEATH_MS.
        //
        // Still a WARNING, never a stop: per the capture-degraded contract, a false positive
        // that kills a real meeting is unrecoverable, while a false negative costs one popup.
        if (which === 'mic') {
          window.capture.degraded({ micDead: true, sysDead: false, reason: 'mic-track-ended' });
        } else if (which === 'system') {
          // The system track can legitimately be retired by our own recovery swap; only warn
          // when we are not mid-swap, or every successful recovery would raise a false alarm.
          if (!recovering) window.capture.degraded({ micDead: false, sysDead: true, reason: 'system-track-ended' });
        }
      };
      track.onmute = () => window.capture.diag({ type: 'trackmuted', which, muted: true });
      track.onunmute = () => window.capture.diag({ type: 'trackmuted', which, muted: false });
    };
    const micTrack = mic.getAudioTracks()[0];
    watchTrack(micTrack, 'mic');
    watchTrack(sysTracks[0], 'system');

    // Record what we actually bound to (after getUserMedia, or labels come back blank).
    let deviceKey = '';
    let btOutput = false; // only used to enrich a warning we already decided to show
    snapshotDevices(micTrack, sysTracks[0]).then((snap) => {
      deviceKey = defaultOutputKey(snap);
      btOutput = snap.defaultOutputLooksBluetooth;
      window.capture.diag({ type: 'devices', ...snap });
    }).catch(() => {});

    // Loopback can hand back a stream with no audio track at all. That used to set sysSrc=null
    // and say nothing whatsoever.
    if (!sysTracks.length) {
      window.capture.diag({ type: 'error', which: 'system', name: 'NoAudioTrack', message: 'loopback returned no audio track' });
      window.capture.degraded({ micDead: false, sysDead: true, reason: 'no-loopback-track' });
    }

    // One analyser PER SOURCE. The old single analyser summed mic+system, so a dead loopback
    // was indistinguishable from a quiet meeting. Web Audio fan-out is unlimited, so tapping
    // the sources here does not divert signal from the merger/monoDest above.
    const mkTap = (src) => {
      if (!src) return null;
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      src.connect(a);
      return { analyser: a, buf: new Float32Array(a.fftSize) };
    };
    const micTap = mkTap(micSrc);
    let sysTap = mkTap(sysSrc); // `let`: replaced alongside sysSrc on a device swap
    const rmsOf = (tap) => {
      if (!tap) return null; // null = stream absent, which is distinct from 0 = silent
      tap.analyser.getFloatTimeDomainData(tap.buf);
      return computeRms(tap.buf);
    };

    // A suspended/interrupted AudioContext is the quiet killer here. Chromium can suspend the
    // context when the audio hardware changes underneath it (exactly what a headset unplug or a
    // display-audio endpoint swap does). While suspended, the graph stops pulling samples:
    // every analyser returns a frozen buffer AND the MediaStreamDestination feeding both
    // MediaRecorders goes silent — so the recording continues, writing nothing, with the
    // tracks still readyState:"live". Nothing in this file used to look at ctx.state at all.
    ctx.onstatechange = () => {
      window.capture.diag({ type: 'ctx-state', state: ctx.state });
      if (ctx.state === 'running' || !state) return;
      // 'closed' is terminal and only happens on our own teardown; anything else we try to undo.
      if (ctx.state === 'closed') return;
      ctx.resume().then(() => {
        window.capture.diag({ type: 'ctx-resumed', state: ctx.state });
      }).catch((err) => {
        window.capture.diag({ type: 'ctx-resume-failed', name: err && err.name, message: err && err.message });
        window.capture.degraded({ micDead: true, sysDead: true, reason: 'audiocontext-suspended' });
      });
    };

    const health = createHealth({ startedAt: Date.now() });
    let ticks = 0;

    // The ENTIRE body is wrapped, because on 2026-09-17 this timer stopped producing output at
    // t=150s and the recording ran 46 more minutes with no levels line, no silence event and
    // no warning — every detector we have lives in here, so one throw blinds all of them at
    // once. setInterval keeps its schedule after a callback throws, so the failure is
    // completely invisible: the timer "runs" forever and does nothing.
    let tickFailures = 0;
    const levelTimer = setInterval(() => {
      try {
        tickBody();
        tickFailures = 0;
      } catch (err) {
        // Report once per failure run, not every second.
        if (++tickFailures === 1) {
          window.capture.diag({ type: 'tick-error', name: err && err.name, message: err && err.message });
          window.capture.degraded({ micDead: true, sysDead: true, reason: 'health-monitor-failed' });
        }
      }
    }, LEVEL_MS);

    function tickBody() {
      // Belt and braces: onstatechange above should catch a suspend, but if the event is ever
      // missed the levels would read as a dead capture forever with no explanation. Checking
      // here means the log always says WHY the numbers went flat.
      if (ctx.state !== 'running') {
        window.capture.diag({ type: 'ctx-not-running', state: ctx.state });
        ctx.resume().catch(() => {});
      }
      const micRms = rmsOf(micTap);
      const sysRms = rmsOf(sysTap);
      const evt = health.tick(Date.now(), micRms, sysRms);

      // Heartbeat contract is unchanged — main.js isAudioActive()/pendingStop depend on it.
      const active = Math.max(micRms || 0, sysRms || 0) >= SILENCE_RMS;
      window.capture.audio(active);

      // Unconditional per-tick pulse. `capture.audio(active)` above only reports WHEN THERE IS
      // SOUND, so main cannot tell "quiet meeting" from "monitor stopped running" — the exact
      // ambiguity that let 46 minutes pass unnoticed. This says "the health loop executed",
      // nothing more, and main's watchdog alarms when it stops arriving.
      window.capture.alive();

      if (++ticks % DIAG_LEVEL_EVERY === 0) {
        const r5 = (v) => (v == null ? null : Number(v.toFixed(5)));
        window.capture.diag({ type: 'levels', micRms: r5(micRms), sysRms: r5(sysRms) });
      }

      if (!evt) return;
      if (evt.type === 'silence') { window.capture.silence(); return; }
      // Loopback died without a devicechange we saw (driver re-route, endpoint reset). Same
      // recovery path; probeStreamAlive still gates the swap, so a false alarm costs nothing.
      if (evt.type === 'system-dead') { recoverSystemAudio('system-dead'); return; }
      // Everything is flat. Structurally invisible to system-dead (which requires mic signal),
      // so this is the only path that catches "the whole capture died". Try one recovery — the
      // usual cause is a device swap that took both endpoints — and warn either way, because
      // unlike a dead loopback this state means NOTHING is being recorded.
      if (evt.type === 'all-dead') {
        window.capture.diag({ type: 'all-dead', since: evt.since });
        window.capture.degraded({ micDead: true, sysDead: true, reason: 'all-dead', bluetooth: btOutput });
        recoverSystemAudio('all-dead');
        return;
      }
      // Warm-up verdict. Logged pass OR fail, so a healthy run leaves a baseline in capture.jsonl
      // and "no warmup line" unambiguously means the check never ran.
      window.capture.diag({ type: 'warmup', ...evt });
      // Don't alarm while a swap is in flight — recovery usually lands within ~3s and clears it.
      if ((evt.micDead || evt.sysDead) && !recovering) {
        window.capture.degraded({ micDead: evt.micDead, sysDead: evt.sysDead, reason: 'warmup', bluetooth: btOutput });
      }
    }

    // WASAPI does not follow default-device changes: the loopback stays bound to whatever
    // endpoint was default when it started, so switching to Bluetooth mid-meeting silently
    // kills meeting audio (the track stays readyState:"live" — nothing errors). Measured:
    // a fresh getDisplayMedia DOES bind to the new default (deviceId "loopback" is a sentinel
    // Chromium resolves at acquisition time), so the dead stream is recoverable in place.
    //
    // MediaRecorder is bound to stereoDest/monoDest, NOT to sysSrc, so swapping the source
    // under the merger keeps both recordings running — no restart, no container break.
    const recoverSystemAudio = async (reason) => {
      if (recovering || !state) return;
      // Cooldown. Each attempt costs a 4s probe and the triggers re-arm on their own schedule, so
      // without this the app spends the meeting probing instead of recording.
      //
      // 'devicechange' gets a SHORTER cooldown, not an exemption. It deserves priority (the
      // hardware genuinely just changed, which is the one moment a fresh getDisplayMedia is most
      // likely to land somewhere new — and it is how the endpoint switch below gets picked up),
      // but exempting it outright is unbounded: Windows fires devicechange repeatedly, and a
      // switch that lands on another silent device re-triggers it. Simulated over 30 minutes of a
      // permanently dead endpoint, a full exemption ran 1763 probes versus 90 here.
      const now = Date.now();
      const cooldown = reason === 'devicechange' ? DEVICE_COOLDOWN_MS : RECOVER_COOLDOWN_MS;
      if (now - lastAttemptTs < cooldown) return;
      lastAttemptTs = now;
      recovering = true;
      let candidate = null;
      try {
        window.capture.diag({ type: 'recover-start', reason });
        candidate = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { max: 5 } }, // smallest legal ask; we discard the video track
          audio: true,
        });
        // Prove the replacement is alive BEFORE touching the working graph — re-acquiring can
        // hand back a stream on the same dead endpoint, and a silent meeting looks identical
        // to a dead one by RMS alone.
        // 4000ms, not 2500: the probe no longer exits early on a noise-floor reading, so it
        // needs a window long enough for real meeting audio to appear during a quiet moment.
        const verdict = await probeStreamAlive(ctx, candidate, { ms: 4000, aliveRms: ALIVE_RMS });
        if (!verdict.alive) {
          window.capture.diag({ type: 'recover-failed', reason, maxRms: verdict.maxRms, softFailures: softFailures + 1 });
          candidate.getTracks().forEach((t) => t.stop());
          candidate = null;
          // ESCALATE. Repeated failure means the Windows default is pointed at an endpoint nobody
          // plays to, and no amount of re-acquiring can move us off it — loopback follows the
          // default by construction. Ask main to find an endpoint that IS carrying audio and make
          // it the default; the ondevicechange listener below then fires naturally and the normal
          // recovery path re-binds. One-shot per dead stretch, so a machine with genuinely silent
          // output never loops.
          if (++softFailures >= SOFT_ATTEMPTS && !endpointSwitchTried) {
            endpointSwitchTried = true;
            window.capture.diag({ type: 'endpoint-switch-request', reason });
            // Fire-and-forget: main owns the native call and the user-facing notification. The
            // resulting devicechange is what drives the next recovery, not this promise.
            window.capture.switchEndpoint({ reason });
          }
          return;
        }
        const newTrack = candidate.getAudioTracks()[0];
        const newSrc = ctx.createMediaStreamSource(new MediaStream([newTrack]));
        // Splice: disconnect the dead source, wire the live one into the same three sinks.
        try { if (sysSrc) sysSrc.disconnect(); } catch { /* already detached */ }
        try { if (sysTap) sysTap.analyser.disconnect(); } catch { /* already detached */ }
        newSrc.connect(monoDest);
        newSrc.connect(merger, 0, 1);
        sysSrc = newSrc;
        sysTap = mkTap(newSrc);
        watchTrack(newTrack, 'system');
        // Drop only the video track we just acquired; the ORIGINAL video track keeps recording.
        candidate.getVideoTracks().forEach((t) => { t.onended = null; t.stop(); });
        // Retire the old loopback audio track so Windows releases the dead endpoint.
        sysTracks.forEach((t) => { t.onended = null; t.onmute = null; t.onunmute = null; try { t.stop(); } catch {} });
        state.streams.push(candidate);
        health.rearm(Date.now());
        // Recovered: forget the failure history so a LATER dead stretch gets its own full
        // escalation rather than inheriting a spent one.
        softFailures = 0;
        endpointSwitchTried = false;
        window.capture.diag({ type: 'recover-ok', reason, maxRms: verdict.maxRms });
        window.capture.recovered({ maxRms: verdict.maxRms });
      } catch (err) {
        window.capture.diag({ type: 'recover-failed', reason, name: err && err.name, message: err && err.message });
        if (candidate) candidate.getTracks().forEach((t) => t.stop());
      } finally {
        recovering = false;
      }
    };

    let debounce = null;
    const onDeviceChange = async () => {
      if (!state) return;
      try {
        const snap = await snapshotDevices(micTrack, sysTracks[0]);
        const next = defaultOutputKey(snap);
        // devicechange fires repeatedly with the default unchanged (measured: 4 in a row on one
        // Bluetooth connect) — only a real endpoint change is worth acting on.
        if (!deviceKey || next === deviceKey) return;
        window.capture.diag({ type: 'devicechange', from: deviceKey, to: next, ...snap });
        deviceKey = next;
        btOutput = snap.defaultOutputLooksBluetooth;
        window.capture.deviceChanged({ to: snap.inferredLoopbackEndpoint });
        await recoverSystemAudio('devicechange');
      } catch { /* diagnostics only */ }
    };
    navigator.mediaDevices.ondevicechange = () => {
      clearTimeout(debounce);
      debounce = setTimeout(onDeviceChange, DEVICE_DEBOUNCE_MS);
    };

    recA?.start(15000);
    recB.start(15000);
    state = { recA, recB, streams: [display, mic, monoDest.stream, stereoDest.stream], ctx, pending, levelTimer, debounce };
  } catch (err) {
    mic.getTracks().forEach((t) => t.stop());
    display.getTracks().forEach((t) => t.stop());
    window.capture.error(`capture failed to start: ${err.message}`);
  }
}

async function stopCapture() {
  if (!state) { window.capture.stopped(); return; }
  const { recA, recB, streams, ctx, pending, levelTimer, debounce } = state;
  state = null;
  clearInterval(levelTimer); // stop sampling before the context closes
  clearTimeout(debounce);
  navigator.mediaDevices.ondevicechange = null;
  const stopped = (rec) => new Promise((resolve) => {
    if (!rec || rec.state === 'inactive') return resolve(); // recA is null when video never started
    rec.onstop = resolve;
    try { rec.stop(); } catch { resolve(); }
  });
  await Promise.all([stopped(recA), stopped(recB)]);
  await Promise.all([...pending]); // flush final chunks to main before signalling
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  try { await ctx.close(); } catch { /* already closed */ }
  window.capture.stopped();
}

window.capture.onStart((opts) => startCapture(opts));
window.capture.onStop(stopCapture);
