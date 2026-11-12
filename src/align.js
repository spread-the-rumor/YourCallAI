// Layer 1 speaker alignment (§7): overlap-vote channel-1 diarized speakers against
// active-speaker intervals from speakers.jsonl. A name wins a speaker if it covers
// ≥ 60% of that speaker's overlapped speech time.
const fs = require('fs');
const { segStartIso, segEndIso } = require('./transcriptUtils');

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

// Each event holds from its ts for at most MAX_HOLD_MS, or until the next event if that comes
// sooner. The cap applies to EVERY interval, not just the last: a real speaking signal repeats
// every few seconds, so when events are dense this is a no-op. When they are sparse it is the
// difference between honest silence and a confident lie — a captured 17-minute meeting produced
// only 3 events, and the unbounded "hold until the next event" rule let ONE of them claim ~25
// minutes of transcript, voting that name onto every voice it overlapped.
const MAX_HOLD_MS = 15000;

function toIntervals(events) {
  return events.map((e, i) => ({
    name: e.name,
    start: e.ts,
    end: Math.min(events[i + 1] ? events[i + 1].ts : Infinity, e.ts + MAX_HOLD_MS),
    // Weight ties the vote to how the agent identified the speaker (structural read > regex).
    weight: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 1,
  }));
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// What a vote must show before it may name a speaker. Measured on the real library: 30 of 37
// agent active-speaker events were a single first-poll artifact, and ONE such event, held for its
// 15 s, used to win a 100% share of the overlapped time and name a voice with thousands of words —
// usually as the signed-in user. A real speaking signal repeats; a name must be seen several times,
// over a real stretch of the meeting, covering a real part of what that voice said.
const VOTE_RULES = {
  minEvents: 3,          // distinct active-speaker events naming this person over this voice
  minSpanMs: 20000,      // first → last of those events
  minShare: 0.6,         // of the time where ANY event overlapped this voice
  minCoverage: 0.1,      // of this voice's TOTAL speech time
};

// PURE: never touches the transcript. Labels are applied in exactly one place (resolveSpeakers),
// so a vote the resolver rejects can no longer leave its name stuck on the segments — which is how
// the user's own name ended up on remote voices in 10 meetings.
// Returns { "1:<dz>": { name, share, coverage, events, confidence } }.
function voteSpeakers(transcript, events, rules = VOTE_RULES) {
  const votes = {};
  if (!events?.length || !transcript?.length) return votes;
  const intervals = toIntervals(events).map((iv, i) => ({ ...iv, ts: events[i].ts }));

  const bySpeaker = new Map(); // diarizedSpeaker → [{start,end}] absolute ms
  for (const seg of transcript) {
    if (seg.channel !== 1) continue;
    const start = Date.parse(segStartIso(seg));
    const end = Date.parse(segEndIso(seg));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (!bySpeaker.has(seg.diarizedSpeaker)) bySpeaker.set(seg.diarizedSpeaker, []);
    bySpeaker.get(seg.diarizedSpeaker).push({ start, end });
  }

  for (const [dz, ranges] of bySpeaker) {
    const speechMs = ranges.reduce((a, r) => a + (r.end - r.start), 0);
    const tally = new Map(); // name → { ms, events:Set<ts> }
    let total = 0;
    for (const r of ranges) {
      for (const iv of intervals) {
        const ms = overlapMs(r.start, r.end, iv.start, iv.end) * iv.weight;
        if (ms <= 0) continue;
        const t = tally.get(iv.name) || { ms: 0, events: new Set() };
        t.ms += ms; t.events.add(iv.ts);
        tally.set(iv.name, t);
        total += ms;
      }
    }
    if (!total) continue;
    const [name, top] = [...tally.entries()].sort((a, b) => b[1].ms - a[1].ms)[0];
    const r = rules;
    const ts = [...top.events].sort((a, b) => a - b);
    const share = top.ms / total;
    const coverage = speechMs ? top.ms / speechMs : 0;
    if (ts.length < r.minEvents || ts[ts.length - 1] - ts[0] < r.minSpanMs) continue;
    if (share < r.minShare || coverage < r.minCoverage) continue;
    votes[`1:${dz}`] = {
      name, share, coverage, events: ts.length,
      // Unanimous and well-covered reads as certain; a bare pass reads as merely likely, so the UI
      // marks it unverified.
      confidence: Math.min(0.95, 0.55 + share * 0.25 + Math.min(coverage, 0.5) * 0.3),
      source: 'native-agent',
    };
  }
  return votes;
}

// Back-compat wrapper (tests, tooling). No longer mutates the transcript.
// Returns { renamed: { "1:3": "Priya Shah" }, roster, rosterSources, diagnostics, votes }.
function alignSpeakers(transcript, jsonlPath) {
  const { events, roster, rosterSources, diagnostics } = parseSpeakerEvents(jsonlPath);
  const votes = voteSpeakers(transcript, events);
  const renamed = {};
  for (const [k, v] of Object.entries(votes)) renamed[k] = v.name;
  return { renamed, roster, rosterSources, diagnostics, votes, events };
}

module.exports = { alignSpeakers, parseSpeakerEvents, voteSpeakers, VOTE_RULES };
