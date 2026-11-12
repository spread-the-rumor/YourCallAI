// AI name inference (§7): ONE call that names every still-generic remote speaker, then strict
// validation in code. Never throws.
//
// This replaced four sequential tiers (strict → second pass → conversational → elimination). That
// design cost up to three serial model calls per meeting, and measured on the real library it still
// left 31% of remote speakers as "Speaker N". Its failures were structural, not a matter of tuning:
//   - the strict prompt demanded an introduction or being addressed by name, so the HOST — the
//     one person nobody addresses — was never named. All 17 of the user's manual renames were the
//     host or dominant speaker (Hernan, 12 times).
//   - the 2nd/3rd passes passed the roster as bare strings, which failed the trust test, so the
//     closed set silently disappeared and anything was accepted at 0.55.
//   - nothing knew who usually attends a recurring meeting, or what the meeting is called.
// Now the model gets every candidate source at once — the meeting app's participant list, the
// people who attend this recurring meeting, the meeting title — plus explicit host reasoning, and
// must quote its evidence. Code then decides how far to trust each answer.
const { chatCompletion, parseLooseJson } = require('./requesty');
const { transcriptToNamePrompt, segSpeaker, segText } = require('../transcriptUtils');
const { matchToRoster, rosterNames, nameKey, isPersonName } = require('../roster');

const GENERIC_RE = /^Speaker \d+$/;

// Ceilings by the KIND of evidence, so the confidence the UI shows says how the name was found.
// Anything below 0.85 renders as unverified (dotted, "?"), i.e. as a suggestion.
const CAPS = {
  introduction: 0.92,
  addressed: 0.9,
  handoff: 0.88,
  host: 0.78,
  title: 0.78,
  topic: 0.68,
  history: 0.65,
  other: 0.6,
};
const UNVERIFIED_QUOTE_CAP = 0.6; // claimed direct evidence whose quote is not in the transcript
const OPEN_CAP = 0.55;            // no candidate list at all: a name the transcript itself uses
const FRAGMENT_WORDS = 150;       // a diarization fragment this small may share a name (see below)

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

// Per-label statistics the model needs and the transcript text alone hides: how much each voice
// spoke and when it first appeared. The host usually speaks most and first.
function labelStats(transcript, labels) {
  const stats = {};
  let total = 0;
  for (const s of transcript || []) {
    const words = segText(s).split(/\s+/).filter(Boolean).length;
    total += words;
    const l = segSpeaker(s);
    if (!labels.includes(l)) continue;
    const e = stats[l] || (stats[l] = { words: 0, turns: 0, firstAt: s.start != null ? s.start : null });
    e.words += words;
    e.turns += 1;
  }
  for (const e of Object.values(stats)) e.share = total ? e.words / total : 0;
  return stats;
}

const fmtTime = (sec) => (sec == null ? '?' : `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`);

