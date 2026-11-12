// Provisions the bundled ffmpeg into vendor/ffmpeg (§5 video normalization).
//
//   npm run fetch:ffmpeg              download/build + verify (idempotent, skips if already correct)
//   npm run fetch:ffmpeg -- --print-hash   fetch and PRINT the hashes, for re-pinning
//   npm run fetch:ffmpeg -- --force        redo even if the binary is already correct
//
// Mirrors scripts/build-agent.mjs: a missing binary is a SKIP locally (the app still records and
// still plays, recordings just stay in their capture container and don't seek), but a HARD FAIL
// in CI — silently shipping an installer without ffmpeg is worse than a red build.
//
// Why not the `ffmpeg-static` npm package: the main process is webpack-bundled (package.json
// "main": ".webpack/main"), and that package's whole API is `path.join(__dirname, 'ffmpeg.exe')`,
// which after bundling resolves inside .webpack/main and points at nothing. Working around it
// needs webpack `externals` + forge's module pruning + an asar.unpack glob to all cooperate, and
// each of those fails silently at package time. A plain extraResource directory has none of that.
//
// LICENSING — the reason the two platforms take different routes.
// This project is MIT and must not inherit GPL obligations, so the shipped ffmpeg has to be LGPL:
// no --enable-gpl, no libx264, no --enable-nonfree.
//   * Windows downloads a prebuilt: BtbN publishes an explicitly `-lgpl-` flavour whose software
//     H.264 encoder is libopenh264 (Cisco, BSD-2) instead of libx264.
//   * macOS BUILDS FROM SOURCE, because no comparable LGPL prebuilt exists. Every candidate was
//     checked by reading FFMPEG_CONFIGURATION straight out of the Mach-O:
//       - eugeneware/ffmpeg-static  -> --enable-gpl AND --enable-nonfree. That combination is
//         **undistributable** by FFmpeg's own terms, not merely GPL. Cannot ship, at all.
//       - ffmpeg.martin-riedl.de    -> --enable-gpl --enable-libx264 --enable-version3 (GPLv3).
//       - evermeet.cx / osxexperts  -> GPL, and x86_64-only / unversioned URLs respectively.
//     Building it ourselves is also *better* provenance: the source tarball is GPG-signed by the
//     FFmpeg release key, whereas the Windows pin trusts a third party's autobuild. FFmpeg's
//     configure defaults to "LGPL version 2.1 or later" when --enable-gpl is absent, and we make
//     it prove that (see LICENSE_LINE) rather than assuming it.
// No external libraries are enabled, so nothing else can pull in a copyleft dependency — and
// none are needed: h264_videotoolbox does the encoding on every Mac, and VP8/VP9/Opus/AAC
// decoding is all native to FFmpeg.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'vendor', 'ffmpeg');

const PRINT_HASH = process.argv.includes('--print-hash');
const FORCE = process.argv.includes('--force');
const IN_CI = !!process.env.CI;

// What FFmpeg's own configure must report. Anything else means a flag below let copyleft in.
const LICENSE_LINE = 'License: LGPL version 2.1 or later';

