// Speaker naming for one recording (§7): gathers every signal, makes ONE AI call, resolves, and
// records why. Used by the pipeline and by "Re-resolve names" (which needs no re-transcription).
//
// Signals, strongest first (resolveSpeakers applies them so a weaker one never overwrites a
// stronger one):
//   1. channel 0 = the signed-in user
//   2. the user's own renames (kept across re-runs, with the staleness check)
//   3. votes from the native agent's speaking signal — only when repeated and sustained
//   4. one AI inference over the participant list, the people who attend this meeting, the title
// Everything is written to <recording>/names.jsonl: the candidates, the votes, the model's raw
// answer and the final map. Before this, AI responses and errors were only console.warn'd, so a
// meeting that came out unnamed could never be explained afterwards.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { parseSpeakerEvents, voteSpeakers } = require('./align');
const { mergeRoster, rosterIsTrustworthy, rosterNames, isPersonName } = require('./roster');
const { resolveSpeakers, readSpeakerMap } = require('./speakerResolve');
const { inferSpeakerNames } = require('./ai/inferSpeakerNames');
const { historyFor } = require('./people');
const { segSpeaker } = require('./transcriptUtils');

const DEFAULT_TITLE_RE = /^Meeting · /;
const GENERIC_RE = /^Speaker \d+$/;

// Roster sources from speakers.jsonl, with junk screened out before it can become a candidate.
// The tile-grid fallback is kept but at low confidence; it is never trusted on its own.
function rosterSourcesFrom(parsed) {
  const sources = (parsed.rosterSources || []).map((s) => ({
    ...s,
    names: (s.names || []).filter((n) => isPersonName(n)),
    confidence: s.source === 'tile-grid' ? Math.min(s.confidence || 0.5, 0.6) : s.confidence,
  })).filter((s) => s.names.length);
  if (!sources.length && parsed.roster?.length) {
    sources.push({ names: parsed.roster.filter((n) => isPersonName(n)), source: 'agent-roster', confidence: 0.6 });
  }
  return sources;
}

// Reset channel-1 labels to the provisional "Speaker N" Deepgram assigned (for re-resolving a
// transcript whose labels were already rewritten by an earlier run).
function provisionalLabels(transcript, userName) {
  return (transcript || []).map((s) => ({
    ...s,
    speaker: s.channel === 0 ? (userName || s.speaker) : `Speaker ${(s.diarizedSpeaker ?? 0) + 1}`,
  }));
}

// The recurring-meeting host. All 17 of the user's manual renames were the dominant, never-
// addressed speaker (Hernan, 12 times), the one voice transcript reasoning cannot name. When this
// meeting belongs to a series (same title or participants) whose dominant voice the user has
// confirmed at least twice, and the model left this meeting's dominant voice unnamed, suggest that
// person — at 0.6, i.e. always shown as unverified with a "?". Never overrides any other source.
function historyHostFallback({ transcript, history, inferred, known }) {
  // Same typed title only. Participant overlap says who ATTENDS, not who LEADS: on the real library
  // it suggested the Daily Sync host for an unrelated project meeting with the same people.
  if (!history || history.basis !== 'title') return null;
  const host = (history.people || []).filter((p) => (p.dominant || 0) >= 2).sort((a, b) => b.dominant - a.dominant)[0];
  if (!host) return null;
  const taken = new Set([...Object.values(inferred).map((e) => e.name), ...Object.values(known)].map((n) => String(n).toLowerCase()));
  if (taken.has(host.name.toLowerCase())) return null;
  const words = new Map();
  let total = 0;
  for (const s of transcript) {
    if (s.channel !== 1) continue;
    const n = String(s.text || '').split(/\s+/).filter(Boolean).length || (Array.isArray(s.words) ? s.words.length : 0);
    total += n;
    const l = segSpeaker(s);
    words.set(l, (words.get(l) || 0) + n);
  }
  const top = [...words.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || !total || top[1] / total < 0.25) return null;
  const [label] = top;
  if (!GENERIC_RE.test(label) || inferred[label] || known[label]) return null;
  return {
    label,
    entry: { name: host.name, confidence: 0.6, basis: 'history-host', evidence: `usually leads this meeting (confirmed ${host.dominant}×)`, source: 'history' },
  };
}