function buildPrompt({ labels, stats, candidates, userName, known }) {
  const lines = [];
  lines.push('You identify which person each generic speaker label in a meeting transcript is.');
  lines.push(`"${userName || 'The user'}" recorded this meeting on their own microphone and appears under their own name. They are NEVER one of the labels you are resolving.`);
  if (candidates.roster.length) {
    lines.push(`Participants, read from the meeting app${candidates.rosterTrusted ? '' : ' (may be incomplete or contain non-people)'}: ${candidates.roster.join(', ')}.`);
  }
  if (candidates.history.length) {
    lines.push(`People who regularly attend this meeting (from past meetings the user confirmed): ${candidates.history.map((h) => `${h.name} (${h.count}×)`).join(', ')}.`);
  }
  if (candidates.titles.length) lines.push(`Meeting title: ${candidates.titles.map((t) => `"${t}"`).join(' / ')}.`);
  if (Object.keys(known).length) {
    lines.push(`Already identified by the meeting app: ${Object.entries(known).map(([l, n]) => `${l} = ${n}`).join(', ')}.`);
  }
  lines.push('');
  lines.push('How to decide, strongest evidence first:');
  lines.push('- introduction: the speaker says who they are ("Hi, I\'m Priya").');
  lines.push('- addressed: someone says a name and that label answers next ("Tarun, how is the build?" → Tarun speaks).');
  lines.push('- handoff: the label is named as the next to speak ("over to you, Felipe").');
  lines.push('- host: the person running the meeting opens it, calls on others by name, asks for updates and decides; they are rarely addressed by name themselves. A title such as "Sync - Hernan" often names the host.');
  lines.push('- title: the meeting title names this person.');
  lines.push('- topic: the label reports on work that a candidate owns elsewhere in the conversation.');
  lines.push('- history: only that this person usually attends.');
  lines.push('');
  lines.push('Rules:');
  lines.push(candidates.closed
    ? '- Choose names ONLY from the participants above, spelled exactly as listed.'
    : candidates.any
      ? '- Prefer the candidates above, spelled exactly as listed. Use another name only if the transcript itself clearly uses it for that speaker.'
      : '- There is no participant list. Use a name only if the transcript itself uses it for that speaker.');
  lines.push('- One person per label. If two labels are clearly the same voice split in two, you may give both the same name.');
  lines.push('- Prefer null to a guess: a wrong name is worse than no name.');
  lines.push('- "quote" must be words copied exactly from the transcript that support your answer.');
  lines.push('');
  lines.push('Labels to resolve:');
  for (const l of labels) {
    const s = stats[l] || { words: 0, turns: 0, share: 0 };
    lines.push(`- ${l}: ${s.words} words in ${s.turns} turns (${Math.round(s.share * 100)}% of all speech), first speaks at ${fmtTime(s.firstAt)}`);
  }
  lines.push('');
  lines.push('Reply with ONLY a JSON object mapping each label to null or');
  lines.push('{"name": "<name>", "confidence": <0-1>, "basis": "introduction|addressed|handoff|host|title|topic|history|other", "quote": "<exact words>"}');
  return lines.join('\n');
}

// PURE. Validate the model's answer. Everything that can make a name wrong is checked here, not
// trusted from the model:
//   - the name must be a candidate (fuzzy-matched, canonical spelling) when candidates exist,
//     or a person-shaped name the transcript itself uses when they do not;
//   - never the user (ch0 by construction), compared fuzzily so "Sagar" ≠ "Sagar Bansal" can't slip;
//   - claimed direct evidence must quote the transcript, or it is capped as unverified;
//   - confidence is capped by the kind of evidence;
//   - one person, one label — except a small diarization fragment of a voice already named.
function parseInferenceResponse(raw, labels, candidates, opts = {}) {
  let map;
  try { map = parseLooseJson(raw, '{'); } catch { return {}; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const { userName, transcriptText = '', stats = {} } = opts;
  const pool = candidates.pool || [];
  const haystack = norm(transcriptText);
  const isUser = (n) => {
    if (!userName) return false;
    if (nameKey(n) === nameKey(userName)) return true;
    const hit = matchToRoster(n, [userName]);
    return !!hit && hit.score >= 0.7;
  };
  const out = {};

  for (const [label, value] of Object.entries(map)) {
    if (!labels.includes(label)) continue;
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : { name: value };
    let name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name || GENERIC_RE.test(name) || /^(unknown|unclear|n\/?a|none|null)$/i.test(name)) continue;

    const basis = CAPS[obj.basis] ? obj.basis : 'other';
    let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.6;
    confidence = Math.min(confidence, CAPS[basis]);

    const hit = pool.length ? matchToRoster(name, pool) : null;
    if (hit) {
      name = hit.name;
      if (hit.score < 1) confidence = Math.min(confidence, Math.max(hit.score, 0.6));
      // A name only known from history (not on this meeting's own list) is a weaker claim.
      if (!candidates.inMeeting.has(nameKey(name))) confidence = Math.min(confidence, CAPS.host);
    } else if (candidates.closed) {
      continue; // a trusted participant list is a closed set
    } else {
      // Open inference: the name must be person-shaped and actually appear in the transcript.
      // Allowed alongside a soft candidate list, so a junk or partial roster can never exclude a
      // real person (a polluted Meet roster once kept a correctly-named guest as "Speaker 1").
      // Without any candidate, only DIRECT, QUOTED evidence counts — measured on the real library,
      // weaker open guesses were mostly speech-to-text noise ("Darn", "Nava", "Neve").
      if (!isPersonName(name)) continue;
      const first = norm(name).split(' ')[0];
      if (!first || !haystack.includes(first)) continue;
      const q = norm(typeof obj.quote === 'string' ? obj.quote : '');
      const directBasis = basis === 'introduction' || basis === 'addressed' || basis === 'handoff';
      if (!directBasis || !q || !haystack.includes(q) || !q.includes(first)) continue;
      confidence = Math.min(confidence, OPEN_CAP);
    }
    if (isUser(name)) continue;

    const quote = typeof obj.quote === 'string' ? obj.quote : (typeof obj.evidence === 'string' ? obj.evidence : '');
    const direct = basis === 'introduction' || basis === 'addressed' || basis === 'handoff';
    const quoteFound = !!quote && norm(quote).length >= 3 && haystack.includes(norm(quote));
    if (direct && !quoteFound) confidence = Math.min(confidence, UNVERIFIED_QUOTE_CAP);

    out[label] = {
      name,
      confidence: Math.max(0, Math.min(1, confidence)),
      basis: direct && !quoteFound ? `${basis}-unverified` : basis,
      evidence: quote.slice(0, 200),
      source: 'ai-inference',
    };
  }

  // One person per label. Diarization does split one voice into several labels (seen: Hernan
  // three times in one meeting), so a SMALL fragment may keep the same name, demoted; otherwise
  // only the most confident label keeps it.
  const byName = new Map();
  for (const [label, e] of Object.entries(out).sort((a, b) => b[1].confidence - a[1].confidence)) {
    const k = nameKey(e.name);
    if (!byName.has(k)) { byName.set(k, label); continue; }
    if ((stats[label]?.words ?? Infinity) <= FRAGMENT_WORDS) {
      e.confidence = Math.min(e.confidence, 0.6);
      e.basis = `${e.basis}+fragment`;
    } else {
      delete out[label];
    }
  }
  return out;
}

