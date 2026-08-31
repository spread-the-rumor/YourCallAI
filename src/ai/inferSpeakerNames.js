// Layer 2 (§7): AI name inference for speakers still generic after alignment.
// Returns { "Speaker 2": { name, confidence, evidence, source } } — only entries that survive the
// guards below. Never throws.
//
// Two things this layer must not do, because both produce a confidently wrong name that then
// propagates into the summary, the action-item assignee and the Slack/Asana send:
//   1. invent a name that nobody in the meeting has (guarded: roster is a CLOSED set when known);
//   2. put the local user on a channel-1 speaker (guarded: ch0 is the user by construction).
const { chatCompletion, parseLooseJson } = require('./requesty');
const { transcriptToNamePrompt, participants } = require('../transcriptUtils');
const { matchToRoster, rosterNames, nameKey, rosterIsTrustworthy } = require('../roster');

const DEFAULT_CONFIDENCE = 0.6; // legacy flat-string responses carry no confidence of their own
const GENERIC_RE = /^Speaker \d+$/;

// Pure: validate a raw model response against the labels we asked about and the roster we allow.
// Accepts both the object shape {"Speaker 2":{"name":..,"confidence":..}} and the legacy flat
// {"Speaker 2":"Priya Shah"} — a model that ignores the schema degrades, it doesn't resolve nothing.
function parseInferenceResponse(raw, generic, roster, userName) {
  let map;
  try { map = parseLooseJson(raw, '{'); } catch { return {}; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};

  // A roster that fails the trustworthiness test is treated as ABSENT rather than as a closed
  // set, so junk scraped from browser chrome can never exclude a real participant.
  const allowed = rosterIsTrustworthy(roster) ? rosterNames(roster) : [];
  const userKey = userName ? nameKey(userName) : '';
  const out = {};

  for (const [label, value] of Object.entries(map)) {
    if (!generic.includes(label)) continue;               // not a label we asked about
    const obj = (value && typeof value === 'object' && !Array.isArray(value)) ? value : { name: value };
    let name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name || GENERIC_RE.test(name)) continue;         // null / "unknown" / echoed label
    if (/^(unknown|unclear|n\/?a|none|null)$/i.test(name)) continue;

    let confidence = typeof obj.confidence === 'number' ? obj.confidence : DEFAULT_CONFIDENCE;

    // Closed-set enforcement. With no roster we have nothing to check against, so the name is
    // taken as-is at reduced confidence — that is exactly today's behaviour, kept as the floor.
    //
    // `allowed` is empty when the roster was rejected as untrustworthy (see rosterIsTrustworthy).
    // That matters: a live Google Meet produced a roster of Chrome toolbar labels
    // ("Back", "Forward", "Work"), and because the real participant was NOT in it, this guard
    // rejected her correctly-inferred name and she stayed "Speaker 1". A junk roster must never
    // be able to exclude a real person — better an unconstrained guess than a guaranteed miss.
    if (allowed.length) {
      const hit = matchToRoster(name, allowed);
      if (!hit) continue;
      name = hit.name;                                    // canonical spelling from the roster
      confidence = Math.min(confidence, hit.score);
    } else {
      confidence = Math.min(confidence, 0.55);
    }

    // The local user is on channel 0 by construction, so they cannot be a ch1 speaker.
    if (userKey && nameKey(name) === userKey) continue;

    out[label] = {
      name,
      confidence: Math.max(0, Math.min(1, confidence)),
      evidence: typeof obj.evidence === 'string' ? obj.evidence.slice(0, 200) : '',
      source: 'ai-inference',
    };
  }

  // One person cannot be two speakers: keep the most confident label, drop the rest.
  const byName = new Map();
  for (const [label, e] of Object.entries(out)) {
    const k = nameKey(e.name);
    const prev = byName.get(k);
    if (!prev || e.confidence > out[prev].confidence) {
      if (prev) delete out[prev];
      byName.set(k, label);
    } else {
      delete out[label];
    }
  }
  return out;
}