// Built on macOS from the GPG-signed release tarball. Shared by both Mac arches — a source build
// is arch-agnostic, which is also why darwin-x64 needs no separate pin (CI only builds arm64;
// this is what makes `npm start` work for a dev on an Intel Mac).
const DARWIN_SOURCE = {
  kind: 'source',
  version: '9.0.1', // same release as the Windows pin (n9.0.1), so both platforms behave alike
  url: 'https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz',
  // Verified against ffmpeg-9.0.1.tar.xz.asc: good signature from the FFmpeg release signing key
  // FCF986EA15E6E293A5644F10B4322F04D67658D8 <ffmpeg-devel@ffmpeg.org>.
  archiveSha256: 'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635',
  binary: 'ffmpeg',
  // Deliberately NOT --disable-everything. A hand-picked codec list would be smaller and faster
  // to build, but it is exactly the kind of thing that fails at runtime on a user's machine over
  // one missing demuxer or filter — and this is built on a platform we cannot test from.
  // Caching in CI makes the build cost irrelevant; a wrong minimal list would not be.
  configure: [
    '--disable-doc',
    '--disable-ffplay', '--disable-ffprobe', // we ship ffmpeg only (§5)
    '--disable-network',                     // every input is a local file; drops http/tls entirely
    '--disable-debug',
    // THE important flag. It turns off every optional library configure would otherwise pick up
    // from whatever happens to be installed on the build machine. Disabling them one at a time
    // was tried first and was not enough: CI still linked Homebrew's libxcb + libX11 (x11grab),
    // which is a "Library not loaded" crash on every user's Mac and the one failure a CI runner
    // can never reproduce, since Homebrew is right there. assertSelfContained() caught it; this
    // makes the build deterministic rather than a function of the runner's image.
    '--disable-autodetect',
    // --disable-autodetect also switches off THREADS_LIST and the hwaccels, so everything we
    // actually need has to be asked for by name. Omitting --enable-pthreads here would silently
    // produce a SINGLE-THREADED ffmpeg and make every Mac transcode several times slower.
    '--enable-pthreads',
    // System frameworks, so LGPL-clean. Explicit also means a failed build rather than a
    // silently encoder-less binary if a future SDK stops providing VideoToolbox.
    '--enable-videotoolbox', '--enable-audiotoolbox',
    '--enable-zlib', // libz from the SDK (/usr/lib); the matroska and mov demuxers use it
  ],
  // Proof the built binary is actually usable, run on the machine that built it. These cover
  // exactly what src/ffmpeg.js and src/normalize.js ask of it.
  //
  // The buckets matter: `lavfi` is an input DEVICE, not a demuxer, and scale/testsrc are FILTERS.
  // A name in the wrong list makes its assertion permanently unsatisfiable, which would have
  // failed every macOS release build for a reason having nothing to do with the build.
  require: {
    encoders: ['h264_videotoolbox', 'aac'],
    decoders: ['h264', 'vp8', 'vp9', 'opus', 'aac'], // vp8/vp9/opus = the legacy .webm path
    muxers: ['mp4', 'null'],
    demuxers: ['matroska', 'mov'],
    devices: ['lavfi'],            // what validateEncoder()'s synthetic probe reads from
    filters: ['scale', 'testsrc'],
  },
};

// One entry per platform-arch we build installers for. `archiveSha256` pins the download;
// `binarySha256` pins what we actually extract, which is what makes prebuilts idempotent.
const PINS = {
  'win32-x64': {
    kind: 'prebuilt',
    // Release-numbered (n9.0.2) rather than a master snapshot, and LGPL.
    //
    // RE-PINNING IS A RECURRING CHORE, BY DESIGN OF THE UPSTREAM: BtbN deletes dated
    // `autobuild-*` releases after roughly two weeks, so a pinned URL WILL eventually 404 and
    // fail the Windows installer build with `download failed (HTTP 404 Not Found)`. That is what
    // happened to the n9.0.1 pin on 2026-09-24. It is not a code bug and nothing here is wrong —
    // just fetch the current `-win64-lgpl-` asset from the newest autobuild tag, re-verify, and
    // update the three values below. Do NOT switch to the `latest` tag's
    // `ffmpeg-master-latest-*` assets to dodge this: those are rolling, so the hash would change
    // under us and the pin would stop meaning anything.
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-11-12-39/ffmpeg-n9.0.2-49-gc179411bbb-win64-lgpl-9.0.zip',
    archive: 'zip',
    member: 'bin/ffmpeg.exe', // we extract ONLY this; ffprobe/ffplay would double the payload
    binary: 'ffmpeg.exe',
    archiveSha256: '9ccd65428fb0e60a0d574b76145df41f402b754edd2d06c2e24fa506fc1c2b02',
    binarySha256: 'ea893b575982e11af6707fb00d2eb285a1183395ee48cdb065a6b8c91aeb1767',
    // Verified on this pin (2026-11-12, by reading FFMPEG_CONFIGURATION out of the binary, not a
    // README): --disable-libx264 AND --disable-libx265, zero occurrences of --enable-gpl or
    // --enable-nonfree, --enable-libopenh264 (Cisco, BSD-2) for software H.264, and
    // libopenh264 / h264_qsv / h264_nvenc / h264_amf all present in -encoders.
  },
  'darwin-arm64': DARWIN_SOURCE,
  'darwin-x64': DARWIN_SOURCE,
};

