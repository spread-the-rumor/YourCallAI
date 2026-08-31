// Minimal self-check for the pure pipeline logic: node test/selfcheck.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { utterancesToSegments } = require('../src/transcribe');
const { alignSpeakers } = require('../src/align');
const { matchMeeting } = require('../src/detector');
const { parseLooseJson } = require('../src/ai/requesty');
const { segText, segSpeaker, transcriptToText, meetingDate } = require('../src/transcriptUtils');

// --- Deepgram utterance → segment mapping (§4.1/§6): interleave channels, label speakers
const startedAt = '2026-07-09T10:00:00.000Z';
const segs = utterancesToSegments([
  { channel: 1, speaker: 0, start: 5, end: 8, transcript: 'Hi all', words: [{ word: 'Hi', punctuated_word: 'Hi', start: 5, end: 5.5 }, { word: 'all', start: 5.5, end: 6 }] },
  { channel: 0, speaker: 2, start: 1, end: 3, transcript: 'Hello there', words: [{ word: 'Hello', start: 1, end: 2 }, { word: 'there', start: 2, end: 3 }] },
], Date.parse(startedAt), 'Sagar');
assert.strictEqual(segs[0].channel, 0, 'sorted by start: mic utterance first');
assert.strictEqual(segs[0].speaker, 'Sagar', 'channel 0 collapses to USER_DISPLAY_NAME');
assert.strictEqual(segs[0].diarizedSpeaker, 0, 'channel-0 sub-speakers collapsed');
assert.strictEqual(segs[1].speaker, 'Speaker 1', 'channel 1 provisional label');
assert.strictEqual(segs[0].words[0].start_timestamp.absolute, '2026-07-09T10:00:01.000Z');
assert.strictEqual(segs[0].words[0].start_timestamp.relative, 1);
assert.strictEqual(segText(segs[1]), 'Hi all');
assert.strictEqual(meetingDate(segs), '2026-07-09T10:00:01.000Z');
assert.strictEqual(transcriptToText(segs), 'Sagar: Hello there\nSpeaker 1: Hi all');

// --- Layer 1 alignment: ≥60% overlap vote wins, otherwise untouched
const base = Date.parse(startedAt);
const jsonl = path.join(os.tmpdir(), `yc-selfcheck-${process.pid}.jsonl`);
fs.writeFileSync(jsonl, [
  JSON.stringify({ ts: base + 4000, type: 'active-speaker', name: 'Priya Shah' }),
  JSON.stringify({ ts: base + 9000, type: 'active-speaker', name: 'Sam Ortiz' }),
  JSON.stringify({ ts: base, type: 'roster', names: ['Priya Shah', 'Sam Ortiz'] }),
  'not-json-garbage',
].join('\n'));
const { renamed, roster } = alignSpeakers(segs, jsonl);
fs.unlinkSync(jsonl);
assert.strictEqual(renamed['1:0'], 'Priya Shah', 'Speaker 1 (5s–6s) falls inside Priya interval');
assert.strictEqual(segs[1].speaker, 'Priya Shah', 'segment relabeled in place');
assert.ok(roster.includes('Sam Ortiz'), 'roster parsed');

// --- Detection matchers (§8)
assert.strictEqual(matchMeeting([{ app: 'chrome', title: 'Meet – standup' }]).platform, 'google-meet');
assert.strictEqual(matchMeeting([{ app: 'Zoom', title: 'Zoom Meeting' }]).platform, 'zoom');
assert.strictEqual(matchMeeting([{ app: 'ms-teams', title: 'Weekly Sync | Meeting | Microsoft Teams' }]).platform, 'teams');
assert.strictEqual(matchMeeting([{ app: 'firefox', title: 'Meet – standup' }]), null, 'Meet only in Chrome/Edge');
assert.strictEqual(matchMeeting([{ app: 'chrome', title: 'Gmail' }]), null);

// --- .env parser: comments/blank lines skipped, quotes stripped, values trimmed
const { loadEnvFile } = require('../src/settingsStore');
const envFile = path.join(os.tmpdir(), `yc-selfcheck-env-${process.pid}`);
fs.writeFileSync(envFile, '# comment\n\nDEEPGRAM_API_KEY=abc123\nREQUESTY_BASE_URL="https://proxy.example.com/v1"\nUSER_DISPLAY_NAME= Sagar \n');
const env = loadEnvFile(envFile);
fs.unlinkSync(envFile);
assert.deepStrictEqual(env, {
  DEEPGRAM_API_KEY: 'abc123',
  REQUESTY_BASE_URL: 'https://proxy.example.com/v1',
  USER_DISPLAY_NAME: 'Sagar',
});