function buildPrompt(generic, roster, subject) {
  // A roster that fails the trustworthiness test is treated as ABSENT rather than as a closed
  // set, so junk scraped from browser chrome can never exclude a real participant.
  const allowed = rosterIsTrustworthy(roster) ? rosterNames(roster) : [];
  const closed = allowed.length
    ? `The people in this meeting are EXACTLY: ${allowed.join(', ')}. `
      + `You MUST choose each name from that list verbatim. If a label cannot be matched to someone `
      + `on the list with high confidence, map it to null. Never output a name that is not on the list.`
    : `No participant list is available, so only use names the transcript itself states.`;
  return 'You are resolving generic speaker labels in a meeting transcript to real people.\n'
    + `${closed}\n`
    + (subject ? `Meeting subject: ${subject}\n` : '')
    + 'Rely on direct evidence: self-introductions ("Hi, I\'m Priya"), someone being addressed '
    + '("thanks, Priya"), roll calls, hand-offs. Do NOT guess from topic, role or speaking order.\n'
    + 'Respond with ONLY a JSON object mapping each label to either null or '
    + '{"name": <name>, "confidence": <0-1>, "evidence": "<short quote>"}. Example:\n'
    + '{"Speaker 2": {"name": "Priya Shah", "confidence": 0.9, "evidence": "\\"Hi, I\'m Priya\\""}, '
    + '"Speaker 3": null}';
}

// roster: string[] | [{name, confidence}] — the closed set. opts.subject: meeting title context.
// opts.userName: the channel-0 speaker, excluded from ch1 results.
async function inferSpeakerNames(transcript, roster, opts = {}) {
  // Labels come from the FULL transcript — a speaker who only talks early would otherwise be
  // dropped by the prompt budget and never get resolved.
  const generic = participants(transcript).filter((p) => GENERIC_RE.test(p));
  if (!generic.length) return {};
  const text = transcriptToNamePrompt(transcript);
  if (!text) return {};

  const ask = async (labels) => {
    const raw = await chatCompletion([
      { role: 'system', content: buildPrompt(labels, roster, opts.subject) },
      { role: 'user', content: `Labels to resolve: ${labels.join(', ')}\n\nTRANSCRIPT:\n${text}` },
    ], { temperature: 0 });
    return parseInferenceResponse(raw, labels, roster, opts.userName);
  };

  try {
    const first = await ask(generic);

    // Second pass only when it can actually help: a label is still unresolved AND a roster name is
    // still unused. Bounded to one extra call.
    const unresolved = generic.filter((l) => !first[l]);
    const used = new Set(Object.values(first).map((e) => nameKey(e.name)));
    // Only a trustworthy roster can supply candidate names for the second pass; otherwise the
    // "unused participants" list would just be more browser chrome.
    const trusted = rosterIsTrustworthy(roster) ? rosterNames(roster) : [];
    const unused = trusted.filter((n) => !used.has(nameKey(n)));
    if (unresolved.length && unused.length) {
      try {
        const second = await inferSecondPass(unresolved, unused, text, opts);
        for (const [k, v] of Object.entries(second)) if (!first[k]) first[k] = v;
      } catch (err) {
        console.warn('[inferSpeakerNames] second pass:', err.message);
      }
    }
    return first;
  } catch (err) {
    console.warn('[inferSpeakerNames]', err.message);
    return {};
  }
}

async function inferSecondPass(labels, unusedNames, text, opts) {
  const raw = await chatCompletion([
    { role: 'system', content: buildPrompt(labels, unusedNames, opts.subject) },
    {
      role: 'user',
      content: `These labels are still unidentified: ${labels.join(', ')}\n`
        + `These participants have not been matched to any label yet: ${unusedNames.join(', ')}\n`
        + 'Match them only where the transcript gives direct evidence.\n\n'
        + `TRANSCRIPT:\n${text}`,
    },
  ], { temperature: 0 });
  return parseInferenceResponse(raw, labels, unusedNames, opts.userName);
}

module.exports = { inferSpeakerNames, parseInferenceResponse };
