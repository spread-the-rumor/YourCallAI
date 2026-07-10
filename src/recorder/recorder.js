// Hidden recorder window (§5). getDisplayMedia is answered by main's
// setDisplayMediaRequestHandler (primary screen + loopback system audio).
// Two MediaRecorders: A = video + mono mix (playback), B = stereo opus
// (ch0 mic / ch1 system) for Deepgram multichannel. 15s timeslice chunks → IPC → disk.

let state = null; // { recA, recB, streams, ctx, pending }

async function startCapture() {
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 15 } },
      audio: true,
    });
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    const ctx = new AudioContext();
    const micSrc = ctx.createMediaStreamSource(mic);
    const sysTracks = display.getAudioTracks();
    const sysSrc = sysTracks.length ? ctx.createMediaStreamSource(new MediaStream(sysTracks)) : null;

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

    // If the user ends screen share from the OS UI, treat it as a stop.
    display.getVideoTracks()[0].onended = () => stopCapture();

    recA.start(15000);
    recB.start(15000);
    state = { recA, recB, streams: [display, mic, monoDest.stream, stereoDest.stream], ctx, pending };
  } catch (err) {
    window.capture.error(`capture failed to start: ${err.message}`);
  }
}

async function stopCapture() {
  if (!state) { window.capture.stopped(); return; }
  const { recA, recB, streams, ctx, pending } = state;
  state = null;
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