// --- Defensive JSON parse
assert.deepStrictEqual(parseLooseJson('```json\n[{"title":"Do it"}]\n```', '['), [{ title: 'Do it' }]);
assert.deepStrictEqual(parseLooseJson('Sure! {"Speaker 2":"Priya"} hope that helps', '{'), { 'Speaker 2': 'Priya' });

// ============================================================================
// §7 speaker-name accuracy
// ============================================================================
const { transcriptToNamePrompt, transcriptToPrompt } = require('../src/transcriptUtils');
const { normalizeName, personScore, matchToRoster, mergeRoster, rosterIsTrustworthy } = require('../src/roster');
const { parseInferenceResponse } = require('../src/ai/inferSpeakerNames');
const { resolveSpeakers, readSpeakerMap, sampleMatches } = require('../src/speakerResolve');

// --- Name prompt keeps the START (intros live there). This is THE regression that made
// name inference fail on long meetings: transcriptToPrompt keeps only the tail.
const seg = (speaker, text, channel = 1, dz = 0) => ({
  speaker, channel, diarizedSpeaker: dz, text,
  words: [{ text, start_timestamp: { absolute: startedAt, relative: 0 }, end_timestamp: { absolute: startedAt, relative: 1 } }],
});
const long = [seg('Speaker 1', "Hi everyone, I'm Priya Shah and I'll run this call.")];
for (let i = 0; i < 4000; i++) long.push(seg('Speaker 2', `Filler discussion line number ${i} about the roadmap and delivery.`));
long.push(seg('Speaker 3', 'Thanks all, talk next week.'));
const namePrompt = transcriptToNamePrompt(long);
assert.ok(Buffer.byteLength(namePrompt, 'utf8') <= 48 * 1024, 'name prompt respects the byte cap');
assert.ok(namePrompt.includes("I'm Priya Shah"), 'name prompt KEEPS the opening introduction');
assert.ok(namePrompt.includes('talk next week'), 'name prompt keeps the closing turn too');
assert.ok(!transcriptToPrompt(long).includes("I'm Priya Shah"), 'summary prompt still keeps only the tail (unchanged)');
assert.strictEqual(transcriptToNamePrompt([]), '', 'empty transcript → empty prompt');
assert.strictEqual(transcriptToNamePrompt(segs), transcriptToText(segs), 'short transcript passes through whole');

// --- Name normalization + person scoring
assert.strictEqual(normalizeName('Priya Shah (She/Her), Host'), 'Priya Shah');
assert.strictEqual(normalizeName('  Sam   Ortiz  '), 'Sam Ortiz');
assert.strictEqual(normalizeName('Priya Shah, Muted'), 'Priya Shah');
assert.ok(personScore('Sagar') > 0.6, 'mononyms are accepted (Meet guests often have one name)');
assert.ok(personScore('Priya S. Shah') > 0.6, 'middle initial accepted');
assert.ok(personScore('Jan van Dijk') > 0.6, 'lowercase particle accepted');
assert.strictEqual(personScore('Turn off microphone'), 0, 'UI controls rejected');
assert.strictEqual(personScore('Speaker 2'), 0, 'generic labels rejected');
assert.strictEqual(personScore('Room 4'), 0, 'digits rejected');

// --- REAL Teams accessible labels, captured live from a Microsoft Teams call on 2026-08-27.
// These exact strings all scored 0.00 before the fix: ROLE_WORDS only stripped single role words,
// so the trailing status clauses survived and blew the ≤5-token limit. Do not "simplify" these
// fixtures — they are the ground truth this heuristic exists to parse.
assert.strictEqual(normalizeName('Carlos Brito, Has control of production tools, Context menu is available'), 'Carlos Brito');
assert.strictEqual(normalizeName('SBPM Dev, Has control of production tools, muted, Context menu is available'), 'SBPM Dev');
// Teams prefixes its own tile with a status field, so the name is NOT the first field.
assert.strictEqual(normalizeName('Myself video, Sagar, Has control of production tools, Unmuted, Has context menu'), 'Sagar');
assert.ok(personScore('Carlos Brito, Has control of production tools, Context menu is available') > 0.6,
  'a real Teams roster row must score as a person');
