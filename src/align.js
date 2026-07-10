// Layer 1 speaker alignment (§7): overlap-vote channel-1 diarized speakers against
// active-speaker intervals from speakers.jsonl. A name wins a speaker if it covers
// ≥ 60% of that speaker's overlapped speech time.
const fs = require('fs');

function parseSpeakerEvents(jsonlPath) {
  const events = [];
  const roster = new Set();
  let raw = '';
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch { return { events, roster: [] }; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'active-speaker' && ev.name && ev.ts) events.push({ ts: ev.ts, name: ev.name });
      else if (ev.type === 'roster' && Array.isArray(ev.names)) ev.names.forEach((n) => roster.add(n));
    } catch { /* tolerate partial lines from a killed agent */ }
  }
  events.sort((a, b) => a.ts - b.ts);
  events.forEach((e) => roster.add(e.name));
  return { events, roster: [...roster] };
}

// Each event holds from its ts until the next event; the last one gets a 15s cap.
function toIntervals(events) {
  return events.map((e, i) => ({
    name: e.name,
    start: e.ts,
    end: events[i + 1] ? events[i + 1].ts : e.ts + 15000,
  }));
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Mutates transcript segments: relabels "Speaker N" → real name where the vote is decisive.
// Returns { renamed: { "1:3": "Priya Shah" }, roster: [...] }
function alignSpeakers(transcript, jsonlPath) {
  const { events, roster } = parseSpeakerEvents(jsonlPath);
  const renamed = {};
  if (!events.length || !transcript?.length) return { renamed, roster };
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
    const votes = new Map();
    let total = 0;
    for (const r of ranges) {
      for (const iv of intervals) {
        const ms = overlapMs(r.start, r.end, iv.start, iv.end);
        if (ms > 0) { votes.set(iv.name, (votes.get(iv.name) || 0) + ms); total += ms; }
      }
    }
    if (!total) continue;
    const [topName, topMs] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topMs / total >= 0.6) {
      renamed[`1:${dz}`] = topName;
      for (const seg of transcript) {
        if (seg.channel === 1 && seg.diarizedSpeaker === dz) seg.speaker = topName;
      }
    }
  }
  return { renamed, roster };
}

module.exports = { alignSpeakers, parseSpeakerEvents };
