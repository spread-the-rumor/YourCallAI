// Bundled-ffmpeg wrapper (§5): binary resolution, encoder selection, argument construction,
// spawn + progress. Deliberately knows nothing about recordings or meetings — src/normalize.js
// owns that state. Split this way so the argument builders and parsers stay pure and testable
// (test/selfcheck.js) without an ffmpeg binary or an Electron app.
//
// CRITICAL: never throw at module load. A missing binary degrades one feature; it must not take
// the app down (same contract as src/agents.js).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- binary resolution ----------

// Mirrors agentBinaryPath() in src/agents.js, including the two packaged candidates:
// `extraResource: ['./vendor/ffmpeg']` lands as resources/ffmpeg/ on some platforms and
// resources/vendor/ffmpeg/ on others, and guessing wrong is a silent feature loss.
function ffmpegPath() {
  if (process.env.YCAI_FFMPEG && fs.existsSync(process.env.YCAI_FFMPEG)) return process.env.YCAI_FFMPEG;
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  let candidates;
  try {
    const { app } = require('electron');
    candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'ffmpeg', name),
         path.join(process.resourcesPath, 'vendor', 'ffmpeg', name)]
      : [path.join(app.getAppPath(), 'vendor', 'ffmpeg', name)];
  } catch {
    candidates = [path.join(__dirname, '..', 'vendor', 'ffmpeg', name)];
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// ---------- encoder selection ----------

// Hardware first, software last. h264_mf (Media Foundation) is the broadest Windows fallback;
// libopenh264 is the LGPL software encoder — libx264 is deliberately NOT in the shipped build,
// since it is GPL and this project is MIT (see scripts/fetch-ffmpeg.mjs).
const ENCODER_FLAGS = {
  h264_nvenc: ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '28', '-b:v', '0', '-profile:v', 'high'],
  h264_qsv: ['-global_quality', '28', '-look_ahead', '0', '-profile:v', 'high'],
  h264_amf: ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '28'],
  h264_mf: ['-rate_control', 'quality', '-quality', '70'],
  h264_videotoolbox: ['-q:v', '55', '-realtime', '0', '-profile:v', 'high'],
  // openh264 has no CRF mode, so it takes an explicit bitrate.
  libopenh264: ['-b:v', '2M', '-profile:v', 'high'],
};

// macOS has NO software fallback in the shipped build: the Mac ffmpeg is compiled from source
// with no external libraries (the only way to get an LGPL one - see scripts/fetch-ffmpeg.mjs),
// and FFmpeg has no native H.264 encoder. libopenh264 stays listed because presence is checked
// before use, so this costs nothing and starts working if it is ever bundled. If VideoToolbox
// fails to validate on a Mac, pickEncoder returns null and the recording stays in its capture
// container - which only affects the legacy .webm transcode path, since a new Mac recording is
// already H.264 and normalizes with `-c copy`, needing no encoder at all.
const CANDIDATES = process.platform === 'darwin'
  ? ['h264_videotoolbox', 'libopenh264']
  : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libopenh264'];

// `ffmpeg -encoders` lines look like: " V....D h264_nvenc  NVIDIA NVENC H.264 encoder ..."
// The name pattern is deliberately not \S+: the header block carries a legend line reading
// " V..... = Video", which \S+ happily captures as an encoder named "=".
function parseEncoders(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*V[.A-Z]{5}\s+([A-Za-z][\w-]*)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// Collect a short-lived command's output without blocking. These used to be spawnSync, which
// froze the Electron main thread for seconds on the first conversion of every session — and up to
// ~80 s with a wedged GPU driver, since each candidate gets its own timeout. With conversion now
// running on a button click, that freeze landed exactly when the user was waiting.
function exec(bin, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
    catch (err) { return resolve({ status: null, stdout: '', stderr: String(err.message) }); }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeout);
    const done = (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); };
    child.on('error', (err) => { stderr += err.message; done(null); });
    child.on('close', done);
  });
}