// A descriptive phrase that merely CONTAINS a name is not a participant row.
assert.strictEqual(personScore('Content shared by Hernan Zapata'), 0);
assert.strictEqual(personScore('Settings and more'), 0, 'real Teams button label');
assert.strictEqual(personScore('Turn camera on'), 0, 'real Teams button label');
// Known UI artifacts that score like a short name are denylisted by exact match. "System" is the
// Win32 window menu, which live Teams exposes as a MenuItem SIBLING of the real participant rows.
assert.strictEqual(personScore('System'), 0, 'Win32 window-menu label, seen live beside Teams roster rows');
assert.strictEqual(personScore('Workspaces'), 0, 'Chrome chrome, was reported as an active speaker');
assert.ok(personScore('Nav') > 0.6, 'a genuinely short real name still passes (denylist is exact-match, not length)');
// But a denylist can never be complete: any capitalised UI string scores like a mononym. That is
// why the agent additionally requires an active speaker to be ON THE ROSTER — see
// FindActiveByPhrase in Program.cs. This asserts the gap the roster check exists to close.
assert.ok(personScore('Sprint Board') > 0.6,
  'an arbitrary capitalised UI string is indistinguishable from a name — roster membership is the real defence');

// The COMPLETE MenuItem sibling set captured live from Teams — note "System" (the Win32 window
// menu) sits alongside the real participant rows and must not enter the roster.
const liveTeamsRows = ['System',
  'Myself video, Sagar, Has control of production tools, Muted, Has context menu',
  'Carlos Brito, Has control of production tools, Context menu is available',
  'Hernan Zapata, Has control of production tools, Context menu is available',
  'SBPM Dev, Has control of production tools, muted, Context menu is available',
  'Fireflies.ai Notetaker Hernan, video is on, Has control of production tools, muted, Context menu is available'];
const liveRoster = mergeRoster([{ names: liveTeamsRows, source: 'participants-panel', confidence: 0.9 }]);
assert.deepStrictEqual(liveRoster.map((r) => r.name).sort(),
  ['Carlos Brito', 'Fireflies.ai Notetaker Hernan', 'Hernan Zapata', 'SBPM Dev', 'Sagar'],
  'the real Teams roster resolves to exactly its 5 participants, with "System" excluded');

// --- The in-call gate (mirrored in Program.cs LooksInCall / main.swift looksInCall). Kept here as
// executable documentation of the real label sets it must separate; the agents own the C#/Swift
// copies. Without this gate the agent scraped whatever window it saw — see the comments there.
const LEAVE_RE = /^(leave|leave call|leave meeting|hang up|end call|end meeting|disconnect)\b/i;
const CALL_RE = /\b(mute|unmute) (mic|microphone)\b|\bturn (camera|video) (on|off)\b|\bshare (content|screen)\b|\bmicrophone\b|\bcamera\b|\braise your hand\b|\bparticipants?\b|\bpeople\b/i;
const looksInCall = (labels) => {
  let leave = false; let controls = 0;
  for (const raw of labels) {
    const s = (raw || '').trim();
    if (!s.length || s.length > 40) continue;
    if (LEAVE_RE.test(s)) leave = true;
    else if (CALL_RE.test(s)) controls++;
  }
  return leave && controls >= 1;
};
// Real Teams in-call control labels, captured live.
assert.strictEqual(looksInCall(['Settings and more', 'Calling indicators', 'Meeting controls',
  'Encryption status', 'Elapsed time 13:10', 'Pop out', 'Chat', 'People', 'Raise your hand',
  'React', 'View', 'More', 'Turn camera on', 'Mute mic', 'Share content', 'Leave']), true,
'a real in-call Teams window passes the gate');
// Real Slack formatting toolbar — this exact set was emitted as a 10-person roster.
assert.strictEqual(looksInCall(['Bold', 'Italic', 'Underline', 'Strikethrough', 'Link',
  'Ordered list', 'Bulleted list', 'Blockquote', 'Code', 'Code block']), false,
'Slack\'s message toolbar must NOT look like a call');
// Real Chrome browser chrome — this was emitted as the roster during a live Google Meet.
assert.strictEqual(looksInCall(['Back', 'Forward', 'Reload', 'History Navigation', 'Work']), false,
  'Chrome\'s toolbar must NOT look like a call');