// opts: { dir, meta, transcript, prior (existing meeting record), userName, plog, meetings,
//         infer (injectable AI call, for the evaluation harness), record (write names.jsonl) }
// Returns { transcript, speakerMap, nameAttribution }.
async function resolveNames({
  dir, meta, transcript, prior, userName, plog = () => {}, meetings, infer = inferSpeakerNames, record = true,
}) {
  const parsed = parseSpeakerEvents(path.join(dir, 'speakers.jsonl'));
  const votes = voteSpeakers(transcript, parsed.events);

  const priorMap = readSpeakerMap(prior && prior.speakerMap);
  const manualNames = Object.entries(priorMap).filter(([k, e]) => !k.startsWith('0:') && e.lockedByUser).map(([, e]) => e.name);
  const roster = mergeRoster([
    ...rosterSourcesFrom(parsed),
    { names: manualNames, source: 'manual', confidence: 1 },
  ]);
  const rosterTrusted = rosterIsTrustworthy(roster);

  // Titles that may name people: the one the user typed, and the meeting window/tab title.
  const titles = [];
  if (prior && prior.title && !DEFAULT_TITLE_RE.test(prior.title)) titles.push(prior.title);
  if (meta && meta.title && !titles.includes(meta.title) && !/^(microsoft teams|zoom meeting|google meet)$/i.test(meta.title)) titles.push(meta.title);

  let library = meetings;
  if (!library) { try { library = await require('./store').loadAllRaw(); } catch { library = []; } }
  const history = historyFor(library, {
    id: meta && meta.id,
    title: titles[0] || null,
    date: meta && meta.startedAt,
    roster: rosterNames(roster),
  }, { userName });

  // Labels the measured signals or the user already settled are shown to the model as context
  // ("Speaker 2 = Carlos Brito") instead of being asked about again.
  const known = {};
  const labelOf = new Map();
  for (const s of transcript) labelOf.set(`${s.channel}:${s.diarizedSpeaker}`, segSpeaker(s));
  for (const [k, e] of Object.entries(priorMap)) if (e.lockedByUser && labelOf.has(k) && GENERIC_RE.test(labelOf.get(k))) known[labelOf.get(k)] = e.name;
  for (const [k, v] of Object.entries(votes)) if (labelOf.has(k) && !known[labelOf.get(k)]) known[labelOf.get(k)] = v.name;

  const t0 = Date.now();
  const ai = await infer(transcript, {
    roster, rosterTrusted, history: history.people, titles,
  }, { userName, known });
  plog('names-ai', { ms: Date.now() - t0, labels: ai.labels?.length || 0, named: Object.keys(ai.map || {}).length, error: ai.error });

  const inferred = { ...(ai.map || {}) };
  const fallback = historyHostFallback({ transcript, history, inferred, known });
  if (fallback) inferred[fallback.label] = fallback.entry;

  const resolved = resolveSpeakers({
    transcript,
    roster,
    priorSpeakerMap: prior && prior.speakerMap,
    userName,
    inferred,
    alignment: Object.keys(votes).length ? votes : null,
  });

  const entry = {
    ts: Date.now(),
    roster: roster.map((r) => ({ name: r.name, source: r.source })),
    rosterTrusted,
    history,
    titles,
    votes,
    known,
    ai: { labels: ai.labels, raw: ai.raw ? String(ai.raw).slice(0, 8000) : null, error: ai.error || null, map: ai.map, promptBytes: ai.prompt && ai.prompt.bytes },
    speakerMap: resolved.speakerMap,
    unresolved: resolved.unresolved,
  };
  if (record) fsp.appendFile(path.join(dir, 'names.jsonl'), JSON.stringify(entry) + '\n').catch(() => {});

  return {
    _entry: entry,
    transcript: resolved.transcript,
    speakerMap: resolved.speakerMap,
    nameAttribution: {
      agent: parsed.diagnostics || null,
      roster: roster.map((r) => r.name),
      rosterTrusted,
      history: history.basis ? { basis: history.basis, people: history.people.map((p) => p.name) } : null,
      unresolved: resolved.unresolved,
      sources: resolved.sources,
      aiError: ai.error || null,
    },
  };
}

// The richest transcript available on disk for re-resolving: the raw pipeline output (every word,
// provisional labels) if present, else transcript.json, else the stored meeting transcript.
async function loadTranscriptForRerun(dir, meeting, userName) {
  for (const name of ['transcript.raw.json', 'transcript.json']) {
    try {
      const t = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (Array.isArray(t) && t.length) return provisionalLabels(t, userName);
    } catch { /* try the next */ }
  }
  return Array.isArray(meeting && meeting.transcript) && meeting.transcript.length
    ? provisionalLabels(meeting.transcript, userName) : null;
}

module.exports = { resolveNames, loadTranscriptForRerun, provisionalLabels, rosterSourcesFrom };
