// Fixed-structure Markdown meeting summary. Never throws — failures return a
// readable "Summary unavailable — <reason>" string the UI shows as-is.
const { chatCompletion } = require('./requesty');
const { transcriptToPrompt, segSpeaker } = require('../transcriptUtils');

const SYSTEM = `You are an expert executive assistant and elite meeting synthesizer. Your task is to transform raw, messy meeting transcripts into hyper-dense, actionable, and scannable summaries.

### CORE CONSTRAINTS:
1. ONLY use facts directly mentioned in the transcript. Do not assume, extrapolate, or use outside knowledge.
2. If specific details (like deadlines, owners, or metrics) are missing, leave them blank or omit the line entirely. Do not invent placeholders.
3. Keep sentences punchy where possible. Avoid corporate jargon and passive voice.
4. Output your response strictly using the Markdown structure provided below. Do not add conversational intro/outro text (e.g., do not say "Here is your summary:").

### EXTRACTION LOGIC:
- TL;DR: A high-level, 5-6 sentence executive summary capturing the core purpose and ultimate outcome of the meeting.
- SUMMARY: Group the conversation into major thematic or agenda topics. Under each topic, provide brief bullet points explaining the context, debate, or resolution.
- ACTION ITEMS: Immediate, tactical tasks assigned to specific people. Every item MUST have a clear owner name and a due date. If no owner is assigned, label it [Unassigned].
- NEXT STEPS: Strategic, high-level future roadmap goals or follow-up meetings agreed upon.

### OUTPUT FORMAT:
Participants:
[Insert a list of participants, marking the host if known]

🎯 TL;DR
[Insert the 5-6 sentence executive summary here]

📝 Key Discussion Topics
---
[Topic 1 Name]
* [Core point discussed, including relevant numbers or metrics]
* [Key decision or consensus reached on this topic]
[Topic 2 Name]
* [Core point discussed]
* [Key decision or consensus reached on this topic]
---
⚡ Action Items
* [Owner Name]: [Clear, verb-driven action item] (Due: [Date/Timeline if mentioned, otherwise omit])
* [Owner Name]: [Clear, verb-driven action item]
---
🚀 Next Steps
* [High-level strategic milestone or follow-up meeting details]
* [Future roadmap item]`;

// onDelta(chunk) streams the summary; onReset() is called before a retry re-streams it.
async function summarizeTranscript(transcript, onDelta, onReset) {
  const text = transcriptToPrompt(transcript);
  if (!text.trim()) return 'Summary unavailable — the transcript is empty.';
  try {
    const out = await chatCompletion(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Summarize this meeting transcript:\n\n${text}` },
      ],
      onDelta ? { onDelta, onReset } : {}
    );
    return out.trim() || 'Summary unavailable — the AI returned an empty response.';
  } catch (err) {
    return `Summary unavailable — ${err.message}`;
  }
}

function summaryFailed(summary) {
  return !summary || !summary.trim() || summary.startsWith('Summary unavailable');
}

// The summary is generated in parallel with name resolution, on the provisional "Speaker N"
// labels, and the resolved names are substituted in afterwards. `before` maps "<ch>:<dz>" to the
// label the summarizer saw; `after` is the resolved transcript. Only generic labels are rewritten,
// longest first and digit-bounded so "Speaker 1" can never eat the front of "Speaker 12".
function relabelSummary(summary, before, after) {
  if (!summary || summaryFailed(summary)) return summary;
  const finalByKey = new Map();
  for (const s of after || []) finalByKey.set(`${s.channel}:${s.diarizedSpeaker}`, segSpeaker(s));
  const swaps = [];
  for (const [key, oldLabel] of before) {
    const next = finalByKey.get(key);
    if (next && next !== oldLabel && /^Speaker \d+$/.test(oldLabel)) swaps.push([oldLabel, next]);
  }
  swaps.sort((a, b) => b[0].length - a[0].length);
  let out = summary;
  // Function replacer: a name containing `$&` or `$1` must be inserted literally.
  for (const [from, to] of swaps) out = out.replace(new RegExp(`\\b${from}(?!\\d)`, 'g'), () => to);
  return out;
}

module.exports = { summarizeTranscript, summaryFailed, relabelSummary };