// --- rosterIsTrustworthy: a junk roster must not become a closed set.
// This is the EXACT roster the agent produced during a real Google Meet on 2026-08-27 — Chrome's
// toolbar plus another tab's sidebar. Because the real participant ("Vicky Rana") was absent from
// it, the closed-set guard rejected her correctly-inferred name and she stayed "Speaker 1" for the
// whole 19-minute meeting. A bad roster causing a GUARANTEED MISS is worse than no roster.
const pollutedMeetRoster = ['AI Brand Assistant', 'AI Insights', 'AI Topic Analysis', 'Analysis',
  'Backgrounds and effects', 'Comparison', 'Demographics', 'Email reports', 'Excel report',
  'History Navigation', 'Influencers & Sources', 'InfographicNEW', 'Mentions', 'PDF Creator',
  'REPORTS', 'Rumor Avenue', 'Sagar Bansal', 'Show in a tile', 'Back', 'Forward', 'Reload', 'Work'];
assert.strictEqual(rosterIsTrustworthy(pollutedMeetRoster), false, 'the real Meet pollution is rejected');
assert.strictEqual(rosterIsTrustworthy(['Sagar Bansal', 'Vicky Rana']), true, 'the real Meet roster is trusted');
assert.strictEqual(rosterIsTrustworthy(['Carlos Brito', 'Hernan Zapata', 'SBPM Dev', 'Sagar',
  'Fireflies.ai Notetaker Hernan']), true, 'the real Teams roster is trusted');
assert.strictEqual(rosterIsTrustworthy(Array.from({ length: 12 }, (_, i) => `First${i} Last${i}`)), true,
  'a genuine 12-person call is still trusted');
assert.strictEqual(rosterIsTrustworthy(['Back', 'Forward', 'Reload']), false, 'a browser toolbar is rejected');
assert.strictEqual(rosterIsTrustworthy([]), false);
// The consequence: with a polluted roster the real name is accepted (unconstrained, low confidence)…
assert.strictEqual(parseInferenceResponse('{"Speaker 1":"Vicky Rana"}', ['Speaker 1'], pollutedMeetRoster, 'Sagar Bansal')['Speaker 1'].name,
  'Vicky Rana', 'a junk roster must NOT be able to exclude a real participant');
// …while a trustworthy roster still rejects a name nobody in the meeting has.
assert.deepStrictEqual(parseInferenceResponse('{"Speaker 1":"Work"}', ['Speaker 1'], ['Sagar Bansal', 'Vicky Rana'], 'Sagar Bansal'), {},
  'a trustworthy roster still enforces the closed set');

// --- Roster matching tiers
const ros = ['Priya Shah', 'Sam Ortiz'];
assert.strictEqual(matchToRoster('priya shah', ros).name, 'Priya Shah', 'case-insensitive exact');
assert.strictEqual(matchToRoster('Priya', ros).name, 'Priya Shah', 'unique first name');
assert.strictEqual(matchToRoster('P. Shah', ros).name, 'Priya Shah', 'last name + first initial');
assert.strictEqual(matchToRoster('Dave', ros), null, 'unknown name rejected');
assert.strictEqual(matchToRoster('Priya', ['Priya Shah', 'Priya Nair']), null, 'ambiguous → null, never a coin flip');

// --- mergeRoster: dictionaries canonicalize but never introduce
const merged = mergeRoster([
  { names: ['priya shah'], source: 'tile-grid', confidence: 0.75 },
  { names: ['Priya Shah'], source: 'participants-panel', confidence: 0.9 },
  { names: ['Turn off camera', 'Speaker 2'], source: 'participants-panel', confidence: 0.9 },
  { names: ['Someone Else', 'Priya Shah'], source: 'slack-directory', confidence: 0.5, dictionary: true },
]);
assert.deepStrictEqual(merged.map((r) => r.name), ['Priya Shah'], 'deduped, UI strings dropped, dictionary added nobody');
assert.strictEqual(merged[0].source, 'participants-panel', 'highest-confidence source wins');
assert.ok(!mergeRoster([{ names: ['Colleague X'], source: 'slack', confidence: 0.9, dictionary: true }]).length,
  'a dictionary-only source yields an EMPTY roster (the whole Slack workspace must never become attendees)');

