// §7 speaker resolution: merge every naming signal into one labelled transcript + speakerMap.
// Pure — no Electron, no IO, no network — so test/selfcheck.js covers the whole decision table.
//
// Sources are applied in descending trust, and each step only touches labels still unresolved, so
// a later, weaker source can never overwrite a stronger one:
//   1. channel 0            -> the signed-in user (they hold the mic, by construction)
//   2. prior manual renames -> what the user explicitly typed, subject to a staleness check
//   3. native-agent vote    -> real names read off the meeting UI (src/align.js)
//   4. AI inference         -> roster-constrained guess (src/ai/inferSpeakerNames.js)
//   5. leftovers            -> keep "Speaker N" and report as unresolved
const { segText } = require('./transcriptUtils');
const { nameKey, matchToRoster, rosterNames, isPersonName } = require('./roster');

const USER_CONFIDENCE = 0.95;
const MANUAL_CONFIDENCE = 1;
const STALE_MANUAL_CONFIDENCE = 0.7; // demoted lock: shown as unverified, not silently applied
const AGENT_CONFIDENCE = 0.9;
const SAMPLE_LEN = 200;

const mapKey = (channel, diarizedSpeaker) => `${channel}:${diarizedSpeaker}`;

// speakerMap entries were plain strings before this change (main.js rename-speaker wrote
// { "1:3": "Priya" }). Existing meetings.json files and already-synced Supabase rows still hold
// that shape, so reads must accept it. A bare string was only ever written by a manual rename.
function normalizeEntry(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const name = value.trim();
    if (!name) return null;
    return { name, source: 'manual', confidence: MANUAL_CONFIDENCE, lockedByUser: true, sampleText: '' };
  }
  if (typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim()) return null;
  return {
    name: value.name.trim(),
    source: value.source || 'manual',
    confidence: typeof value.confidence === 'number' ? value.confidence : MANUAL_CONFIDENCE,
    lockedByUser: value.lockedByUser !== false,
    sampleText: typeof value.sampleText === 'string' ? value.sampleText : '',
  };
}

function readSpeakerMap(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const e = normalizeEntry(v);
    if (e) out[k] = e;
  }
  return out;
}

// First ~200 chars a diarized speaker said — the fingerprint used to detect a stale lock.
function sampleFor(transcript, channel, diarizedSpeaker) {
  for (const seg of transcript || []) {
    if (seg.channel !== channel || seg.diarizedSpeaker !== diarizedSpeaker) continue;
    // segText returns '' when `words` is an empty array (Array.isArray([]) is true, so it never
    // falls back to `text`), hence the explicit fallback.
    const t = (segText(seg) || seg.text || '').trim();
    if (t) return t.slice(0, SAMPLE_LEN);
  }
  return '';
}

// Deepgram's diarized ids are NOT stable across runs, so a lock from run A may point at a
// different person in run B. Compare word overlap against the stored sample; below the threshold
// the lock is demoted to a suggestion rather than silently mislabelling someone.
function sampleMatches(stored, current, threshold = 0.4) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const a = norm(stored);
  const b = new Set(norm(current));
  if (!a.length || !b.size) return null; // unknown — treat as "can't tell", caller keeps the lock
  const hits = a.filter((w) => b.has(w)).length;
  return hits / a.length >= threshold;
}

