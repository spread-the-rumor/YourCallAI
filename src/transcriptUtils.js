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

function participants(transcript) {
  return [...new Set((transcript || []).map(segSpeaker))];
}

function durationSeconds(transcript) {
  if (!transcript || !transcript.length) return 0;
  const last = transcript[transcript.length - 1];
  const w = last.words && last.words[last.words.length - 1];
  return (w && w.end_timestamp && w.end_timestamp.relative) || 0;
}

module.exports = { segSpeaker, segText, meetingDate, transcriptToText, participants, durationSeconds };
