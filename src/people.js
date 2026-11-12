// Who attends what (§7) — learned from the user's own library, no new storage.
//
// The names pipeline used to treat every meeting as the first one. Measured on the real library:
// the same recurring meeting ("Daily Sync - Hernan", 42 times) had its host fixed by hand 12 times,
// and none of it carried over — the next day's meeting started from nothing again, and on platforms
// with no readable participant list (Zoom: 7 of 10 meetings) there was no candidate at all.
//
// This derives, from meetings already in the store:
//   - CONFIRMED people per meeting: manual renames (weight 1) and high-confidence names (0.5);
//   - which past meetings are "the same meeting" as a new one, by typed title, by overlap with
//     its participant list, or by recurring time slot;
// and offers their people as candidates (history), plus hints for transcription (keyterms).
// Pure functions over a meetings array; the async wrappers read the in-memory store.
const path = require('path');
const { nameKey, normalizeName, isPersonName } = require('./roster');
const { readSpeakerMap } = require('./speakerResolve');

const DEFAULT_TITLE_RE = /^Meeting · /; // buildTitle() in main.js — not a user-chosen title
const GENERIC_WINDOW_TITLES = /^(microsoft teams|zoom( meeting| workplace)?|google meet|meet|slack|huddle)$/i;

// "Daily Sync - Hernan (Nov 9)" → "daily sync hernan". Null for titles that name nothing.
function seriesKeyFor(title) {
  if (!title || DEFAULT_TITLE_RE.test(title) || GENERIC_WINDOW_TITLES.test(title.trim())) return null;
  const k = String(title).toLowerCase()
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, ' ')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, ' ')
    .replace(/\d+/g, ' ').replace(/[^\p{L} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  return k.length >= 3 ? k : null;
}

// Which remote voice spoke most in a meeting ("1:<dz>"), from its transcript text.
function dominantKey(meeting) {
  const words = new Map();
  for (const s of (meeting && meeting.transcript) || []) {
    if (s.channel !== 1) continue;
    const k = `1:${s.diarizedSpeaker}`;
    words.set(k, (words.get(k) || 0) + String(s.text || '').split(/\s+/).length);
  }
  let best = null;
  for (const [k, n] of words) if (!best || n > best[1]) best = [k, n];
  return best && best[0];
}

// Confirmed remote people in one meeting: [{ name, weight, dominant }].
function confirmedPeople(meeting, userName) {
  const out = new Map();
  const userKey = userName ? nameKey(userName) : '';
  const dom = dominantKey(meeting);
  for (const [key, e] of Object.entries(readSpeakerMap(meeting && meeting.speakerMap))) {
    if (key.startsWith('0:')) continue;
    const name = normalizeName(e.name);
    const k = nameKey(name);
    if (!k || k === userKey || !isPersonName(name)) continue;
    const manual = e.lockedByUser || e.source === 'manual';
    const weight = manual ? 1 : (e.confidence >= 0.85 ? 0.5 : 0);
    if (!weight) continue;
    const prev = out.get(k);
    if (!prev || weight > prev.weight) out.set(k, { name, weight, dominant: key === dom && manual });
  }
  return [...out.values()];
}

const minutesOfDay = (iso) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };

// Past meetings that are plausibly the same recurring meeting as `target`.
// target: { id, title, date, roster: [names] }
function relatedMeetings(meetings, target) {
  const tKey = seriesKeyFor(target.title);
  const rosterKeys = new Set((target.roster || []).map(nameKey).filter(Boolean));
  const tMin = target.date ? minutesOfDay(target.date) : null;
  const tDay = target.date ? new Date(target.date).getDay() : null;
  const byTitle = [], byRoster = [], bySlot = [];
  for (const m of meetings) {
    if (!m || m.id === target.id || m.deletedAt) continue;
    if (tKey && seriesKeyFor(m.title) === tKey) { byTitle.push(m); continue; }
    if (rosterKeys.size >= 2) {
      const theirs = new Set([...(m.nameAttribution?.roster || []), ...confirmedPeople(m).map((p) => p.name)].map(nameKey));
      const inter = [...rosterKeys].filter((k) => theirs.has(k)).length;
      const union = new Set([...rosterKeys, ...theirs]).size;
      if (union && inter / union >= 0.5) { byRoster.push(m); continue; }
    }
    if (tMin != null && m.date) {
      const d = Math.abs(minutesOfDay(m.date) - tMin);
      const weekdayMatch = new Date(m.date).getDay() === tDay || (tDay >= 1 && tDay <= 5 && new Date(m.date).getDay() >= 1 && new Date(m.date).getDay() <= 5);
      if (d <= 20 && weekdayMatch) bySlot.push(m);
    }
  }
  if (byTitle.length) return { basis: 'title', meetings: byTitle };
  if (byRoster.length) return { basis: 'roster', meetings: byRoster };
  // A time slot alone is weak: only trust it when it recurs.
  if (bySlot.length >= 3) return { basis: 'time-slot', meetings: bySlot };
  return { basis: null, meetings: [] };
}

