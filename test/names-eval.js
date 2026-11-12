// Speaker-name evaluation over a REAL library (read-only). Scores the current resolver against
// ground truth: the user's own manual renames (and test/names-truth.json, if present).
//
//   node test/names-eval.js                      # no AI: votes, roster, history only
//   node test/names-eval.js --ai                 # + the one AI call per meeting (uses the proxy)
//   node test/names-eval.js --ai --only <id,...> # a few meetings
//   node test/names-eval.js --data "<userData>"  # another library (default: this machine's)
//
// Blind by construction: a meeting is resolved WITHOUT its own manual renames, and the history
// signal only sees meetings dated BEFORE it — i.e. what the pipeline would have known at the time.
// Writes nothing into the library (names.jsonl recording is disabled).
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dataDir = opt('--data', path.join(os.homedir(), 'AppData', 'Roaming', 'Your Call AI'));
const useAi = flag('--ai');
const only = (opt('--only', '') || '').split(',').filter(Boolean);

// Proxy credentials for --ai come from the repo's .env, exactly as the dev app reads them.
const { loadEnvFile } = require('../src/settingsStore');
const env = loadEnvFile(path.join(__dirname, '..', '.env'));
for (const k of ['APP_PROXY_TOKEN', 'VERCEL_BACKEND_URL', 'USER_DISPLAY_NAME']) if (env[k] && !process.env[k]) process.env[k] = env[k];

const { resolveNames, loadTranscriptForRerun } = require('../src/names');
const { readSpeakerMap } = require('../src/speakerResolve');
const { nameKey, matchToRoster, isPersonName } = require('../src/roster');
const { compactMeeting } = require('../src/store');

const userName = opt('--user', null) || readUser() || process.env.USER_DISPLAY_NAME || 'You';
function readUser() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'auth-session.json'), 'utf8'))?.user?.name || null; } catch { return null; }
}

const same = (a, b) => {
  if (!a || !b) return false;
  if (nameKey(a) === nameKey(b)) return true;
  const hit = matchToRoster(a, [b]);
  return !!hit && hit.score >= 0.7;
};

(async () => {
  console.error(`[eval] reading ${dataDir} …`);
  const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'meetings.json'), 'utf8')).meetings
    .filter((m) => !m.deletedAt).map(compactMeeting);
  let extraTruth = {};
  try { extraTruth = JSON.parse(fs.readFileSync(path.join(__dirname, 'names-truth.json'), 'utf8')); } catch { /* optional */ }

  const totals = { meetings: 0, truth: 0, correct: 0, wrong: 0, unresolved: 0, userOnRemote: 0, nonPerson: 0, remote: 0, remoteNamed: 0 };
  const rows = [];
  for (const m of all) {
    if (!m.recordingId || (only.length && !only.some((o) => m.id.includes(o)))) continue;
    const dir = path.join(dataDir, 'recordings', m.recordingId);
    if (!fs.existsSync(dir)) continue;
    const truth = {};
    for (const [k, e] of Object.entries(readSpeakerMap(m.speakerMap))) if (!k.startsWith('0:') && (e.lockedByUser || e.source === 'manual')) truth[k] = e.name;
    Object.assign(truth, extraTruth[m.id] || {});
    if (!useAi && !Object.keys(truth).length && !flag('--all')) continue;
    if (useAi && !Object.keys(truth).length && !flag('--all')) continue;

    const transcript = await loadTranscriptForRerun(dir, m, userName);
    if (!transcript) continue;
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { meta = { id: m.recordingId, startedAt: m.date }; }
    const earlier = all.filter((x) => x.id !== m.id && new Date(x.date) < new Date(m.date));
    const blind = { ...m, speakerMap: {} };

    const res = await resolveNames({
      dir, meta, transcript, prior: blind, userName, meetings: earlier, record: false,
      ...(useAi ? {} : { infer: async () => ({ map: {}, labels: [] }) }),
    });

    totals.meetings++;
    const row = { id: m.id, title: (m.title || '').slice(0, 34), truth: 0, ok: 0, bad: [], miss: 0 };
    for (const [k, name] of Object.entries(truth)) {
      totals.truth++; row.truth++;
      const got = res.speakerMap[k];
      if (!got) { totals.unresolved++; row.miss++; continue; }
      if (same(got.name, name)) { totals.correct++; row.ok++; } else { totals.wrong++; row.bad.push(`${k}: ${got.name}≠${name} (${got.source} ${got.confidence?.toFixed?.(2)})`); }
    }
    for (const [k, e] of Object.entries(res.speakerMap)) {
      if (k.startsWith('0:')) continue;
      totals.remoteNamed++;
      if (same(e.name, userName)) totals.userOnRemote++;
      if (!isPersonName(e.name)) totals.nonPerson++;
    }
    totals.remote += new Set(transcript.filter((s) => s.channel === 1).map((s) => s.diarizedSpeaker)).size;
    row.history = res.nameAttribution.history ? `${res.nameAttribution.history.basis}:${res.nameAttribution.history.people.slice(0, 3).join('/')}` : '-';
    row.roster = res.nameAttribution.roster.length;
    rows.push(row);
    if (useAi) console.error(`[eval] ${m.id} ${row.ok}/${row.truth}${row.bad.length ? ' WRONG ' + row.bad.join('; ') : ''}`);
  }

  for (const r of rows) {
    console.log(`${r.id.padEnd(26)} ${r.title.padEnd(35)} truth ${r.truth} ok ${r.ok} miss ${r.miss} roster ${String(r.roster).padStart(2)} hist ${r.history}${r.bad.length ? '  WRONG: ' + r.bad.join('; ') : ''}`);
  }
  console.log('\n', JSON.stringify(totals, null, 1));
  console.log(`\nground truth: ${totals.correct}/${totals.truth} correct, ${totals.wrong} wrong, ${totals.unresolved} unresolved`
    + ` | remote voices named ${totals.remoteNamed}/${totals.remote} | user on a remote voice: ${totals.userOnRemote} | non-person names: ${totals.nonPerson}`);
})().catch((e) => { console.error(e); process.exit(1); });