// --- Inference response parsing: closed set + anti-hallucination guards
const gen = ['Speaker 1', 'Speaker 2'];
const objShape = parseInferenceResponse('{"Speaker 1":{"name":"Priya Shah","confidence":0.9,"evidence":"\\"I am Priya\\""}}', gen, ros);
assert.strictEqual(objShape['Speaker 1'].name, 'Priya Shah', 'object shape parsed');
assert.strictEqual(objShape['Speaker 1'].confidence, 0.9, 'confidence carried through');
assert.ok(objShape['Speaker 1'].evidence.includes('Priya'), 'evidence carried through');
assert.strictEqual(parseInferenceResponse('{"Speaker 1":"Priya Shah"}', gen, ros)['Speaker 1'].name,
  'Priya Shah', 'legacy flat-string shape still accepted');
assert.deepStrictEqual(parseInferenceResponse('{"Speaker 1":"Dave Hallucination"}', gen, ros), {},
  'name outside the roster is REJECTED');
assert.deepStrictEqual(parseInferenceResponse('{"Speaker 1":null,"Speaker 2":"unknown"}', gen, ros), {},
  'null / "unknown" ignored');
assert.deepStrictEqual(parseInferenceResponse('{"Speaker 9":"Priya Shah"}', gen, ros), {},
  'label we did not ask about is ignored');
assert.deepStrictEqual(parseInferenceResponse('{"Speaker 1":"Sagar"}', gen, ['Sagar'], 'Sagar'), {},
  'the ch0 user cannot also be a ch1 speaker');
const dup = parseInferenceResponse(
  '{"Speaker 1":{"name":"Priya Shah","confidence":0.9},"Speaker 2":{"name":"Priya Shah","confidence":0.5}}', gen, ros);
assert.deepStrictEqual(Object.keys(dup), ['Speaker 1'], 'one person cannot be two speakers; most confident wins');
assert.deepStrictEqual(parseInferenceResponse('not json at all', gen, ros), {}, 'garbage → {}, never throws');
assert.strictEqual(parseInferenceResponse('{"Speaker 1":"Dave"}', gen, [])['Speaker 1'].name, 'Dave',
  'with no roster, fall back to open-ended (today\'s behaviour)');

// --- speakerMap back-compat: bare strings were the old on-disk shape
assert.deepStrictEqual(readSpeakerMap({ '1:3': 'Priya' })['1:3'],
  { name: 'Priya', source: 'manual', confidence: 1, lockedByUser: true, sampleText: '' },
  'legacy string entry reads as a manual lock');

// --- resolveSpeakers
const mk = (n) => [
  { speaker: 'You', channel: 0, diarizedSpeaker: 0, text: 'my bit', words: [] },
  { speaker: 'Speaker 1', channel: 1, diarizedSpeaker: 0, text: n, words: [] },
];
const r1 = resolveSpeakers({ transcript: mk('hello team let us begin the review'), userName: 'Sagar' });
assert.strictEqual(r1.transcript[0].speaker, 'Sagar', 'ch0 always gets the signed-in user');
assert.deepStrictEqual(r1.unresolved, ['Speaker 1'], 'unnamed ch1 speaker reported as unresolved');

// The Retry-transcription regression: a manual rename must survive a rebuilt transcript.
const priorMap = { '1:0': { name: 'Priya Shah', source: 'manual', confidence: 1, lockedByUser: true, sampleText: 'hello team let us begin the review' } };
const r2 = resolveSpeakers({ transcript: mk('hello team let us begin the review'), priorSpeakerMap: priorMap, userName: 'Sagar' });
assert.strictEqual(r2.transcript[1].speaker, 'Priya Shah', 'manual rename SURVIVES re-transcription');
assert.strictEqual(r2.speakerMap['1:0'].lockedByUser, true, 'and stays locked');

