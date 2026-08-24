// Single source of truth for reading transcript segments (§4.1). Used by main, AI modules, renderer.

function segSpeaker(seg) {
  return (seg && (seg.speaker || (seg.participant && seg.participant.name))) || 'Speaker';
}

function segText(seg) {
  if (!seg) return '';
  return Array.isArray(seg.words) ? seg.words.map((w) => w.text).join(' ') : (seg.text || '');
}

function meetingDate(transcript) {
  return (transcript && transcript[0] && transcript[0].words && transcript[0].words[0] &&
    transcript[0].words[0].start_timestamp && transcript[0].words[0].start_timestamp.absolute) || null;
}

function transcriptToText(transcript) {
  return (transcript || []).map((s) => `${segSpeaker(s)}: ${segText(s)}`).join('\n');
}

// Byte cap for transcripts sent to the AI. The provider rejects oversized requests outright with a
// 429 whose text talks about quota/billing, which is misleading — it's a per-request token limit.
// Measured cliff is ~60 KB; 48 KB leaves headroom for the system prompt and the model's own output.
const MAX_PROMPT_BYTES = 48 * 1024;
const OMITTED_MARKER = '[earlier portion of the transcript omitted]\n';

// Transcript text for an AI prompt, trimmed to fit. Keeps the END of the meeting: decisions and
// action items land there, so dropping the tail would remove exactly what we're extracting.
// Same shrink-loop approach as sendTranscript() in integrations/getoverview.js.
function transcriptToPrompt(transcript, maxBytes = MAX_PROMPT_BYTES) {
  const text = transcriptToText(transcript);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(OMITTED_MARKER, 'utf8');
  let kept = text.slice(-budget); // chars ≥ bytes, so this starts at or under budget in bytes
  while (Buffer.byteLength(kept, 'utf8') > budget) {
    kept = kept.slice(Math.ceil(kept.length * 0.1));
  }
  // Resume at a turn boundary so the first line isn't a half-sentence with no speaker.
  const nl = kept.indexOf('\n');
  if (nl > -1 && nl < kept.length - 1) kept = kept.slice(nl + 1);
  return OMITTED_MARKER + kept;
}

function participants(transcript) {
  return [...new Set((transcript || []).map(segSpeaker))];
}

function durationSeconds(transcript) {
  if (!transcript || !transcript.length) return 0;
  const last = transcript[transcript.length - 1];
  const w = last.words && last.words[last.words.length - 1];
  return (w && w.end_timestamp && w.end_timestamp.relative) || 0;
}

module.exports = {
  segSpeaker, segText, meetingDate, transcriptToText, transcriptToPrompt,
  participants, durationSeconds, MAX_PROMPT_BYTES,
};
