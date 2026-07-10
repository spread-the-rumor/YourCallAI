// Per-meeting AI chat: answers ONLY from the full transcript + prior turns. Never throws.
const { chatCompletion } = require('./requesty');
const { transcriptToText } = require('../transcriptUtils');

async function askMeeting(transcript, priorTurns, question) {
  const text = transcriptToText(transcript);
  if (!text.trim()) return 'Chat unavailable — this meeting has no transcript.';
  try {
    const messages = [
      {
        role: 'system',
        content: `You answer questions about ONE meeting, using ONLY the transcript below. If the transcript does not contain the answer, say so plainly. Be concise.\n\nTRANSCRIPT:\n${text}`,
      },
      ...(priorTurns || []).map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: question },
    ];
    const out = await chatCompletion(messages);
    return out.trim() || 'Chat unavailable — the AI returned an empty response.';
  } catch (err) {
    return `Chat unavailable — ${err.message}`;
  }
}

module.exports = { askMeeting };
