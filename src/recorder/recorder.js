// Hidden recorder window (§5). getDisplayMedia is answered by main's
// setDisplayMediaRequestHandler (primary screen + loopback system audio).
// Two MediaRecorders: A = video + mono mix (playback), B = stereo opus
// (ch0 mic / ch1 system) for Deepgram multichannel. 15s timeslice chunks → IPC → disk.

const { computeRms, createHealth, describeMediaError, SILENCE_RMS, DEAD_RMS } = require('./audioHealth');
const { snapshotDevices, defaultOutputKey, probeStreamAlive } = require('./devices');

let state = null; // { recA, recB, streams, ctx, pending, levelTimer }

const LEVEL_MS = 1000;         // how often we sample the level
const DIAG_LEVEL_EVERY = 15;   // log a level sample every 15 ticks (~matches the 15s timeslice)
const DEVICE_DEBOUNCE_MS = 750; // one Bluetooth connect fires ondevicechange several times

async function startCapture() {
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

    const videoMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm;codecs=vp8,opus';
    const recA = new MediaRecorder(videoMix, { mimeType: videoMime, videoBitsPerSecond: 1_500_000 });
    const recB = new MediaRecorder(stereoDest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96_000 });

    // Track in-flight chunk writes so stop can flush everything before signalling main.
    const pending = new Set();
    const pipe = (rec, name) => {
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const p = e.data.arrayBuffer().then((buf) => window.capture.sendChunk(name, buf));
        pending.add(p);
        p.finally(() => pending.delete(p));
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
    const watchTrack = (track, which) => {
      if (!track) return;
      track.onended = () => window.capture.diag({ type: 'trackended', which });
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

    const health = createHealth({ startedAt: Date.now() });
    let ticks = 0;
    const levelTimer = setInterval(() => {
      const micRms = rmsOf(micTap);
      const sysRms = rmsOf(sysTap);
      const evt = health.tick(Date.now(), micRms, sysRms);

      // Heartbeat contract is unchanged — main.js isAudioActive()/pendingStop depend on it.
      const active = Math.max(micRms || 0, sysRms || 0) >= SILENCE_RMS;
      window.capture.audio(active);

      if (++ticks % DIAG_LEVEL_EVERY === 0) {
        const r5 = (v) => (v == null ? null : Number(v.toFixed(5)));
        window.capture.diag({ type: 'levels', micRms: r5(micRms), sysRms: r5(sysRms) });
      }

      if (!evt) return;
      if (evt.type === 'silence') { window.capture.silence(); return; }
      // Loopback died without a devicechange we saw (driver re-route, endpoint reset). Same
      // recovery path; probeStreamAlive still gates the swap, so a false alarm costs nothing.
      if (evt.type === 'system-dead') { recoverSystemAudio('system-dead'); return; }
      // Warm-up verdict. Logged pass OR fail, so a healthy run leaves a baseline in capture.jsonl
      // and "no warmup line" unambiguously means the check never ran.
      window.capture.diag({ type: 'warmup', ...evt });
      // Don't alarm while a swap is in flight — recovery usually lands within ~3s and clears it.
      if ((evt.micDead || evt.sysDead) && !recovering) {
        window.capture.degraded({ micDead: evt.micDead, sysDead: evt.sysDead, reason: 'warmup', bluetooth: btOutput });
      }
    }, LEVEL_MS);

    // WASAPI does not follow default-device changes: the loopback stays bound to whatever
    // endpoint was default when it started, so switching to Bluetooth mid-meeting silently
    // kills meeting audio (the track stays readyState:"live" — nothing errors). Measured:
    // a fresh getDisplayMedia DOES bind to the new default (deviceId "loopback" is a sentinel
    // Chromium resolves at acquisition time), so the dead stream is recoverable in place.
    //
    // MediaRecorder is bound to stereoDest/monoDest, NOT to sysSrc, so swapping the source
    // under the merger keeps both recordings running — no restart, no container break.
    let recovering = false;
    const recoverSystemAudio = async (reason) => {
      if (recovering || !state) return;
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
        const verdict = await probeStreamAlive(ctx, candidate, { ms: 2500, deadRms: DEAD_RMS });
        if (!verdict.alive) {
          window.capture.diag({ type: 'recover-failed', reason, maxRms: verdict.maxRms });
          candidate.getTracks().forEach((t) => t.stop());
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

    recA.start(15000);
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
    if (rec.state === 'inactive') return resolve();
    rec.onstop = resolve;
    try { rec.stop(); } catch { resolve(); }
  });
  await Promise.all([stopped(recA), stopped(recB)]);
  await Promise.all([...pending]); // flush final chunks to main before signalling
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  try { await ctx.close(); } catch { /* already closed */ }
  window.capture.stopped();
}

window.capture.onStart(startCapture);
window.capture.onStop(stopCapture);
