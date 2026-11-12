// Single source of truth for reading transcript segments (§4.1). Used by main, AI modules, renderer.

function segSpeaker(seg) {
  return (seg && (seg.speaker || (seg.participant && seg.participant.name))) || 'Speaker';
}

function segText(seg) {
  if (!seg) return '';
  return Array.isArray(seg.words) ? seg.words.map((w) => w.text).join(' ') : (seg.text || '');
}

// Segment timing, from either shape: the full pipeline segment (per-word `words`) or the compact
// stored one (`start`/`end` relative seconds + `startAt`/`endAt` ISO; see store.compactSegment).
function segStartIso(seg) {
  if (!seg) return null;
  const w = Array.isArray(seg.words) && seg.words[0];
  return (w && w.start_timestamp && w.start_timestamp.absolute) || seg.startAt || null;
}
function segEndIso(seg) {
  if (!seg) return null;
  const w = Array.isArray(seg.words) && seg.words[seg.words.length - 1];
  return (w && w.end_timestamp && w.end_timestamp.absolute) || seg.endAt || null;
}
function segEndRel(seg) {
  if (!seg) return 0;
  const w = Array.isArray(seg.words) && seg.words[seg.words.length - 1];
  return (w && w.end_timestamp && w.end_timestamp.relative) || seg.end || 0;
}

function meetingDate(transcript) {
  return segStartIso(transcript && transcript[0]);
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

// ---------- name-inference prompt (§7 Layer 2) ----------
// transcriptToPrompt keeps the TAIL, which is right for summaries/action items but wrong for
// names: self-introductions ("Hi, I'm Priya") happen in the first two minutes, so on any meeting
// past ~45 min the name prompt used to receive exactly the portion containing no introductions.
// This sibling keeps a name-dense excerpt first, then fills the budget head-first and tail-last.

// Lines that plausibly carry a name: introductions, hand-offs, thanks, greetings.
const NAME_CUE_RE = /\b(i'm|i am|this is|my name is|thanks|thank you|over to you|hi|hey|hello|welcome|meet)\b/i;
const HEAD_SHARE = 0.6; // of the post-excerpt budget; the rest goes to the tail

// Indices worth keeping regardless of position: name cues, plus the first and last two turns of
// every distinct speaker label (so someone who only spoke at minute 70 is still represented).
function nameDenseIndices(transcript) {
  const keep = new Set();
  const bySpeaker = new Map();
  (transcript || []).forEach((s, i) => {
    if (NAME_CUE_RE.test(segText(s))) keep.add(i);
    const k = segSpeaker(s);
    if (!bySpeaker.has(k)) bySpeaker.set(k, []);
    bySpeaker.get(k).push(i);
  });
  for (const idxs of bySpeaker.values()) {
    for (const i of idxs.slice(0, 2)) keep.add(i);
    for (const i of idxs.slice(-2)) keep.add(i);
  }
  return keep;
}

const line = (s) => `${segSpeaker(s)}: ${segText(s)}`;
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// Transcript text for NAME inference, trimmed to fit. Never throws; returns '' for an empty
// transcript. Whole turns only — a half-line with no speaker label is useless here.
function transcriptToNamePrompt(transcript, maxBytes = MAX_PROMPT_BYTES) {
  const segs = transcript || [];
  if (!segs.length) return '';
  const full = transcriptToText(segs);
  if (bytes(full) <= maxBytes) return full;

  const marker = OMITTED_MARKER;
  let budget = maxBytes - bytes(marker);
  const chosen = new Set();

  // 1. Name-dense turns first — these are the whole point of this function.
  for (const i of [...nameDenseIndices(segs)].sort((a, b) => a - b)) {
    const cost = bytes(line(segs[i])) + 1;
    if (cost > budget) break;
    chosen.add(i);
    budget -= cost;
  }

  // 2. Fill the rest head-first, then tail, so intros and closings both survive.
  let headBudget = Math.floor(budget * HEAD_SHARE);
  for (let i = 0; i < segs.length && headBudget > 0; i++) {
    if (chosen.has(i)) continue;
    const cost = bytes(line(segs[i])) + 1;
    if (cost > headBudget) break;
    chosen.add(i);
    headBudget -= cost;
    budget -= cost;
  }
  for (let i = segs.length - 1; i >= 0 && budget > 0; i--) {
    if (chosen.has(i)) continue;
    const cost = bytes(line(segs[i])) + 1;
    if (cost > budget) break;
    chosen.add(i);
    budget -= cost;
  }

  // Emit in transcript order, marking each gap so the model doesn't read across a discontinuity.
  const ordered = [...chosen].sort((a, b) => a - b);
  const out = [];
  let prev = -1;
  for (const i of ordered) {
    if (i !== prev + 1 && out.length) out.push(marker.trimEnd());
    out.push(line(segs[i]));
    prev = i;
  }
  if (ordered.length && ordered[0] !== 0) out.unshift(marker.trimEnd());
  return out.join('\n');
}

function durationSeconds(transcript) {
  if (!transcript || !transcript.length) return 0;
  return segEndRel(transcript[transcript.length - 1]);
}

module.exports = {
  segStartIso, segEndIso, segEndRel,
  segSpeaker, segText, meetingDate, transcriptToText, transcriptToPrompt,
  transcriptToNamePrompt, participants, durationSeconds, MAX_PROMPT_BYTES,
};