let presentCache = null;
async function availableEncoders(bin) {
  if (presentCache) return presentCache;
  const r = await exec(bin, ['-hide_banner', '-encoders'], { timeout: 20000 });
  presentCache = new Set(parseEncoders(r.stdout));
  return presentCache;
}

// Presence is NOT proof. An encoder can be compiled in and still fail at runtime: no NVIDIA GPU,
// a stale driver, an RDP session with no GPU, or NVENC's 2-3 concurrent-session cap on GeForce
// cards when the user also has OBS open. So each candidate gets a 1-second synthetic encode
// before we trust it with a real recording.
async function validateEncoder(bin, enc) {
  const r = await exec(bin, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-frames:v', '15', '-c:v', enc, ...(ENCODER_FLAGS[enc] || []),
    '-f', 'null', '-',
  ], { timeout: 15000 });
  return r.status === 0;
}

// Resolved once per process and (by the caller) persisted, so the probe cost is paid once ever.
let chosenEncoder;
async function pickEncoder(bin, { cached, skip = [] } = {}) {
  if (process.env.YCAI_FORCE_ENCODER) return process.env.YCAI_FORCE_ENCODER;
  if (chosenEncoder && !skip.includes(chosenEncoder)) return chosenEncoder;
  const present = await availableEncoders(bin);
  const order = [
    ...(cached && !skip.includes(cached) ? [cached] : []),
    ...CANDIDATES.filter((c) => c !== cached && !skip.includes(c)),
  ];
  for (const enc of order) {
    if (!present.has(enc)) continue;
    if (!(await validateEncoder(bin, enc))) continue;
    chosenEncoder = enc;
    return enc;
  }
  return null;
}

// ---------- argument construction (pure) ----------

// Common prefix. -nostdin matters: without it ffmpeg competes for stdin and can hang when
// spawned with inherited stdio. -err_detect ignore_err is what lets a TRUNCATED capture (killed
// mid-recording) still produce a clean, fully-indexed output instead of failing outright.
const COMMON = [
  '-hide_banner', '-nostdin', '-loglevel', 'error',
  '-progress', 'pipe:1', '-nostats', '-err_detect', 'ignore_err',
];

// -movflags +faststart is the whole point: it rewrites the file at the end to move `moov` to the
// front, giving a real duration and a keyframe index up front. That rewrite is also why a
// partial .part file is never salvageable.
//
// -f mp4 is NOT optional here. ffmpeg picks the muxer from the output file's extension, and we
// write to "video.mp4.part" so a crash can never leave a half-file under the real name — whose
// extension is ".part". Without an explicit format it fails instantly with "Unable to choose an
// output format", on every path.
//
// -fps_mode passthrough: getDisplayMedia is variable-frame-rate (Chromium suppresses unchanged
// frames, so a static screen emits well under 15fps). The default mode would force a constant
// rate, dropping and duplicating frames and accumulating audio drift that only becomes visible
// 40 minutes into a long recording.
const MP4_OUT = ['-movflags', '+faststart', '-fps_mode', 'passthrough',
  '-video_track_timescale', '90000', '-f', 'mp4'];