const key = `${process.platform}-${process.arch}`;
const pin = PINS[key];

// Degraded but working: no video normalization, everything else fine. Fatal in CI only.
function skip(msg, hint) {
  if (IN_CI) {
    console.error(`[fetch:ffmpeg] FAILED (CI) — ${msg}`);
    process.exit(1);
  }
  console.error(`[fetch:ffmpeg] SKIPPED — ${msg}`);
  if (hint) console.error(hint);
  console.error('  Without it, recordings stay in their capture container and will not seek.');
  console.error('  Everything else — transcript, speaker names, summary, integrations — still works.');
  process.exit(0);
}

// The pin itself is wrong (bad hash, wrong licence, unusable binary). Never degrade past this:
// it means the thing we were about to ship is not the thing we vetted.
function die(msg, ...extra) {
  console.error(`[fetch:ffmpeg] FAILED — ${msg}`);
  for (const line of extra) console.error(line);
  process.exit(1);
}

if (!pin) skip(`no pinned ffmpeg for "${key}".`);

// A release must never ship a binary we did not verify. Locally this is only a warning, so a dev
// on an unpinned platform can still work; in CI it is fatal.
if (!pin.archiveSha256 && !PRINT_HASH) {
  if (IN_CI) {
    console.error(`[fetch:ffmpeg] FAILED (CI) — "${key}" has no pinned SHA-256.`);
    console.error('  Run  npm run fetch:ffmpeg -- --print-hash  on that platform and paste the');
    console.error('  values into PINS, so releases ship a verified binary.');
    process.exit(1);
  }
  console.warn(`[fetch:ffmpeg] WARNING — "${key}" is unpinned; downloading WITHOUT verification.`);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const binPath = path.join(outDir, pin.binary);
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });

// ---------- already-provisioned fast path ----------

// A source build is not bit-reproducible, so there is no binary hash to compare. Ask the binary
// what it is instead — which is a stronger check anyway: it proves the file actually executes.
function builtBinaryProblem() {
  const r = run(binPath, ['-hide_banner', '-version']);
  if (r.status !== 0) return `it does not run (${(r.stderr || r.error?.message || '').trim().slice(0, 120)})`;
  const out = r.stdout || '';
  if (!out.includes(`ffmpeg version ${pin.version}`)) return `it is not ${pin.version}`;
  const bad = ['--enable-gpl', '--enable-nonfree', '--enable-libx264'].filter((f) => out.includes(f));
  if (bad.length) return `it is not LGPL (${bad.join(' ')})`;
  return null;
}

