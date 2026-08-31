// Layer 1 speaker alignment (§7): overlap-vote channel-1 diarized speakers against
// active-speaker intervals from speakers.jsonl. A name wins a speaker if it covers
// ≥ 60% of that speaker's overlapped speech time.
const fs = require('fs');

const EMPTY_DIAGNOSTICS = {
  agentStatus: 'unknown', activeSpeakerCount: 0, rosterEventCount: 0, heuristics: null, malformedLines: 0,
};

function parseSpeakerEvents(jsonlPath) {
  const events = [];
  const roster = new Set();
  // Roster entries carry a source so mergeRoster can rank a participants-panel read above a
  // tile-grid scrape; older agents emit neither field, hence the defaults.
  const rosterSources = [];
  const diagnostics = { ...EMPTY_DIAGNOSTICS };
  let raw = '';
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); }
  catch { return { events, roster: [], rosterSources, diagnostics: { ...EMPTY_DIAGNOSTICS, agentStatus: 'no-file' } }; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'active-speaker' && ev.name && ev.ts) {
        events.push({ ts: ev.ts, name: ev.name, confidence: ev.confidence, strategy: ev.strategy });
        diagnostics.activeSpeakerCount++;
      } else if (ev.type === 'roster' && Array.isArray(ev.names)) {
        ev.names.forEach((n) => roster.add(n));
        rosterSources.push({
          names: ev.names,
          source: ev.source || 'agent-roster',
          confidence: typeof ev.confidence === 'number' ? ev.confidence : 0.9,
          expectedCount: ev.expectedCount,
        });
        diagnostics.rosterEventCount++;
      } else if (ev.type === 'agent-status') {
        diagnostics.agentStatus = ev.state || diagnostics.agentStatus;
        if (ev.heuristics) diagnostics.heuristics = ev.heuristics;
      }
    } catch { diagnostics.malformedLines++; /* tolerate partial lines from a killed agent */ }
  }
  events.sort((a, b) => a.ts - b.ts);
  events.forEach((e) => roster.add(e.name));
  if (diagnostics.agentStatus === 'unknown' && (events.length || roster.size)) diagnostics.agentStatus = 'observed';
  return { events, roster: [...roster], rosterSources, diagnostics };
}

// Each event holds from its ts until the next event; the last one gets a 15s cap.
function toIntervals(events) {
  return events.map((e, i) => ({
    name: e.name,
    start: e.ts,
    end: events[i + 1] ? events[i + 1].ts : e.ts + 15000,
    // Weight ties the vote to how the agent identified the speaker (structural read > regex).
    weight: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 1,
  }));
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Mutates transcript segments: relabels "Speaker N" → real name where the vote is decisive.
// Returns { renamed: { "1:3": "Priya Shah" }, roster: [...], rosterSources, diagnostics, votes }
// `votes` carries the winning share per speaker so the resolver can express it as a confidence.
function alignSpeakers(transcript, jsonlPath) {
  const { events, roster, rosterSources, diagnostics } = parseSpeakerEvents(jsonlPath);
  const renamed = {};
  const votes = {};
  if (!events.length || !transcript?.length) return { renamed, roster, rosterSources, diagnostics, votes };
  const intervals = toIntervals(events);

  const bySpeaker = new Map(); // diarizedSpeaker → [{start,end}] absolute ms
  for (const seg of transcript) {
    if (seg.channel !== 1 || !seg.words?.length) continue;
    const start = Date.parse(seg.words[0].start_timestamp.absolute);
    const end = Date.parse(seg.words[seg.words.length - 1].end_timestamp.absolute);
    if (!bySpeaker.has(seg.diarizedSpeaker)) bySpeaker.set(seg.diarizedSpeaker, []);
    bySpeaker.get(seg.diarizedSpeaker).push({ start, end });
  }

  for (const [dz, ranges] of bySpeaker) {
    const tally = new Map();
    let total = 0;
    for (const r of ranges) {
      for (const iv of intervals) {
        const ms = overlapMs(r.start, r.end, iv.start, iv.end) * iv.weight;
        if (ms > 0) { tally.set(iv.name, (tally.get(iv.name) || 0) + ms); total += ms; }
      }
    }
    if (!total) continue;
    const [topName, topMs] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = topMs / total;
    if (share >= 0.6) {
      renamed[`1:${dz}`] = topName;
      // Map the winning share onto a confidence: a unanimous vote reads as certain, a bare
      // 60% squeak reads as merely likely, so the UI can mark the latter unverified.
      votes[`1:${dz}`] = { name: topName, share, confidence: Math.min(0.95, 0.6 + share * 0.35) };
      for (const seg of transcript) {
        if (seg.channel === 1 && seg.diarizedSpeaker === dz) seg.speaker = topName;
      }
    }
  }
  return { renamed, roster, rosterSources, diagnostics, votes };
}

module.exports = { alignSpeakers, parseSpeakerEvents };