function buildArgs({ src, dst, ext, encoder, threads }) {
  // -map 0:a:0? — OPTIONAL audio. Loopback can hand back a stream with no audio track at all
  // (recorder.js reports 'no-loopback-track'), and a mandatory map would fail the whole job.
  const map = ['-map', '0:v:0', '-map', '0:a:0?'];

  if (ext === '.mp4') {
    // Fragmented MP4 → progressive. Lossless stream copy; seconds even for a long meeting.
    return [...COMMON, '-i', src, ...map, '-c', 'copy', ...MP4_OUT, '-y', dst];
  }
  if (ext === '.mkv') {
    // H.264 already; only the audio needs converting. Opus in MP4 is legal but QuickTime and
    // Safari refuse it, so it must become AAC.
    return [...COMMON, '-i', src, ...map,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ac', '1', ...MP4_OUT, '-y', dst];
  }
  // VP8/VP9 + Opus → full transcode.
  // - scale=trunc(iw/2)*2 + yuv420p: H.264 4:2:0 requires even dimensions, and fractional
  //   display scaling produces odd ones. Without this every encoder fails instantly, which
  //   reads as "ffmpeg is broken" rather than as a geometry problem.
  // - -g 45 (3s at 15fps) IS the seek granularity of the result.
  return [...COMMON, '-i', src, ...map,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p',
    '-c:v', encoder, ...(ENCODER_FLAGS[encoder] || []), '-g', '45',
    ...(threads ? ['-threads', String(threads)] : []),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '1',
    '-max_muxing_queue_size', '1024', ...MP4_OUT, '-y', dst];
}

// Software encoding must not saturate the machine — a user can be in the next meeting already.
function softwareThreads() {
  return Math.max(1, Math.floor((os.cpus() || []).length / 2) || 1);
}

// ---------- progress parsing (pure) ----------

// `-progress pipe:1` emits clean `key=value` lines, unlike stderr which is
// carriage-return-overwritten and interleaved with error text. Values can be 'N/A' early on.
function createProgressParser(onFields) {
  let buf = '';
  const fields = {};
  return (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // keep the partial trailing line — key=value can split across chunks
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      fields[k] = v;
      if (k === 'progress') onFields({ ...fields });
    }
  };
}

// Microseconds of output written so far, or null if not yet known.
function outTimeMs(fields) {
  const us = fields && fields.out_time_us;
  if (us && us !== 'N/A' && Number.isFinite(Number(us))) return Number(us) / 1000;
  const ms = fields && fields.out_time_ms;
  if (ms && ms !== 'N/A' && Number.isFinite(Number(ms))) return Number(ms) / 1000;
  return null;
}

// ---------- run ----------

const STALL_MS = 90_000;   // no output progress for this long = a genuine hang
const STDERR_KEEP = 8192;  // ring buffer for the failure message; never logged live

// Resolves { ok, code, killed, outMs, stderr }. NEVER rejects: the caller decides what a failure
// means, and for this feature the answer is always "keep the source file and move on".
function run(bin, args, { wallMs, onProgress, onChild } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      return resolve({ ok: false, code: null, killed: false, outMs: 0, stderr: err.message });
    }
    if (onChild) onChild(child);

    // Below-normal priority so a transcode can't starve the UI or the next recording's encoder.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }

    let outMs = 0;
    let stderr = '';
    let killed = false;
    let lastAdvance = Date.now();

    const parse = createProgressParser((fields) => {
      const ms = outTimeMs(fields);
      if (ms != null && ms > outMs) { outMs = ms; lastAdvance = Date.now(); }
      if (onProgress) onProgress({ outMs, fields });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', parse);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-STDERR_KEEP); });

    const kill = (why) => {
      killed = true;
      stderr = (stderr + `\n[killed: ${why}]`).slice(-STDERR_KEEP);
      try { child.kill(); } catch { /* already gone */ }
      // TerminateProcess usually suffices, but a wedged encoder can ignore it. Escalate rather
      // than leave a 100%-CPU orphan holding the output file handle.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === 'win32') {
            try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false }); } catch { /* gone */ }
          } else {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
          }
        }
      }, 5000);
    };

    // The stall watchdog is the real hang detector; wallMs is only a backstop, because on a slow
    // machine a legitimate transcode can genuinely take a very long time.
    const watchdog = setInterval(() => {
      if (Date.now() - lastAdvance > STALL_MS) { clearInterval(watchdog); kill('stalled'); }
    }, 5000);
    const budget = wallMs ? setTimeout(() => kill('over budget'), wallMs) : null;

    const done = (code) => {
      clearInterval(watchdog);
      if (budget) clearTimeout(budget);
      resolve({ ok: !killed && code === 0, code, killed, outMs, stderr: stderr.trim() });
    };
    child.on('error', (err) => { stderr = (stderr + err.message).slice(-STDERR_KEEP); done(null); });
    child.on('close', done);
  });
}

module.exports = {
  ffmpegPath, buildArgs, run, pickEncoder, softwareThreads,
  parseEncoders, createProgressParser, outTimeMs,
  ENCODER_FLAGS, CANDIDATES, STALL_MS,
};