// Candidate people for a meeting, most-attending first: [{ name, count }].
function historyFor(meetings, target, { userName, limit = 8 } = {}) {
  const { basis, meetings: related } = relatedMeetings(meetings, target);
  if (!related.length) return { basis: null, people: [] };
  const score = new Map();
  for (const m of related) {
    for (const p of confirmedPeople(m, userName)) {
      const k = nameKey(p.name);
      const s = score.get(k) || { name: p.name, count: 0, weight: 0, manual: 0, dominant: 0 };
      s.count += 1; s.weight += p.weight;
      if (p.weight === 1) { s.name = p.name; s.manual += 1; } // the user's own spelling wins
      if (p.dominant) s.dominant += 1;
      score.set(k, s);
    }
  }
  // "Hernan" (an early rename) and "Hernan Zapata" (a later one) are one person: fold a mononym
  // into the single fuller name that starts with it.
  for (const [k, s] of [...score.entries()]) {
    if (k.includes(' ')) continue;
    const fuller = [...score.entries()].filter(([k2]) => k2 !== k && k2.split(' ')[0] === k);
    if (fuller.length !== 1) continue;
    const [, f] = fuller[0];
    f.count += s.count; f.weight += s.weight; f.manual += s.manual; f.dominant += s.dominant;
    score.delete(k);
  }
  const minWeight = basis === 'time-slot' ? 1.5 : 0.5;
  const people = [...score.values()].filter((s) => s.weight >= minWeight)
    .sort((a, b) => b.weight - a.weight).slice(0, limit)
    .map(({ name, count, manual, dominant }) => ({ name, count, manual, dominant }));
  return { basis, people };
}

// Everyone the user has ever confirmed, most frequent first — the transcription vocabulary.
function knownPeople(meetings, { userName, limit = 40 } = {}) {
  const score = new Map();
  for (const m of meetings) {
    if (!m || m.deletedAt) continue;
    for (const p of confirmedPeople(m, userName)) {
      const k = nameKey(p.name);
      const s = score.get(k) || { name: p.name, weight: 0 };
      s.weight += p.weight;
      score.set(k, s);
    }
  }
  return [...score.values()].sort((a, b) => b.weight - a.weight).slice(0, limit).map((s) => s.name);
}

// ---------- store-backed wrappers ----------

function rosterFromJsonl(dir) {
  try {
    const { parseSpeakerEvents } = require('./align');
    return parseSpeakerEvents(path.join(dir, 'speakers.jsonl')).roster || [];
  } catch { return []; }
}

// Deepgram keyterms for a recording: the user, names read off the meeting app, the people who
// attend this meeting, then everyone the user knows — deduplicated, person-shaped, bounded.
async function nameHints({ dir, meta, prior, userName }) {
  const store = require('./store');
  const meetings = await store.loadAllRaw();
  const roster = rosterFromJsonl(dir).filter((n) => isPersonName(n));
  const target = { id: meta && meta.id, title: (prior && prior.title) || (meta && meta.title), date: meta && meta.startedAt, roster };
  const out = [];
  const add = (n) => { const name = normalizeName(n); if (name && isPersonName(name) && !out.some((x) => nameKey(x) === nameKey(name))) out.push(name); };
  if (userName) add(userName);
  roster.forEach(add);
  historyFor(meetings, target, { userName }).people.forEach((p) => add(p.name));
  knownPeople(meetings, { userName, limit: 30 }).forEach(add);
  return out.slice(0, 50);
}

// Kept as a hook for the pipeline: learning is implicit (history is recomputed from the store),
// so there is nothing to write.
async function learnPeople() {}

module.exports = {
  seriesKeyFor, confirmedPeople, relatedMeetings, historyFor, knownPeople, nameHints, learnPeople,
};
