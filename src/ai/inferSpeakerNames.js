// Layer 2 (§7): AI name inference for speakers still generic after alignment.
// Returns a mapping { "Speaker 2": "Priya Shah" } — only high-confidence entries. Never throws.
const { chatCompletion, parseLooseJson } = require('./requesty');
const { transcriptToPrompt, participants } = require('../transcriptUtils');

async function inferSpeakerNames(transcript, roster) {
  // Labels come from the FULL transcript — a speaker who only talks early would otherwise be
  // dropped by the cap below and never get resolved.
  const generic = participants(transcript).filter((p) => /^Speaker \d+$/.test(p));
  if (!generic.length) return {};
  const text = transcriptToPrompt(transcript);
  try {
    const raw = await chatCompletion([
      {
        role: 'system',
        content: `A meeting transcript has generic speaker labels. Map labels to real names ONLY when the conversation makes it unambiguous (introductions, "thanks, Priya", roll calls). ${roster?.length ? `Known participants: ${roster.join(', ')}.` : ''} Respond with ONLY a JSON object, e.g. {"Speaker 2": "Priya Shah"}. Include ONLY mappings you are highly confident about; {} if none.`,
      },
      { role: 'user', content: `Labels to resolve: ${generic.join(', ')}\n\nTRANSCRIPT:\n${text}` },
    ], { temperature: 0 });
    const map = parseLooseJson(raw, '{');
    const out = {};
    for (const [k, v] of Object.entries(map || {})) {
      if (generic.includes(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch (err) {
    console.warn('[inferSpeakerNames]', err.message);
    return {};
  }
}

module.exports = { inferSpeakerNames };
