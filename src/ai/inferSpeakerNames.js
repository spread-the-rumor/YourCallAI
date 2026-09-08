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
// Ceilings for the weaker tiers. Both sit below the 0.85 the renderer uses to draw a name as
// settled, so anything inferred from conversational flow (rather than a stated introduction)
// shows the dotted underline + "?" and reads as a suggestion — which is what it is.
const CONVERSATIONAL_MAX = 0.7;
const COMPLETION_CONFIDENCE = 0.55;

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

// The strict pass demands a stated introduction or someone being addressed by name. Recurring
// internal meetings contain neither — nobody says "Hi, I'm Tarun" in the daily standup — so it
// correctly resolves nothing and every voice stays "Speaker N". This tier is allowed to reason
// from conversational structure instead, against the SAME closed roster, and its answers are
// capped below the "verified" threshold so they render as suggestions.
function buildConversationalPrompt(labels, allowed, subject) {
  return 'You are matching generic speaker labels in a meeting transcript to a known list of '
    + 'attendees. The attendee list is COMPLETE and correct.\n'
    + `The people in this meeting are EXACTLY: ${allowed.join(', ')}. `
    + 'You MUST choose each name from that list verbatim, or null. Never output a name not on it.\n'
    + (subject ? `Meeting subject: ${subject}\n` : '')
    + 'There are no self-introductions here, so use conversational evidence: who is addressed by '
    + 'name and who answers next; who hands off work to whom; who reports on which area across the '
    + 'meeting; who asks versus who decides; references like "as I mentioned" tied to an earlier turn.\n'
    + 'Be decisive where the structure is clear, but output null rather than a coin-flip — a wrong '
    + 'name is worse than no name. Do not assign the same person to two labels.\n'
    + 'Respond with ONLY a JSON object mapping each label to null or '
    + '{"name": <name>, "confidence": <0-1>, "evidence": "<short quote>"}.';
}

// Pure. Last resort for the one case that is deduction rather than guessing: a single unnamed
// voice and a single roster member nobody has been matched to. Anything less clear-cut is left
// alone. Never assigns the ch0 user (they are on channel 0 by construction).
function completeByElimination(unresolvedLabels, unusedNames, userName) {
  if (unresolvedLabels.length !== 1 || unusedNames.length !== 1) return {};
  const name = unusedNames[0];
  if (userName && nameKey(name) === nameKey(userName)) return {};
  return {
    [unresolvedLabels[0]]: {
      name,
      confidence: COMPLETION_CONFIDENCE,
      evidence: 'only remaining participant',
      source: 'ai-inference',
    },
  };
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

    // Tier 3: conversational inference over the closed roster, for what evidence-only could not
    // reach. Only worth running when a trustworthy roster still has unmatched people in it.
    const stillUnresolved = generic.filter((l) => !first[l]);
    const usedNow = new Set(Object.values(first).map((e) => nameKey(e.name)));
    const stillUnused = trusted.filter((n) => !usedNow.has(nameKey(n)));
    if (stillUnresolved.length && stillUnused.length) {
      try {
        const third = await inferConversational(stillUnresolved, stillUnused, text, opts);
        for (const [k, v] of Object.entries(third)) if (!first[k]) first[k] = v;
      } catch (err) {
        console.warn('[inferSpeakerNames] conversational pass:', err.message);
      }
    }

    // Tier 4: pure elimination, no model call.
    const finalUnresolved = generic.filter((l) => !first[l]);
    const finalUsed = new Set(Object.values(first).map((e) => nameKey(e.name)));
    const finalUnused = trusted.filter((n) => !finalUsed.has(nameKey(n)));
    Object.assign(first, completeByElimination(finalUnresolved, finalUnused, opts.userName));

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

// Same guard pipeline as every other tier (closed set, ch0-user exclusion, one-person-one-label),
// then clamped: conversational reasoning can be right often, but it is never *evidence*, so it
// must not be able to present itself as settled.
async function inferConversational(labels, unusedNames, text, opts) {
  const raw = await chatCompletion([
    { role: 'system', content: buildConversationalPrompt(labels, unusedNames, opts.subject) },
    {
      role: 'user',
      content: `Labels still unidentified: ${labels.join(', ')}\n`
        + `Attendees not yet matched to any label: ${unusedNames.join(', ')}\n\n`
        + `TRANSCRIPT:\n${text}`,
    },
  ], { temperature: 0 });
  const parsed = parseInferenceResponse(raw, labels, unusedNames, opts.userName);
  for (const entry of Object.values(parsed)) {
    entry.confidence = Math.min(entry.confidence, CONVERSATIONAL_MAX);
  }
  return parsed;
}

module.exports = { inferSpeakerNames, parseInferenceResponse, completeByElimination, CONVERSATIONAL_MAX };