if (!FORCE && !PRINT_HASH && fs.existsSync(binPath)) {
  if (pin.kind === 'source') {
    const problem = builtBinaryProblem();
    if (!problem) {
      console.log(`[fetch:ffmpeg] OK — vendor/ffmpeg/${pin.binary} already built (${pin.version}, LGPL).`);
      process.exit(0);
    }
    console.log(`[fetch:ffmpeg] rebuilding — existing binary rejected: ${problem}`);
  } else if (pin.binarySha256) {
    if (sha(fs.readFileSync(binPath)) === pin.binarySha256) {
      console.log(`[fetch:ffmpeg] OK — vendor/ffmpeg/${pin.binary} already present and verified.`);
      process.exit(0);
    }
    console.log('[fetch:ffmpeg] existing binary does not match the pin — re-downloading.');
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- prebuilt extraction (Windows) ----------

// Node has no zip reader and we refuse to add a dependency for one build step. The zip pin is
// Windows-only, so use PowerShell's Expand-Archive, which ships with Windows.
//
// NOT `tar`: on a dev machine the tar on PATH is usually Git for Windows' GNU tar, which reads
// the "D:" in an absolute path as a REMOTE HOST spec and fails with "Cannot connect to D".
function extractFromZip(archivePath, member, dest) {
  const tmp = path.join(outDir, '_unzip');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // shell:false and an args array: this repo's path contains spaces ("D:\Your Call AI V2"),
  // and with a shell cmd.exe re-splits them (see scripts/build-agent.mjs).
  const r = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${tmp}' -Force`,
  ], { stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error('Expand-Archive could not extract the zip');
  // BtbN archives nest everything under a versioned top-level directory.
  const found = findFile(tmp, path.basename(member));
  if (!found) throw new Error(`"${member}" not found inside the archive`);
  fs.copyFileSync(found, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
    else if (e.name === name) return p;
  }
  return null;
}

// ---------- source build (macOS) ----------

// Lists what an ffmpeg build actually contains. Used for the post-build assertions; `ffmpeg
// -muxers` and friends print one component per line after a legend block.
function listComponents(kind) {
  const r = run(binPath, ['-hide_banner', `-${kind}`]);
  const names = new Set();
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^\s*[A-Z.]{1,6}\s+([A-Za-z][\w,-]*)/.exec(line);
    if (m) for (const n of m[1].split(',')) names.add(n);
  }
  return names;
}

function assertComponents(kind, required) {
  if (!required?.length) return;
  const have = listComponents(kind);
  const missing = required.filter((n) => !have.has(n));
  if (!have.size) die(`could not read "ffmpeg -${kind}" — the build is not runnable.`);
  if (missing.length) {
    die(`the built ffmpeg is missing ${kind}: ${missing.join(', ')}.`,
      '  The configure flags in this file disabled something §5 depends on.');
  }
  console.log(`[fetch:ffmpeg]   ${kind}: ${required.join(', ')} — present`);
}

// Worth more than every list check above put together: actually produce a faststart MP4 through
// the same flag shape src/ffmpeg.js uses. One run covers the lavfi device, the scale filter,
// yuv420p, the mp4 muxer, +faststart's moov relocation AND `-progress pipe:1` — that last one
// being the thing --disable-network could most plausibly have broken.
function smokeTest() {
  const out = path.join(os.tmpdir(), `ycai-ffmpeg-smoke-${process.pid}.mp4`);
  fs.rmSync(out, { force: true });
  // mpeg4, NOT h264_videotoolbox: this asserts the PIPELINE, and a CI runner is a VM that may
  // have no media engine at all. The hardware encoder is checked for presence above and
  // validated for real on the user's own machine by validateEncoder().
  const r = run(binPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-f', 'lavfi', '-i', 'testsrc=size=321x241:rate=15', // odd dimensions on purpose
    '-frames:v', '30', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p',
    '-c:v', 'mpeg4', '-movflags', '+faststart', '-f', 'mp4', '-y', out,
  ], { timeout: 60000 });

  const fail = (why) => {
    fs.rmSync(out, { force: true });
    die(`the built ffmpeg cannot produce a seekable MP4: ${why}`,
      ...(r.stderr || '').trim().split(/\r?\n/).slice(-8));
  };
  if (r.status !== 0) fail(`exit ${r.status}`);
  if (!/progress=end/.test(r.stdout || '')) fail('no progress output on pipe:1');
  if (!fs.existsSync(out)) fail('no output file');

  const b = fs.readFileSync(out);
  const moov = b.indexOf(Buffer.from('moov'));
  const mdat = b.indexOf(Buffer.from('mdat'));
  if (b.toString('latin1', 4, 8) !== 'ftyp') fail('the output is not an MP4');
  if (moov < 0 || mdat < 0 || moov > mdat) fail('+faststart did not move moov to the front');
  if (!b.includes(Buffer.from('stss'))) fail('no keyframe index (stss) — it would not seek');
  fs.rmSync(out, { force: true });
  console.log('[fetch:ffmpeg]   smoke test: produced a faststart, stss-indexed MP4');
}