// transcript: segments with ch1 labels still generic where unresolved.
// candidates: { roster: [{name}], rosterTrusted, history: [{name, count}], titles: [string] }
// opts: { userName, known: { "Speaker 2": "Name" } (labels already settled; excluded), onRaw }
// Returns { map: { "Speaker 2": {...} }, raw, labels, prompt: { bytes } }.
async function inferSpeakerNames(transcript, cand = {}, opts = {}) {
  const known = opts.known || {};
  const labels = [...new Set((transcript || []).filter((s) => s.channel !== 0).map(segSpeaker))]
    .filter((l) => GENERIC_RE.test(l) && !known[l]);
  if (!labels.length) return { map: {}, labels };
  const text = transcriptToNamePrompt(transcript);
  if (!text) return { map: {}, labels };

  const roster = rosterNames(cand.roster).filter((n) => !opts.userName || nameKey(n) !== nameKey(opts.userName));
  const history = (cand.history || []).filter((h) => h && h.name);
  const titles = (cand.titles || []).filter(Boolean);
  // Candidate pool for validation. Only a TRUSTED participant list closes the set; an untrusted one
  // is still offered to the model (it often holds the real people among the junk) and still
  // canonicalises spellings, but never excludes anyone.
  const pool = [...new Set([...roster, ...history.map((h) => h.name)])];
  const inMeeting = new Set(roster.map(nameKey));
  const candidates = {
    roster, rosterTrusted: !!cand.rosterTrusted, history, titles,
    any: pool.length > 0, closed: !!cand.rosterTrusted && roster.length > 0, pool, inMeeting,
  };
  const stats = labelStats(transcript, labels);
  const system = buildPrompt({ labels, stats, candidates, userName: opts.userName, known });

  let raw = '';
  try {
    raw = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: `TRANSCRIPT:\n${text}` },
    ], { temperature: 0, purpose: 'names' });
  } catch (err) {
    return { map: {}, labels, error: err.message, prompt: { bytes: system.length + text.length } };
  }
  const transcriptText = (transcript || []).map(segText).join('\n');
  const map = parseInferenceResponse(raw, labels, candidates, { userName: opts.userName, transcriptText, stats });
  return { map, raw, labels, prompt: { bytes: system.length + text.length } };
}

module.exports = { inferSpeakerNames, parseInferenceResponse, buildPrompt, labelStats, CAPS, OPEN_CAP };
