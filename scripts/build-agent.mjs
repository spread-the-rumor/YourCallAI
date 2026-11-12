// Builds the native name agent (§7 Layer 1) into agents/dist for LOCAL development.
//
// Why this exists: the binaries were only ever built in CI (.github/workflows/release.yml), so
// agents/dist was empty in every dev checkout and startNameAgent() silently no-op'd. Layer 1 —
// the only source of ground-truth names — therefore never ran outside a shipped installer, and
// nobody could tell whether it worked.
//
//   npm run build:agent
//
// Requires the .NET 8 SDK on Windows (`dotnet --list-sdks` must show an 8.x) or Xcode's swiftc on
// macOS. Missing toolchain is reported as a skip, not a failure: the app runs fine without the
// agent, it just falls back to AI inference + the rename UI.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const binary = path.join(root, 'agents', 'dist', isWin ? 'YourCallAgent.exe' : 'YourCallAgent');
// A failed compile leaves the PREVIOUS binary in place, so "the file exists" is not success —
// it used to print OK over a compile error. Success means the binary is newer than this run.
const startedAt = Date.now();
const fresh = () => existsSync(binary) && statSync(binary).mtimeMs >= startedAt - 1000;

// NOTE: shell:false throughout. The repo path contains spaces ("D:\Your Call AI V2") and with
// shell:true cmd.exe re-splits the arguments, so -File receives only "D:\Your".
function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: false });
}

// `dotnet --list-sdks` exits 0 even when NO SDK is installed (it just prints nothing), so the exit
// code is not a usable probe — the output is. Only the SDK can `dotnet publish`; the runtime alone,
// which ships with plenty of apps, cannot.
function dotnetSdks() {
  const r = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', shell: false });
  if (r.error) return [];
  return String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

if (isWin) {
  const sdks = dotnetSdks();
  if (!sdks.length) {
    console.error('[build:agent] SKIPPED — no .NET SDK found (the runtime alone cannot build).');
    console.error('  Install the .NET 8 SDK:  winget install Microsoft.DotNet.SDK.8');
    console.error('  Without it, speaker names fall back to AI inference + the rename UI,');
    console.error('  which still works — you just lose the ground-truth names from the meeting UI.');
    process.exit(0);
  }
  console.log(`[build:agent] .NET SDKs: ${sdks.join(', ')}`);
  const script = path.join(root, 'agents', 'windows', 'build.ps1');
  // pwsh (PowerShell 7) is not on every machine; powershell.exe ships with Windows.
  let r = run('pwsh', ['-NoProfile', '-File', script]);
  if (r.error || r.status !== 0 || !fresh()) {
    if (r.error) console.log('[build:agent] pwsh unavailable, using powershell.exe…');
    r = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
  }
} else if (process.platform === 'darwin') {
  const sw = spawnSync('swiftc', ['--version'], { stdio: 'ignore', shell: false });
  if (sw.error || sw.status !== 0) {
    console.error('[build:agent] SKIPPED — swiftc not found. Install Xcode command line tools:');
    console.error('    xcode-select --install');
    process.exit(0);
  }
  run('sh', [path.join(root, 'agents', 'macos', 'build.sh')]);
} else {
  console.error(`[build:agent] SKIPPED — no agent for platform "${process.platform}".`);
  process.exit(0);
}

if (fresh()) {
  console.log(`[build:agent] OK — ${path.relative(root, binary)}`);
  console.log('  Restart the app fully (kill all electron processes) to pick it up.');
  console.log(`  Diagnose a platform whose names do not resolve:  "${binary}" --dump`);
} else {
  console.error('[build:agent] FAILED — binary not produced; see the build output above.');
  process.exit(1);
}
