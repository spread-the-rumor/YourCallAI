// Strict-JSON action-item extraction → { items: [{title, assignee, dueDate}], error }.
// Never throws; parse is defensive (fences stripped, first [...] isolated).
const { chatCompletion, parseLooseJson } = require('./requesty');
const { transcriptToText } = require('../transcriptUtils');

async function extractActionItems(transcript) {
  const text = transcriptToText(transcript);
  if (!text.trim()) return { items: [], error: 'No transcript to extract from.' };
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = await chatCompletion([
      {
        role: 'system',
        content: `Extract action items from a meeting transcript. Today's date is ${today} — resolve relative deadlines ("by Friday") to ISO dates. Respond with ONLY a JSON array, no prose:\n[{"title": "...", "assignee": "..." , "dueDate": "YYYY-MM-DD" or ""}]\nOmit nothing real; invent nothing. Empty array if there are none.`,
      },
      { role: 'user', content: text },
    ], { temperature: 0 });
    const arr = parseLooseJson(raw, '[');
    const items = (Array.isArray(arr) ? arr : []).map((x) => ({
      title: String(x.title || '').trim(),
      assignee: String(x.assignee || '').trim(),
      dueDate: String(x.dueDate || '').trim(),
    })).filter((x) => x.title);
    return { items };
  } catch (err) {
    return { items: [], error: `Action-item extraction unavailable — ${err.message}` };
  }
}

module.exports = { extractActionItems };
