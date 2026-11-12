// Per-meeting AI chat: answers ONLY from the transcript + recent prior turns. Never throws.
// Returns { ok: true, answer } or { ok: false, error }. Failures are not chat turns: the caller
// must not store them, and stored ones (from v2.5.0) are filtered out of the history sent here —
// they used to be replayed to the model as if the assistant had said them.
const { chatCompletion } = require('./requesty');
const { transcriptToPrompt } = require('../transcriptUtils');

const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_BYTES = 8000;
const FAILED_RE = /^Chat unavailable — /;

// The usable tail of the conversation: failed answers (and the question they answered) dropped,
// then the most recent turns that fit the budget, always starting on a user turn.
function historyForPrompt(turns) {
  const clean = [];
  for (const t of turns || []) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string') continue;
    if (t.role === 'assistant' && FAILED_RE.test(t.content)) {
      if (clean.length && clean[clean.length - 1].role === 'user') clean.pop();
      continue;
    }
    clean.push({ role: t.role, content: t.content });
  }
  const out = [];
  let bytes = 0;
  for (let i = clean.length - 1; i >= 0 && out.length < MAX_HISTORY_TURNS; i--) {
    bytes += Buffer.byteLength(clean[i].content);
    if (bytes > MAX_HISTORY_BYTES) break;
    out.unshift(clean[i]);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// opts.onDelta(chunk) streams the reply; opts.onReset() clears it before a retry.
async function askMeeting(transcript, priorTurns, question, opts = {}) {
  const { onDelta, onReset } = typeof opts === 'function' ? { onDelta: opts } : opts;
  const text = transcriptToPrompt(transcript);
  if (!text.trim()) return { ok: false, error: 'This meeting has no transcript yet.' };
  try {
    const messages = [
      {
        role: 'system',
        content: `You answer questions about ONE meeting, using ONLY the transcript below. If the transcript does not contain the answer, say so plainly. Be concise.\n\nTRANSCRIPT:\n${text}`,
      },
      ...historyForPrompt(priorTurns),
      { role: 'user', content: question },
    ];
    const out = (await chatCompletion(messages, { onDelta, onReset })).trim();
    return out ? { ok: true, answer: out } : { ok: false, error: 'The AI returned an empty answer — try again.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { askMeeting, historyForPrompt, FAILED_RE };