// A manual rename must NOT be canonicalised against the roster: "Samuel Ortiz" matches roster
// "Sam Ortiz" on the last-name+initial tier, and reverting it would undo the user's correction.
const r2b = resolveSpeakers({
  transcript: mk('hello team let us begin the review'),
  priorSpeakerMap: { '1:0': { name: 'Samuel Ortiz', source: 'manual', confidence: 1, lockedByUser: true, sampleText: 'hello team let us begin the review' } },
  roster: ['Priya Shah', 'Sam Ortiz'], userName: 'Sagar',
});
assert.strictEqual(r2b.transcript[1].speaker, 'Samuel Ortiz',
  'a manual rename outranks the roster spelling — the user may be fixing what the meeting UI got wrong');

// ...but a stale mapping (diarized ids are not stable) is demoted, not silently applied.
const r3 = resolveSpeakers({ transcript: mk('completely different words spoken by somebody else'), priorSpeakerMap: priorMap, userName: 'Sagar' });
assert.strictEqual(r3.speakerMap['1:0'].source, 'prior-manual-stale', 'stale lock demoted');
assert.ok(r3.speakerMap['1:0'].confidence < 0.85, 'demoted entry renders as unverified');
assert.strictEqual(r3.speakerMap['1:0'].lockedByUser, false, 'and is no longer a lock');

// Agent alignment beats AI inference for the same speaker.
const r4 = resolveSpeakers({
  transcript: mk('hi there'),
  alignment: { '1:0': { name: 'Sam Ortiz', confidence: 0.92 } },
  inferred: { 'Speaker 1': { name: 'Priya Shah', confidence: 0.8 } },
  roster: ros, userName: 'Sagar',
});
assert.strictEqual(r4.transcript[1].speaker, 'Sam Ortiz', 'native agent outranks AI inference');
assert.strictEqual(r4.speakerMap['1:0'].source, 'native-agent');

// AI inference fills in where the agent was silent.
const r5 = resolveSpeakers({
  transcript: mk('hi there'), inferred: { 'Speaker 1': { name: 'Priya Shah', confidence: 0.8 } },
  roster: ros, userName: 'Sagar',
});
assert.strictEqual(r5.transcript[1].speaker, 'Priya Shah', 'AI inference applied when nothing better exists');
assert.deepStrictEqual(r5.unresolved, [], 'nothing left unresolved');

assert.strictEqual(sampleMatches('the quarterly roadmap review', 'the quarterly roadmap review'), true);
assert.strictEqual(sampleMatches('the quarterly roadmap review', 'unrelated chatter about lunch plans'), false);
assert.strictEqual(sampleMatches('', 'anything'), null, 'unknown is distinct from mismatch');

// --- align.js: diagnostics + confidence-weighted votes, with the ≥60% rule intact
const jsonl2 = path.join(os.tmpdir(), `yc-selfcheck2-${process.pid}.jsonl`);
fs.writeFileSync(jsonl2, [
  JSON.stringify({ ts: Date.now(), type: 'agent-status', state: 'started', heuristics: 'test1' }),
  JSON.stringify({ ts: base + 4000, type: 'active-speaker', name: 'Priya Shah', confidence: 0.9, strategy: 'suffix-delta' }),
  JSON.stringify({ ts: base, type: 'roster', names: ['Priya Shah', 'Sam Ortiz'], source: 'participants-panel', confidence: 0.9 }),
  JSON.stringify({ ts: base, type: 'future-event-type-we-do-not-know' }),
  '{"truncated":',
].join('\n'));
const segs2 = utterancesToSegments([
  { channel: 1, speaker: 0, start: 5, end: 8, transcript: 'Hi all', words: [{ word: 'Hi', start: 5, end: 6 }] },
], base, 'Sagar');
const a2 = alignSpeakers(segs2, jsonl2);
fs.unlinkSync(jsonl2);
assert.strictEqual(a2.renamed['1:0'], 'Priya Shah', 'weighted vote still resolves');
assert.strictEqual(a2.diagnostics.agentStatus, 'started', 'agent lifecycle recorded');
assert.strictEqual(a2.diagnostics.heuristics, 'test1');
assert.strictEqual(a2.diagnostics.malformedLines, 1, 'truncated line counted, not fatal');
assert.strictEqual(a2.rosterSources[0].source, 'participants-panel', 'roster source preserved for ranking');
assert.ok(a2.votes['1:0'].confidence > 0.6, 'winning share expressed as a confidence');

console.log('selfcheck: all assertions passed');