// alignment: the { renamed: { "1:3": name } } from alignSpeakers (already applied to the
//   transcript in place, but re-applied here so confidences land in the map).
// inferred: { "Speaker 2": { name, confidence, ... } } from inferSpeakerNames.
function resolveSpeakers({
  transcript, roster, priorSpeakerMap, userName, inferred, alignment, agentConfidence,
} = {}) {
  const segs = Array.isArray(transcript) ? transcript : [];
  const speakerMap = {};
  const prior = readSpeakerMap(priorSpeakerMap);
  const known = rosterNames(roster);
  const changed = [];

  // Canonicalise a name against the roster where possible, so manual "priya s" and the agent's
  // "Priya Shah" don't render as two different people.
  const canonical = (name) => {
    if (!known.length) return name;
    const hit = matchToRoster(name, known);
    return hit && hit.score >= 0.85 ? hit.name : name;
  };

  // Same human? Exact key first, then a roster-style fuzzy match so a mononym read off a meeting
  // tile ("Sagar") is recognised as the account holder ("Sagar Bansal"). 0.7 is what matchToRoster
  // scores a first-name hit; anything looser would start merging distinct people.
  const isSamePerson = (a, b) => {
    if (!a || !b) return false;
    if (nameKey(a) === nameKey(b)) return true;
    const hit = matchToRoster(a, [b]);
    return !!hit && hit.score >= 0.7;
  };

  const put = (channel, dz, entry) => {
    const key = mapKey(channel, dz);
    if (speakerMap[key]) return false;
    speakerMap[key] = entry;
    return true;
  };

  // --- 1. channel 0 is the local user.
  const user = (userName || '').trim();
  const ch0 = new Set(segs.filter((s) => s.channel === 0).map((s) => s.diarizedSpeaker));
  if (user) for (const dz of ch0) put(0, dz, { name: user, source: 'signed-in-user', confidence: USER_CONFIDENCE, lockedByUser: false, sampleText: '' });

  // --- 2. prior manual renames, with the staleness check.
  for (const [key, entry] of Object.entries(prior)) {
    if (!entry.lockedByUser) continue;
    const [chStr, dzStr] = key.split(':');
    const channel = Number(chStr);
    const dz = Number(dzStr);
    if (!Number.isFinite(channel) || !Number.isFinite(dz)) continue;
    if (channel === 0) continue;                       // ch0 belongs to the signed-in user
    const current = sampleFor(segs, channel, dz);
    if (!current) continue;                            // that speaker no longer exists in this run
    const ok = entry.sampleText ? sampleMatches(entry.sampleText, current) : null;
    const stale = ok === false;
    put(channel, dz, {
      // NOT canonical(): what the user typed wins verbatim. Canonicalising a manual rename against
      // the roster reverts the correction — "Samuel Ortiz" matches roster "Sam Ortiz" on the
      // last-name+initial tier and silently becomes "Sam Ortiz" again. The user may be fixing a
      // nickname the meeting UI showed, or the wrong person entirely; either way they outrank it.
      name: entry.name,
      source: stale ? 'prior-manual-stale' : 'manual',
      confidence: stale ? STALE_MANUAL_CONFIDENCE : MANUAL_CONFIDENCE,
      lockedByUser: !stale,
      sampleText: stale ? current : (entry.sampleText || current),
    });
  }

  // --- 3. native-agent overlap vote.
  for (const [key, value] of Object.entries(alignment || {})) {
    const name = typeof value === 'string' ? value : value && value.name;
    if (!name) continue;
    const [chStr, dzStr] = key.split(':');
    const channel = Number(chStr);
    const dz = Number(dzStr);
    if (!Number.isFinite(channel) || !Number.isFinite(dz)) continue;
    const conf = (value && typeof value.confidence === 'number') ? value.confidence
      : (typeof agentConfidence === 'number' ? agentConfidence : AGENT_CONFIDENCE);
    // The local user is on channel 0 by construction, so they cannot also be a channel-1 voice.
    // The AI tier has always enforced this; the agent vote did not, and Teams labels the user's
    // own tile ("Myself video, Sagar, …") like any other participant — so a captured meeting
    // really did resolve 338 remote segments to the signed-in user.
    // matchToRoster, not nameKey: the agent reads the display name off the tile, which is often
    // the mononym "Sagar" while the account is "Sagar Bansal". nameKey demands an exact match and
    // would let that straight through.
    if (channel !== 0 && user && isSamePerson(canonical(name), user)) continue;
    // A vote can only name a person. UI labels voted in as speakers ("Code", "Huddles",
    // "View Sagar Bansal's profile" — all at 0.9+ in real Slack huddles) stop here.
    if (!isPersonName(name)) continue;
    put(channel, dz, {
      name: canonical(name),
      source: (value && value.source) || 'native-agent',
      confidence: conf,
      lockedByUser: false,
      sampleText: sampleFor(segs, channel, dz),
    });
  }

  // --- 4. AI inference, keyed by the CURRENT label on the segment.
  if (inferred && Object.keys(inferred).length) {
    const byLabel = new Map(); // label -> Set of "channel:dz" still carrying it
    for (const seg of segs) {
      const key = mapKey(seg.channel, seg.diarizedSpeaker);
      if (speakerMap[key]) continue;
      const label = seg.speaker;
      if (!byLabel.has(label)) byLabel.set(label, new Set());
      byLabel.get(label).add(key);
    }
    for (const [label, entry] of Object.entries(inferred)) {
      const e = (entry && typeof entry === 'object') ? entry : { name: entry };
      if (!e.name) continue;
      for (const key of byLabel.get(label) || []) {
        const [channel, dz] = key.split(':').map(Number);
        if (channel !== 0 && user && isSamePerson(canonical(e.name), user)) continue;
        put(channel, dz, {
          name: canonical(e.name),
          source: e.source || 'ai-inference',
          confidence: typeof e.confidence === 'number' ? e.confidence : 0.6,
          lockedByUser: false,
          sampleText: sampleFor(segs, channel, dz),
          ...(e.basis ? { basis: e.basis } : {}),
          ...(e.evidence ? { evidence: e.evidence } : {}),
        });
      }
    }
  }

  // --- Guard: one person must not end up on two speakers. Keep the most confident.
  // Exception: an AI answer the model marked as a diarization fragment of an already-named voice
  // (basis "...+fragment", already capped at 0.6 in parseInferenceResponse).
  const seen = new Map();
  for (const [key, entry] of Object.entries(speakerMap)) {
    const k = nameKey(entry.name);
    if (!k) continue;
    if (typeof entry.basis === 'string' && entry.basis.endsWith('+fragment')) continue;
    const prevKey = seen.get(k);
    if (prevKey === undefined) { seen.set(k, key); continue; }
    const prevEntry = speakerMap[prevKey];
    // Never drop the signed-in user's own channel-0 label, and never drop a live manual lock.
    const weaker = entry.confidence > prevEntry.confidence ? prevKey : key;
    const keeper = weaker === key ? prevKey : key;
    if (speakerMap[weaker].lockedByUser && !speakerMap[keeper].lockedByUser) { seen.set(k, weaker); delete speakerMap[keeper]; continue; }
    delete speakerMap[weaker];
    seen.set(k, keeper);
  }

  // --- Apply to the transcript.
  const out = segs.map((seg) => {
    const entry = speakerMap[mapKey(seg.channel, seg.diarizedSpeaker)];
    if (!entry || entry.name === seg.speaker) return seg;
    changed.push({ from: seg.speaker, to: entry.name });
    return { ...seg, speaker: entry.name };
  });

  const unresolved = [...new Set(out
    .filter((s) => !speakerMap[mapKey(s.channel, s.diarizedSpeaker)])
    .map((s) => s.speaker))];

  const sources = {};
  for (const e of Object.values(speakerMap)) sources[e.source] = (sources[e.source] || 0) + 1;

  return { transcript: out, speakerMap, unresolved, sources, changed };
}

module.exports = {
  resolveSpeakers, readSpeakerMap, normalizeEntry, sampleFor, sampleMatches, mapKey,
};