// The binary ships to machines with no Xcode, no Homebrew and no /opt. Anything it links outside
// the OS's own dylibs is a "Library not loaded" crash on the user's Mac that we would never see
// on a CI runner, where Homebrew has everything.
function assertSelfContained() {
  const r = run('otool', ['-L', binPath]);
  if (r.status !== 0) {
    console.warn('[fetch:ffmpeg]   otool unavailable — skipping the self-contained check.');
    return;
  }
  const foreign = (r.stdout || '').split(/\r?\n/)
    .filter((l) => /^\s+\S/.test(l))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((lib) => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/Library/'));
  if (foreign.length) {
    die('the built ffmpeg links libraries that will not exist on a user\'s Mac:',
      ...foreign.map((f) => `    ${f}`),
      '  Something was autodetected from Homebrew. Disable it in DARWIN_SOURCE.configure.');
  }
  console.log('[fetch:ffmpeg]   links only /usr/lib + /System/Library — self-contained');
}

function buildFromSource(archive) {
  for (const tool of ['make', 'cc']) {
    if (run('sh', ['-c', `command -v ${tool}`]).status !== 0) {
      skip(`"${tool}" is not installed, so ffmpeg cannot be built.`,
        '  Install the Xcode command line tools:  xcode-select --install');
    }
  }

  const work = path.join(os.tmpdir(), `ycai-ffmpeg-build-${pin.version}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const tarPath = path.join(work, 'ffmpeg.tar.xz');
  fs.writeFileSync(tarPath, archive);

  // macOS tar is bsdtar/libarchive, which reads .xz natively — no xz binary needed.
  const untar = run('tar', ['-xJf', tarPath, '-C', work], { stdio: 'inherit' });
  if (untar.status !== 0) die('could not unpack the ffmpeg source tarball.');
  const srcDir = path.join(work, `ffmpeg-${pin.version}`);
  if (!fs.existsSync(srcDir)) die(`the tarball did not contain ffmpeg-${pin.version}/.`);

  const configure = (extra = []) => {
    const args = ['./configure', `--prefix=${path.join(work, 'out')}`, ...pin.configure, ...extra];
    console.log(`[fetch:ffmpeg] configure ${[...pin.configure, ...extra].join(' ')}`);
    return run('sh', args, { cwd: srcDir, maxBuffer: 32 * 1024 * 1024 });
  };

  let cfg = configure();
  // x86 builds want nasm/yasm, which a Mac does not ship. Only reachable on an Intel Mac (CI is
  // arm64, where the asm assembles with the system toolchain); costs a little speed, not features.
  if (cfg.status !== 0 && /nasm|yasm/i.test(cfg.stdout + cfg.stderr)) {
    console.log('[fetch:ffmpeg] no nasm/yasm — retrying with --disable-x86asm');
    cfg = configure(['--disable-x86asm']);
  }
  if (cfg.status !== 0) {
    const tail = (cfg.stdout + cfg.stderr).trim().split('\n').slice(-15).join('\n');
    die('ffmpeg configure failed.', tail);
  }

  // configure resolves the licence from the flags it was given and prints it. Assert on FFmpeg's
  // own verdict rather than on our reading of the flags.
  if (!cfg.stdout.includes(LICENSE_LINE)) {
    const got = (/^License: .*$/m.exec(cfg.stdout) || ['<no License line>'])[0];
    die(`refusing to build a non-LGPL ffmpeg — configure reported "${got}".`,
      `  Expected "${LICENSE_LINE}". A flag in DARWIN_SOURCE.configure pulled in copyleft code.`);
  }
  console.log(`[fetch:ffmpeg] ${LICENSE_LINE} — confirmed by configure`);

  const jobs = Math.max(1, os.cpus().length);
  console.log(`[fetch:ffmpeg] building ffmpeg ${pin.version} with make -j${jobs} (several minutes)…`);
  const make = run('make', [`-j${jobs}`], { cwd: srcDir, stdio: 'inherit' });
  if (make.status !== 0) die('ffmpeg failed to compile.');

  const built = path.join(srcDir, 'ffmpeg');
  if (!fs.existsSync(built)) die('make succeeded but produced no ffmpeg binary.');
  fs.copyFileSync(built, binPath);
  fs.chmodSync(binPath, 0o755);
  fs.rmSync(work, { recursive: true, force: true });
}

// ---------- main ----------

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  console.log(`[fetch:ffmpeg] ${key} → ${pin.url}`);

  // Cache the archive in the OS temp dir, keyed by URL. Re-running (e.g. --print-hash, then a
  // verify pass) must not re-pull 140 MB.
  const ext = pin.kind === 'source' ? '.tar.xz'
    : pin.archive === 'zip' ? '.zip' : pin.archive === 'gz' ? '.gz' : '.bin';
  const cachePath = path.join(os.tmpdir(), `ycai-ffmpeg-${sha(Buffer.from(pin.url)).slice(0, 16)}${ext}`);

  let archive = null;
  if (fs.existsSync(cachePath)) {
    archive = fs.readFileSync(cachePath);
    console.log(`[fetch:ffmpeg] using cached archive (${(archive.length / 1048576).toFixed(1)} MB)`);
  }
  if (!archive) {
    try {
      archive = await download(pin.url);
      fs.writeFileSync(cachePath, archive);
    } catch (err) {
      skip(`download failed (${err.message}).`, '  Check your connection, then re-run: npm run fetch:ffmpeg');
    }
  }

  const gotArchive = sha(archive);
  if (pin.archiveSha256 && !PRINT_HASH && gotArchive !== pin.archiveSha256) {
    console.error('[fetch:ffmpeg] FAILED — archive SHA-256 mismatch.');
    console.error(`  expected ${pin.archiveSha256}`);
    console.error(`  got      ${gotArchive}`);
    console.error('  Refusing to ship an unverified binary. Re-pin deliberately with --print-hash.');
    process.exit(1);
  }

  // A source build takes minutes and produces no pinnable hash, so --print-hash stops here: the
  // tarball digest is the only value PINS needs.
  if (PRINT_HASH && pin.kind === 'source') {
    console.log('');
    console.log(`[fetch:ffmpeg] --print-hash for "${key}" (source tarball):`);
    console.log(`      archiveSha256: '${gotArchive}',`);
    console.log('');
    console.log('  Also verify the upstream signature before pinning a new version:');
    console.log(`      curl -O ${pin.url} -O ${pin.url}.asc`);
    console.log('      gpg --recv-keys FCF986EA15E6E293A5644F10B4322F04D67658D8');
    console.log(`      gpg --verify ffmpeg-${pin.version}.tar.xz.asc`);
    return;
  }

  if (pin.kind === 'source') {
    buildFromSource(archive);
  } else if (pin.archive === 'gz') {
    fs.writeFileSync(binPath, zlib.gunzipSync(archive));
  } else if (pin.archive === 'zip') {
    const tmpZip = path.join(outDir, '_ffmpeg.zip');
    fs.writeFileSync(tmpZip, archive);
    try { extractFromZip(tmpZip, pin.member, binPath); }
    finally { fs.rmSync(tmpZip, { force: true }); }
  } else {
    fs.writeFileSync(binPath, archive);
  }

  if (process.platform !== 'win32') {
    await fsp.chmod(binPath, 0o755);
    // Downloaded binaries carry a quarantine xattr; without clearing it Gatekeeper refuses to
    // exec the nested helper. Best-effort: harmless where xattr is absent.
    run('xattr', ['-d', 'com.apple.quarantine', binPath], { stdio: 'ignore' });
  }

  const gotBinary = sha(fs.readFileSync(binPath));
  const size = (fs.statSync(binPath).size / 1048576).toFixed(1);

  if (PRINT_HASH) {
    console.log('');
    console.log(`[fetch:ffmpeg] --print-hash for "${key}" (${size} MB):`);
    console.log(`      archiveSha256: '${gotArchive}',`);
    console.log(`      binarySha256:  '${gotBinary}',`);
    console.log('');
    console.log('  Paste these into PINS in this file to pin the build.');
    return;
  }

  if (pin.binarySha256 && gotBinary !== pin.binarySha256) {
    console.error('[fetch:ffmpeg] FAILED — extracted binary SHA-256 mismatch.');
    console.error(`  expected ${pin.binarySha256}`);
    console.error(`  got      ${gotBinary}`);
    process.exit(1);
  }

  // Everything we could not check by hashing, checked by asking the binary. Only a source build
  // needs it — a prebuilt was vetted once, by hand, and its hash is pinned to that inspection.
  if (pin.kind === 'source') {
    const problem = builtBinaryProblem();
    if (problem) die(`the freshly built ffmpeg is unusable: ${problem}`);
    console.log('[fetch:ffmpeg] verifying the build:');
    console.log(`[fetch:ffmpeg]   ffmpeg ${pin.version}, no --enable-gpl / --enable-nonfree / libx264`);
    assertSelfContained();
    for (const [kind, required] of Object.entries(pin.require)) assertComponents(kind, required);
    smokeTest();
  }

  console.log(`[fetch:ffmpeg] OK — vendor/ffmpeg/${pin.binary} (${size} MB)`);
}

main().catch((err) => {
  console.error('[fetch:ffmpeg] unexpected failure:', err.message);
  process.exit(IN_CI ? 1 : 0);
});
