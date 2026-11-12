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

// --- Layer 1 alignment. ONE event must never name a voice: measured on the real library, 30 of
// 37 agent active-speaker events were a single first-poll artifact, and that one event used to
// win a 100% share and put (usually) the user's own name on a remote voice.
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
assert.ok(!renamed['1:0'], 'a single event cannot name a voice — the first-poll artifact');
assert.strictEqual(segs[1].speaker, 'Speaker 1', 'alignment NEVER relabels segments in place');
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
// parseInferenceResponse takes a candidates object; build it the way inferSpeakerNames does, with
// the roster closing the set only when it is trustworthy.
const { nameKey: nk } = require('../src/roster');
const pir = (raw, labels, rosterList, userName, transcriptText = '', history = [], stats = {}) => {
  const trusted = require('../src/roster').rosterIsTrustworthy(rosterList);
  return parseInferenceResponse(raw, labels, {
    pool: [...rosterList, ...history], closed: trusted && rosterList.length > 0,
    inMeeting: new Set(rosterList.map(nk)),
  }, { userName, transcriptText, stats });
};
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
// The Fireflies recording bot is a participant row but never a speaker anyone wants named, so it
// is excluded too (it used to be a roster candidate, i.e. a name the AI could hand to a voice).
assert.deepStrictEqual(liveRoster.map((r) => r.name).sort(),
  ['Carlos Brito', 'Hernan Zapata', 'SBPM Dev', 'Sagar'],
  'the real Teams roster resolves to its 4 human participants, with "System" and the notetaker bot excluded');

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
assert.strictEqual(pir('{"Speaker 1":{"name":"Vicky Rana","basis":"addressed","quote":"thanks Vicky, over to you"}}', ['Speaker 1'], pollutedMeetRoster, 'Sagar Bansal', 'thanks Vicky, over to you')['Speaker 1'].name,
  'Vicky Rana', 'a junk roster must NOT be able to exclude a real participant');
// …while a trustworthy roster still rejects a name nobody in the meeting has.
assert.deepStrictEqual(pir('{"Speaker 1":"Work"}', ['Speaker 1'], ['Sagar Bansal', 'Vicky Rana'], 'Sagar Bansal'), {},
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
const said = 'Hi everyone, I am Priya and I run the data team';
const objShape = pir('{"Speaker 1":{"name":"Priya Shah","confidence":0.9,"basis":"introduction","quote":"I am Priya"}}', gen, ros, '', said);
assert.strictEqual(objShape['Speaker 1'].name, 'Priya Shah', 'object shape parsed');
assert.strictEqual(objShape['Speaker 1'].confidence, 0.9, 'confidence carried through for verified direct evidence');
assert.ok(objShape['Speaker 1'].evidence.includes('Priya'), 'evidence carried through');
assert.strictEqual(pir('{"Speaker 1":"Priya Shah"}', gen, ros)['Speaker 1'].name,
  'Priya Shah', 'legacy flat-string shape still accepted');
assert.deepStrictEqual(pir('{"Speaker 1":"Dave Hallucination"}', gen, ros), {},
  'name outside the roster is REJECTED');
assert.deepStrictEqual(pir('{"Speaker 1":null,"Speaker 2":"unknown"}', gen, ros), {},
  'null / "unknown" ignored');
assert.deepStrictEqual(pir('{"Speaker 9":"Priya Shah"}', gen, ros), {},
  'label we did not ask about is ignored');
assert.deepStrictEqual(pir('{"Speaker 1":"Sagar"}', gen, ['Sagar', 'Priya Shah'], 'Sagar'), {},
  'the ch0 user cannot also be a ch1 speaker');
assert.deepStrictEqual(pir('{"Speaker 1":"Sagar"}', gen, ['Sagar', 'Priya Shah'], 'Sagar Bansal'), {},
  'nor under a mononym of their account name');
const dup = pir(
  '{"Speaker 1":{"name":"Priya Shah","confidence":0.9},"Speaker 2":{"name":"Priya Shah","confidence":0.5}}', gen, ros);
assert.deepStrictEqual(Object.keys(dup), ['Speaker 1'], 'one person cannot be two speakers; most confident wins');
assert.deepStrictEqual(pir('not json at all', gen, ros), {}, 'garbage → {}, never throws');
assert.strictEqual(pir('{"Speaker 1":{"name":"Dave","basis":"addressed","quote":"okay Dave, go ahead"}}', gen, [], '', 'okay Dave, go ahead')['Speaker 1'].name, 'Dave',
  'with no roster, a name the transcript itself uses is accepted with quoted direct evidence');
assert.deepStrictEqual(pir('{"Speaker 1":{"name":"Darn","basis":"topic"}}', gen, [], '', 'oh darn, the build broke'), {},
  'with no roster, a guess without quoted direct evidence is rejected (real ASR noise: "Darn", "Nava")');
assert.strictEqual(require('../src/roster').matchToRoster('Nav', ['Navroop Singh', 'Hernan Zapata']).name, 'Navroop Singh',
  'a short form of a first name matches ("Nav" for Navroop)');
assert.deepStrictEqual(pir('{"Speaker 1":"Dave"}', gen, [], '', 'nobody says that name here'), {},
  'but never a name the transcript does not contain');

// Claimed direct evidence must be QUOTED from the transcript, or it is capped as unverified.
const fakeQuote = pir('{"Speaker 1":{"name":"Priya Shah","confidence":0.95,"basis":"introduction","quote":"Hello I am Priya Shah from finance"}}', gen, ros, '', said);
assert.ok(fakeQuote['Speaker 1'].confidence <= 0.6 && /unverified/.test(fakeQuote['Speaker 1'].basis),
  'an invented quote cannot buy a verified name');
// Host reasoning is allowed but can never read as settled (< 0.85 → dotted "?").
const host = pir('{"Speaker 1":{"name":"Priya Shah","confidence":0.99,"basis":"host","quote":"run the data team"}}', gen, ros, '', said);
assert.ok(host['Speaker 1'].confidence < 0.85, 'host inference renders as a suggestion');
// Speech-to-text spellings resolve to the roster spelling: "Ramiro" for Ramir.
assert.strictEqual(pir('{"Speaker 1":"Ramiro"}', gen, ['Ramir Mesquita', 'Hernan Zapata'])['Speaker 1'].name, 'Ramir Mesquita',
  'an ASR misspelling still matches the participant');
// A small diarization fragment of an already-named voice may keep the name, demoted.
const frag = pir('{"Speaker 1":{"name":"Priya Shah","confidence":0.8},"Speaker 2":{"name":"Priya Shah","confidence":0.7}}',
  gen, ros, '', '', [], { 'Speaker 1': { words: 2000 }, 'Speaker 2': { words: 40 } });
assert.strictEqual(frag['Speaker 2'].name, 'Priya Shah', 'a 40-word fragment of the same voice keeps the name');
assert.ok(frag['Speaker 2'].confidence <= 0.6, '…as a suggestion');
// History: a recurring attendee is a valid candidate even when the meeting app's list omits them
// (live Teams rosters routinely missed Felipe), but only as a suggestion.
const hist = pir('{"Speaker 1":{"name":"Felipe Frias","confidence":0.9,"basis":"topic"}}', gen, ['Carlos Brito', 'Hernan Zapata'], '', '', ['Felipe Frias']);
assert.strictEqual(hist['Speaker 1'].name, 'Felipe Frias', 'a history candidate is accepted with a trusted roster');
assert.ok(hist['Speaker 1'].confidence < 0.85, 'not on this meeting\'s own list → suggestion');

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
assert.ok(!a2.renamed['1:0'], 'one event — even a high-confidence one — is not enough');
assert.strictEqual(a2.diagnostics.agentStatus, 'started', 'agent lifecycle recorded');
assert.strictEqual(a2.diagnostics.heuristics, 'test1');
assert.strictEqual(a2.diagnostics.malformedLines, 1, 'truncated line counted, not fatal');
assert.strictEqual(a2.rosterSources[0].source, 'participants-panel', 'roster source preserved for ranking');

// --- audioHealth.js: "dead capture" must be distinguishable from "quiet meeting" (the
// earphones bug). The whole fix rests on the gap between a live noise floor and digital zero.
const { computeRms, createHealth, describeMediaError, looksBluetooth,
  DEAD_RMS, SILENCE_RMS, ALIVE_RMS, TOTAL_DEATH_MS } = require('../src/recorder/audioHealth');

assert.strictEqual(computeRms(new Float32Array(2048)), 0, 'memset-zero buffer → exactly 0');
const quietBuf = Float32Array.from({ length: 2048 }, (_, i) => 3e-4 * Math.sin(i));
const quietRms = computeRms(quietBuf);
assert.ok(quietRms > DEAD_RMS && quietRms < SILENCE_RMS,
  'a live-but-quiet noise floor sits above DEAD_RMS and below SILENCE_RMS — the premise');

// Dead system loopback while the mic is live-but-quiet → flag system only, not the mic.
const hDead = createHealth({ startedAt: 0 });
let evDead = null;
for (let t = 0; t <= 8000; t += 1000) evDead = hDead.tick(t, 4e-4, 0) || evDead;
assert.ok(evDead && evDead.type === 'warmup' && evDead.sysDead && !evDead.micDead,
  'zero system + live mic → sysDead only');

// THE false-positive guard: a genuinely silent meeting with both paths live must never be
// reported as broken. The warmup event still fires (it is the baseline log line), but with
// nothing marked dead — that distinction is what drives the popup.
const hQuiet = createHealth({ startedAt: 0 });
let evQuiet = null;
for (let t = 0; t <= 8000; t += 1000) evQuiet = hQuiet.tick(t, 4e-4, 2e-4) || evQuiet;
assert.ok(evQuiet && evQuiet.type === 'warmup', 'healthy run still logs a baseline');
assert.ok(!evQuiet.micDead && !evQuiet.sysDead,
  'quiet meeting must NOT be reported as broken capture');

// Startup zeros inside the grace window are normal ramp-up, not evidence of a dead device.
const hGrace = createHealth({ startedAt: 0 });
let evGrace = null;
hGrace.tick(500, 0, 0);
hGrace.tick(1000, 0, 0);
for (let t = 2000; t <= 8000; t += 1000) evGrace = hGrace.tick(t, 4e-4, 4e-4) || evGrace;
assert.ok(evGrace && !evGrace.micDead && !evGrace.sysDead,
  'zeros within the grace window do not trip the check');

// An absent stream (null RMS = no track at all) is its own failure, not silence.
const hAbsent = createHealth({ startedAt: 0 });
let evAbsent = null;
for (let t = 0; t <= 8000; t += 1000) evAbsent = hAbsent.tick(t, 4e-4, null) || evAbsent;
assert.ok(evAbsent && evAbsent.sysDead, 'missing system track reported as dead');

// rearm() re-runs the verdict over a fresh window (used on default-device change).
const hRearm = createHealth({ startedAt: 0 });
for (let t = 0; t <= 8000; t += 1000) hRearm.tick(t, 4e-4, 4e-4);
hRearm.rearm(10000);
let evRearm = null;
for (let t = 10000; t <= 18000; t += 1000) evRearm = hRearm.tick(t, 4e-4, 0) || evRearm;
assert.ok(evRearm && evRearm.sysDead, 'rearm re-detects a loopback that died after a swap');

// The existing 30s silence UX must survive the rewrite.
const hSil = createHealth({ startedAt: 0 });
let evSil = null;
for (let t = 0; t <= 31000; t += 1000) { const e = hSil.tick(t, 4e-4, 4e-4); if (e && e.type === 'silence') evSil = e; }
assert.ok(evSil, 'silence latch still fires after 30s below SILENCE_RMS');

// system-dead detector. These cases come from a real captured failure + probe run — the
// isolated-zero and quiet-meeting traps below both occurred on live hardware.
const deadArgs = { startedAt: 0, warmupMs: 1000, graceMs: 0 };

// Sustained zero system + live mic → dead endpoint, recovery should fire.
const hSys = createHealth(deadArgs);
let evSys = null;
for (let t = 0; t <= 20000; t += 1000) { const e = hSys.tick(t, 4e-4, 0); if (e && e.type === 'system-dead') evSys = e; }
assert.ok(evSys, 'sustained zero system audio while the mic is live → system-dead');

// TRAP 1 (measured): a healthy loopback emits an isolated ~6e-6 sample and recovers next tick.
// One dead reading must never trigger a re-acquire.
const hBlip = createHealth(deadArgs);
let evBlip = null;
for (let t = 0; t <= 20000; t += 1000) {
  const sys = (t === 8000) ? 0.000006 : 0.05; // one blip in an otherwise healthy stream
  const e = hBlip.tick(t, 4e-4, sys);
  if (e && e.type === 'system-dead') evBlip = e;
}
assert.strictEqual(evBlip, null, 'an isolated zero sample must NOT be treated as a dead endpoint');

// TRAP 2 (measured): with nothing playing, a HEALTHY endpoint also reads zero. Without the mic
// gate this would re-acquire in a loop through every quiet stretch of a meeting.
const hQuietRoom = createHealth(deadArgs);
let evQuietRoom = null;
for (let t = 0; t <= 20000; t += 1000) { const e = hQuietRoom.tick(t, 0, 0); if (e && e.type === 'system-dead') evQuietRoom = e; }
assert.strictEqual(evQuietRoom, null, 'silent room (mic also silent) must NOT trigger recovery');

// Fires once, then re-arms only after real audio returns.
const hOnce = createHealth(deadArgs);
let deaths = 0;
for (let t = 0; t <= 40000; t += 1000) { const e = hOnce.tick(t, 4e-4, 0); if (e && e.type === 'system-dead') deaths++; }
assert.strictEqual(deaths, 1, 'system-dead fires once, not every tick');

// --- The 2026-09-17 regression: BOTH channels dead, which system-dead can never see ---------
// Real capture (rec_1789659499976_0sap): a wired-headset/external-display device swap killed
// the loopback AND ended the mic track at t=154s. micRms went to exactly 0, sysRms to 1e-5,
// and the app recorded 45 more minutes of nothing, emitting no event of any kind, then saved
// status:'complete'. system-dead is mic-gated by design, so it was structurally blind here.
const totalArgs = { startedAt: 0, warmupMs: 1000, graceMs: 0, deathMs: 12000, totalDeathMs: 45000 };

const hAll = createHealth(totalArgs);
let evAll = null;
for (let t = 0; t <= 60000; t += 1000) { const e = hAll.tick(t, 0, 1e-5); if (e && e.type === 'all-dead') evAll = e; }
assert.ok(evAll, 'both channels at digital zero → all-dead (the case system-dead cannot reach)');

// The exact shape that produced silence before: system-dead must STILL not fire here (no mic
// signal to gate it), proving all-dead is the only thing standing between this and 45 lost min.
const hAllSys = createHealth(totalArgs);
let sawSysDead = false;
for (let t = 0; t <= 60000; t += 1000) { const e = hAllSys.tick(t, 0, 0); if (e && e.type === 'system-dead') sawSysDead = true; }
assert.strictEqual(sawSysDead, false, 'system-dead stays mic-gated — all-dead is what covers this');

// A briefly-silent room must NOT be called dead. Everyone muted with nothing playing is real
// and common; it is why TOTAL_DEATH_MS (45s) is far longer than SYSTEM_DEATH_MS (12s).
const hPause = createHealth(totalArgs);
let evPause = null;
for (let t = 0; t <= 30000; t += 1000) { const e = hPause.tick(t, 0, 0); if (e && e.type === 'all-dead') evPause = e; }
assert.strictEqual(evPause, null, '30s of quiet is a pause, not a dead capture');

// Recovery of either channel clears the latch.
const hRevive = createHealth(totalArgs);
let evRevive = null;
for (let t = 0; t <= 30000; t += 1000) hRevive.tick(t, 0, 0);
for (let t = 31000; t <= 90000; t += 1000) { const e = hRevive.tick(t, 4e-4, 0); if (e && e.type === 'all-dead') evRevive = e; }
assert.strictEqual(evRevive, null, 'audio returning on either channel re-arms the all-dead latch');

// Fires once, not every tick (same contract as system-dead).
const hAllOnce = createHealth(totalArgs);
let allDeaths = 0;
for (let t = 0; t <= 120000; t += 1000) { const e = hAllOnce.tick(t, 0, 0); if (e && e.type === 'all-dead') allDeaths++; }
assert.strictEqual(allDeaths, 1, 'all-dead fires once, not every tick');

// rearm() must clear the death latches, or a swap would inherit the old stream's verdict.
const hRearmDeath = createHealth(totalArgs);
for (let t = 0; t <= 60000; t += 1000) hRearmDeath.tick(t, 0, 0); // latch all-dead
hRearmDeath.rearm(60000);
let evAfterRearm = null;
for (let t = 61000; t <= 130000; t += 1000) { const e = hRearmDeath.tick(t, 0, 0); if (e && e.type === 'all-dead') evAfterRearm = e; }
assert.ok(evAfterRearm, 'rearm() clears the all-dead latch so a dead REPLACEMENT is still caught');

// --- The probe threshold: 69% of "alive" verdicts were coin flips --------------------------
// Every maxRms below is a REAL value from capture.jsonl across the 7 captured meetings. The old
// gate was DEAD_RMS (1e-5) and it ran straight through the middle of a single cluster: the
// "dead" readings (8.9e-6..9.8e-6) and the "alive" ones (1.0e-5..2.0e-5) are the same
// distribution. Do not "tidy" these numbers — they are the evidence the threshold was wrong.
const PROBED_DEAD = [0.000008972737472267878, 0.00000929761040688235, 0.000009412265628106857,
  0.000009613464901080184, 0.000009793173556828217];
const PROBED_CALLED_ALIVE = [0.00001018257123319357, 0.000010738029319514931,
  0.000011191974469023798, 0.00001463081862954751, 0.000017898130912077267];
const PROBED_REAL_AUDIO = [0.018618555930159375, 0.03299436015520964, 0.03645773664479114,
  0.0997792014183612];

for (const v of PROBED_DEAD) {
  assert.ok(v < ALIVE_RMS, `${v} (probed dead) is below ALIVE_RMS`);
}
// The heart of the fix: these were all accepted as live replacements and swapped into the
// graph. Under ALIVE_RMS every one is correctly rejected, so a working source is never
// disconnected in favour of a reading that is indistinguishable from silence.
for (const v of PROBED_CALLED_ALIVE) {
  assert.ok(v > DEAD_RMS, `${v} passed the OLD gate — that is why this fixture exists`);
  assert.ok(v < ALIVE_RMS, `${v} must NOT be accepted as proof of life under ALIVE_RMS`);
}
for (const v of PROBED_REAL_AUDIO) {
  assert.ok(v >= ALIVE_RMS, `${v} is real audio and must still be accepted`);
}
// The separation that makes the new gate meaningful: real audio is ~1000x the ambiguous band.
assert.ok(Math.min(...PROBED_REAL_AUDIO) / Math.max(...PROBED_CALLED_ALIVE) > 100,
  'real audio and the ambiguous band differ by orders of magnitude — ALIVE_RMS sits in the gap');
assert.ok(ALIVE_RMS > DEAD_RMS, 'the accept bar is strictly above the dead floor');

// --- audioEndpoints: choosing where to move the Windows default ----------------------------
// Context: Chromium loopback can ONLY capture the Windows DEFAULT output (Electron exposes no
// named-device option). Measured live 2026-09-22, the default was the external monitor while the
// meeting played out of the laptop speakers, so six recovery attempts all re-bound to silence and
// the far end was never recorded. Switching the default is the only lever, so picking the RIGHT
// target is the whole feature.
const { chooseLiveEndpoint, LIVE_PEAK } = require('../src/audioEndpoints');

// The real 2026-09-22 shape: Windows default is the monitor, the sound is on the speakers.
const REAL_CASE = [
  { id: 'monitor', name: 'E24-30 (HD Audio Driver for Display Audio)', isDefault: true, peak: 0 },
  { id: 'speakers', name: 'Speakers (Realtek(R) Audio)', isDefault: false, peak: 0.557926 },
];
assert.strictEqual(chooseLiveEndpoint(REAL_CASE).id, 'speakers',
  'picks the endpoint that actually carries audio, not the Windows default');

// Never pick the current default: if it were live we would already be recording it, so selecting
// it would "switch" to the same silent device and the escalation would have achieved nothing.
assert.strictEqual(chooseLiveEndpoint([
  { id: 'a', name: 'A', isDefault: true, peak: 0.9 },
  { id: 'b', name: 'B', isDefault: false, peak: 0 },
]), null, 'never selects the current default, even when it is the loud one');

// Genuinely silent machine: nothing to switch to. Must be null, NOT a coin-flip pick — this is
// what stops the app from reassigning the user's audio device during a quiet meeting.
assert.strictEqual(chooseLiveEndpoint([
  { id: 'a', name: 'A', isDefault: true, peak: 0 },
  { id: 'b', name: 'B', isDefault: false, peak: 0 },
  { id: 'c', name: 'C', isDefault: false, peak: 0.0001 }, // noise floor, below LIVE_PEAK
]), null, 'silence everywhere selects nothing rather than guessing');

// Loudest wins when several are live.
assert.strictEqual(chooseLiveEndpoint([
  { id: 'a', name: 'A', isDefault: true, peak: 0 },
  { id: 'b', name: 'B', isDefault: false, peak: 0.05 },
  { id: 'c', name: 'C', isDefault: false, peak: 0.40 },
]).id, 'c', 'picks the loudest live endpoint');

// A single endpoint cannot be a switch target — there is nowhere else to go.
assert.strictEqual(chooseLiveEndpoint([
  { id: 'only', name: 'Speakers', isDefault: true, peak: 0.5 },
]), null, 'one endpoint means nothing to switch to');

// Degradation: a missing/old binary yields null from listEndpoints, and that must not throw.
assert.strictEqual(chooseLiveEndpoint(null), null, 'null endpoint list degrades quietly');
assert.strictEqual(chooseLiveEndpoint([]), null, 'empty endpoint list degrades quietly');
// Malformed rows must not crash the picker (a driver can report a device with no peak).
assert.strictEqual(chooseLiveEndpoint([
  { id: 'a', isDefault: true, peak: 0 },
  { id: 'b', isDefault: false },
  null,
]), null, 'rows without a usable peak are ignored, not crashed on');

// The threshold sits between digital silence and audible playback — both measured on real
// hardware via `YourCallAgent.exe --audio list` (silence 0.000000, speech 0.557926).
assert.ok(LIVE_PEAK > 0 && LIVE_PEAK < 0.5,
  'LIVE_PEAK sits between measured silence (0.0) and measured speech (0.56)');

// --- Recovery escalation must be BOUNDED and the endpoint switch must be ONE-SHOT -----------
// Mirrors the state machine in recorder.js recoverSystemAudio (softFailures / endpointSwitchTried
// / the two cooldowns). Every recovery attempt costs a real 4s probe, so an unbounded loop does
// not just waste CPU during a meeting — it competes with the capture it is trying to repair.
function simulateRecovery({ deviceChangeStorm, minutes = 30 }) {
  const SOFT_ATTEMPTS = 2, RECOVER_COOLDOWN_MS = 20000, DEVICE_COOLDOWN_MS = 6000;
  let softFailures = 0, lastAttemptTs = 0, endpointSwitchTried = false;
  let probes = 0, switches = 0, t = 0;
  const attempt = (reason) => {
    const cooldown = reason === 'devicechange' ? DEVICE_COOLDOWN_MS : RECOVER_COOLDOWN_MS;
    if (t - lastAttemptTs < cooldown) return;
    lastAttemptTs = t;
    probes++;
    // every attempt fails: the endpoint is permanently dead
    if (++softFailures >= SOFT_ATTEMPTS && !endpointSwitchTried) { endpointSwitchTried = true; switches++; }
  };
  for (t = 0; t <= minutes * 60000; t += 1000) {
    attempt('system-dead');
    // Worst case: the switch landed on another silent device, so Windows keeps firing devicechange.
    if (deviceChangeStorm && switches > 0) attempt('devicechange');
  }
  return { probes, switches };
}

const steady = simulateRecovery({ deviceChangeStorm: false });
assert.strictEqual(steady.switches, 1, 'endpoint switch is one-shot, not once per failed probe');
assert.ok(steady.probes <= 100, `a permanently dead endpoint stays bounded (got ${steady.probes} probes/30min)`);

// The regression this guards: 'devicechange' was originally EXEMPT from the cooldown rather than
// given a shorter one. Simulated over the same 30 minutes that ran 1763 probes — ~59/min, each
// costing a 4s probe, i.e. permanently probing.
const storm = simulateRecovery({ deviceChangeStorm: true });
assert.strictEqual(storm.switches, 1, 'a devicechange storm still switches only once');
assert.ok(storm.probes < 400,
  `devicechange must be rate-limited, not exempt (got ${storm.probes} probes/30min; the exempt version ran 1763)`);

assert.ok(/in use by another app/.test(describeMediaError('microphone', { name: 'NotReadableError', message: 'x' })),
  'NotReadableError explains a busy/failed device');
assert.ok(/microphone/.test(describeMediaError('microphone', { name: 'Whatever', message: 'x' })),
  'unknown errors still name the stream that failed');
assert.strictEqual(looksBluetooth({ label: 'Headphones (WH-1000XM4 Stereo)' }), true);
assert.strictEqual(looksBluetooth({ label: 'Speakers (Realtek(R) Audio)' }), false);
assert.strictEqual(looksBluetooth(null), false, 'no device → not bluetooth, never throws');

// --- rosterIsTrustworthy across platforms. Meet/Zoom guests routinely join under a single first
// name, and the word-count heuristic alone REJECTED those legitimate rosters (measured: 0% and 33%
// two-word) — throwing away a correct closed set. Structural evidence (a real participants panel)
// now outranks name shape. Note personScore cannot help here: "Back" scores 0.85 exactly like
// "Sagar", "History Navigation" scores 1.00 exactly like "Vicky Rana".
const { rosterIsTrustworthy: trust } = require('../src/roster');
const asPanel = (n) => n.map((x) => ({ name: x, source: 'participants-panel', confidence: 0.9 }));
const asGrid = (n) => n.map((x) => ({ name: x, source: 'tile-grid', confidence: 0.75 }));

assert.ok(trust(asPanel(['Sagar', 'Vicky', 'Priya'])), 'Meet: first-name-only guests from a real panel are a real roster');
assert.ok(trust(asPanel(['Sagar', 'Vicky Rana', 'iPhone'])), 'Zoom: mixed mononyms + a device name still a real roster');
assert.ok(trust(asPanel(['Sagar', 'Vicky'])), 'a two-guest call is trustworthy');
assert.ok(trust(asPanel(['Carlos Brito', 'Hernan Zapata', 'Tarun Jain', 'SBPM Dev'])), 'Teams captured roster (regression)');
// The two real pollution datasets from CLAUDE.md must still be rejected.
assert.ok(!trust(asGrid(['Back', 'Forward', 'Reload', 'Work', 'History Navigation', 'PDF Creator',
  'Mentions', 'REPORTS', 'Bookmarks', 'Downloads', 'Extensions', 'Profile', 'Search', 'Home',
  'Refresh', 'Settings', 'Help', 'New Tab', 'Close', 'Minimize', 'Maximize', 'Restore'])),
  'captured Google Meet Chrome-toolbar pollution stays rejected');
assert.ok(!trust(asGrid(['Bold', 'Italic', 'Code', 'Strikethrough', 'Link', 'Ordered list',
  'Bulleted list', 'Blockquote', 'Code block', 'Attach'])),
  'captured Slack formatting-toolbar pollution stays rejected');
assert.ok(!trust(asGrid(['Back', 'Work', 'Code', 'Home'])),
  'a SMALL junk set from the tile-grid fallback is still rejected — size alone is not the test');
assert.ok(trust(['Carlos Brito', 'Hernan Zapata']), 'legacy bare-string rosters still work');
assert.ok(!trust(['Back', 'Forward', 'Reload', 'Work', 'Home', 'Search']), 'legacy junk still rejected');

// --- the agent vote must never put the signed-in user on a remote channel. Teams labels the
// user's own tile ("Myself video, Sagar, …") like any participant, and a real captured meeting
// resolved a channel-1 voice to the signed-in user at 0.95 confidence because of it.
const selfVote = resolveSpeakers({
  transcript: mk('some remote person talking'),
  userName: 'Sagar',
  alignment: { '1:0': { name: 'Sagar', confidence: 0.95 } },
});
assert.strictEqual(selfVote.transcript[1].speaker, 'Speaker 1',
  'the ch0 user must never be assigned to a ch1 voice by the agent vote');
assert.deepStrictEqual(selfVote.unresolved, ['Speaker 1'], 'it stays honestly unresolved');
// A genuine remote name still comes through — the guard must not block everyone.
const otherVote = resolveSpeakers({
  transcript: mk('some remote person talking'),
  userName: 'Sagar',
  alignment: { '1:0': { name: 'Hernan Zapata', confidence: 0.9 } },
});
assert.strictEqual(otherVote.transcript[1].speaker, 'Hernan Zapata',
  'a real remote speaker is still named by the agent vote');

// --- align.js: a sparse active-speaker event must NOT claim the span up to the next one.
// Regression for a real 17-minute meeting that emitted only 3 events, where the unbounded hold
// let ONE event own ~25 minutes and vote its name onto every voice it overlapped.
const sparseJsonl = path.join(os.tmpdir(), `yc-selfcheck3-${process.pid}.jsonl`);
fs.writeFileSync(sparseJsonl, [
  JSON.stringify({ ts: base, type: 'roster', names: ['Hernan Zapata', 'Tarun Jain'], source: 'participants-panel', confidence: 0.9 }),
  JSON.stringify({ ts: base, type: 'active-speaker', name: 'Hernan Zapata', confidence: 0.75, strategy: 'suffix-delta' }),
  JSON.stringify({ ts: base + 1500000, type: 'active-speaker', name: 'Tarun Jain', confidence: 0.75, strategy: 'suffix-delta' }),
].join('\n'));
// A speaker talking 10 minutes after the first event — far past its 15s hold, long before the next.
const lateSegs = utterancesToSegments([
  { channel: 1, speaker: 0, start: 600, end: 640, transcript: 'much later in the meeting', words: [{ word: 'later', start: 600, end: 601 }] },
], base, 'Sagar');
const lateAlign = alignSpeakers(lateSegs, sparseJsonl);
fs.unlinkSync(sparseJsonl);
assert.ok(!lateAlign.renamed['1:0'],
  'a stale event must not claim a voice 10 minutes later — silence beats a confident wrong name');

// A real speaking signal repeats: events every 5 s across a 40 s turn still attribute normally.
const denseJsonl = path.join(os.tmpdir(), `yc-selfcheck4-${process.pid}.jsonl`);
fs.writeFileSync(denseJsonl, [
  JSON.stringify({ ts: base, type: 'roster', names: ['Hernan Zapata', 'Tarun Jain'], source: 'participants-panel', confidence: 0.9 }),
  ...[0, 5000, 10000, 15000, 20000, 25000, 30000, 35000].map((off) => JSON.stringify({
    ts: base + off, type: 'active-speaker', name: 'Hernan Zapata', confidence: 0.75, strategy: 'suffix-delta',
  })),
].join('\n'));
const denseSegs = utterancesToSegments([
  { channel: 1, speaker: 0, start: 1, end: 40, transcript: 'talking throughout', words: [{ word: 'talking', start: 1, end: 2 }, { word: 'throughout', start: 39, end: 40 }] },
], base, 'Sagar');
const denseAlign = alignSpeakers(denseSegs, denseJsonl);
fs.unlinkSync(denseJsonl);
assert.strictEqual(denseAlign.renamed['1:0'], 'Hernan Zapata',
  'dense, sustained events still attribute — the rules must not break the working case');
assert.strictEqual(denseSegs[0].speaker, 'Speaker 1', '…and still without touching the transcript');

// The upzu regression (2026-11-11): one first-poll "Sagar" event at +14 s overlapped a remote
// voice with 1,797 words and named it "Sagar" at share 1.0. Not any more — and not at all for a
// voice whose speech it barely covers.
const upzuJsonl = path.join(os.tmpdir(), `yc-selfcheck5-${process.pid}.jsonl`);
fs.writeFileSync(upzuJsonl, [
  JSON.stringify({ ts: base + 14000, type: 'roster', names: ['Sagar', 'Hernan Zapata', 'Ramir Mesquita'], source: 'participants-panel', confidence: 0.9 }),
  JSON.stringify({ ts: base + 14000, type: 'active-speaker', name: 'Sagar', confidence: 0.75, strategy: 'suffix-delta' }),
].join('\n'));
const upzuSegs = utterancesToSegments(Array.from({ length: 60 }, (_, i) => ({
  channel: 1, speaker: 0, start: 10 + i * 30, end: 35 + i * 30, transcript: 'Hey Carlos I was asking Ramir',
  words: [{ word: 'Hey', start: 10 + i * 30, end: 11 + i * 30 }, { word: 'Ramir', start: 34 + i * 30, end: 35 + i * 30 }],
})), base, 'Sagar Bansal');
const upzu = alignSpeakers(upzuSegs, upzuJsonl);
fs.unlinkSync(upzuJsonl);
assert.deepStrictEqual(upzu.renamed, {}, 'upzu: a single first-poll event names nobody');

// --- inferSpeakerNames: every non-direct kind of evidence stays below "verified".
const { CAPS, OPEN_CAP } = require('../src/ai/inferSpeakerNames');
for (const basis of ['host', 'title', 'topic', 'history', 'other']) {
  assert.ok(CAPS[basis] < 0.85, `${basis} evidence renders as a suggestion`);
}
assert.ok(OPEN_CAP < 0.85, 'open inference (no candidate list) renders as a suggestion');

// The closed-set guard must still reject anything off-roster.
const offRoster = pir('{"Speaker 2":{"name":"Someone Else","confidence":0.9}}',
  ['Speaker 2'], ['Carlos Brito', 'Hernan Zapata'], 'Sagar Bansal');
assert.deepStrictEqual(offRoster, {}, 'a name not on the roster is still rejected outright');

// --- Roster hygiene from the real Slack huddles: the formatting toolbar and profile rows.
const { normalizeName: nn, isPersonName: isP, mergeRoster: mr } = require('../src/roster');
assert.strictEqual(nn("View Felipe Frias's profile"), 'Felipe Frias', 'Slack profile rows yield the name');
for (const junk of ['Code', 'Huddles', 'Bold', 'Backgrounds and effects', 'Fireflies.ai Notetaker Hernan']) {
  assert.ok(!isP(junk), `"${junk}" is not a person`);
}
assert.deepStrictEqual(mr([{ names: ['Brito', 'Carlos Brito', 'Hernan Zapata'], source: 'participants-panel', confidence: 0.9 }]).map((r) => r.name).sort(),
  ['Carlos Brito', 'Hernan Zapata'], '"Brito" and "Carlos Brito" are one person, kept under the fuller name');

// --- resolveSpeakers: the user can never be put on a remote voice by ANY source, and a voted
// UI label never becomes a speaker.
const aiSelf = resolveSpeakers({ transcript: mk('hello'), userName: 'Sagar Bansal', inferred: { 'Speaker 1': { name: 'Sagar', confidence: 0.9 } } });
assert.strictEqual(aiSelf.transcript[1].speaker, 'Speaker 1', 'AI cannot name a remote voice as the user');
const uiVote = resolveSpeakers({ transcript: mk('hello'), userName: 'Sagar', alignment: { '1:0': { name: 'Huddles', confidence: 0.95 } } });
assert.strictEqual(uiVote.transcript[1].speaker, 'Speaker 1', 'a voted UI label is not a person');

// --- detector: classification by WHO HOLDS THE MIC, not by window title.
const { classifySnapshot, createTracker, parseMicRegistry, stillLive } = require('../src/detector');
assert.strictEqual(classifySnapshot({ mic: [{ proc: 'ms-teams' }], windows: [{ proc: 'ms-teams', title: 'Chat | Microsoft Teams' }] }).platform, 'teams',
  'Teams holding the mic is a call even though no title says "Meeting"');
assert.strictEqual(classifySnapshot({ mic: [{ proc: 'slack' }] }).platform, 'slack', 'Slack huddles are detected');
assert.strictEqual(classifySnapshot({ mic: [{ proc: 'firefox' }], windows: [{ proc: 'firefox', title: 'Meet - abc-defg-hij' }] }).platform, 'google-meet',
  'Firefox Meet is detected (the old matcher was Chromium-only)');
const unknownBrowser = classifySnapshot({ mic: [{ proc: 'chrome' }], windows: [{ proc: 'chrome', title: 'Some page' }] });
assert.ok(unknownBrowser && !unknownBrowser.known, 'an unrecognised browser mic user is a slow-start candidate, not ignored');
assert.strictEqual(classifySnapshot({ mic: [{ proc: 'your call ai' }, { proc: 'obs64' }] }), null, 'our own recorder and OBS are not calls');
assert.strictEqual(classifySnapshot({ mic: [{ proc: 'msedgewebview2' }], windows: [{ proc: 'ms-teams', title: 'Microsoft Teams' }] }).platform, 'teams',
  'new Teams media in WebView2 is attributed to Teams');

const tr = createTracker({ knownStartMs: 4000, unknownStartMs: 30000, endGraceMs: 20000 });
const teamsCall = { mic: [{ proc: 'ms-teams' }], windows: [] };
assert.strictEqual(tr.step(0, teamsCall), null, 'not announced on the first poll');
assert.strictEqual(tr.step(4000, teamsCall).type, 'detected', 'announced once held for the debounce');
// The over-run recordings: after the call the user's ROOM NOISE must not keep it alive — only the
// call app, its call window, or MEETING audio may.
assert.strictEqual(tr.step(10000, { mic: [], windows: [] }), null, 'grace period');
assert.strictEqual(tr.step(31000, { mic: [], windows: [] }).type, 'closed', 'closes after the grace period');
assert.ok(stillLive({ platform: 'zoom', app: 'zoom' }, { mic: [], windows: [] }, { systemAudio: true }), 'meeting audio keeps it alive');
assert.ok(!stillLive({ platform: 'teams', app: 'ms-teams' }, { mic: [], windows: [{ proc: 'ms-teams', title: 'Calls | Microsoft Teams' }] }),
  'the Teams "Calls" TAB is not a call window');

assert.deepStrictEqual(parseMicRegistry([
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe',
  '    LastUsedTimeStop    REG_QWORD    0x1db3',
].join('\n')), [{ proc: 'chrome' }], 'registry fallback yields process names');

// --- people.js: recurring meetings and their regulars, learned from the user's own renames.
const people = require('../src/people');
assert.strictEqual(people.seriesKeyFor('Daily Sync - Hernan (Nov 9)'), people.seriesKeyFor('Daily Sync – Hernan'), 'same series despite dates/punctuation');
assert.strictEqual(people.seriesKeyFor('Meeting · Nov 9, 2026, 10:00 AM'), null, 'the default title names no series');
const lib = [2, 3, 4].map((i) => ({ // Mon–Wed
  id: `m${i}`, title: 'Daily Sync - Hernan', date: `2026-11-0${i}T05:00:00Z`,
  speakerMap: { '0:0': { name: 'Sagar Bansal', source: 'signed-in-user', confidence: 0.95, lockedByUser: false },
    '1:0': { name: 'Hernan Zapata', source: 'manual', confidence: 1, lockedByUser: true },
    '1:1': { name: 'Tarun Jain', source: 'ai-inference', confidence: 0.9, lockedByUser: false } },
}));
const h = people.historyFor(lib, { id: 'new', title: 'Daily Sync - Hernan', date: '2026-11-10T05:00:00Z' }, { userName: 'Sagar Bansal' });
assert.strictEqual(h.basis, 'title');
assert.strictEqual(h.people[0].name, 'Hernan Zapata', 'the host the user kept fixing is the top candidate');
assert.ok(!h.people.some((p) => p.name === 'Sagar Bansal'), 'the user is never a candidate');
const slot = people.historyFor(lib, { id: 'new', title: 'Meeting · Nov 10', date: '2026-11-10T05:05:00Z' }, { userName: 'Sagar Bansal' });
assert.strictEqual(slot.basis, 'time-slot', 'an untitled meeting in a recurring slot still finds its regulars');

// --- systemAudio.js: the native-track decision (pure parts).
const sa = require('../src/systemAudio');
const pcm = Buffer.alloc(16000 * 2 * 4);
for (let i = 16000 * 2; i < 16000 * 3; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2);
assert.deepStrictEqual(sa.activityFromPcm(pcm), [false, false, true, false], 'per-second activity of s16le PCM');
assert.strictEqual(sa.alignmentOffset(1000, 3500), 2.5, 'recorder started 2.5 s into the native track');
assert.ok(/atrim=start=2\.500/.test(sa.remixFilter(2.5)) && /adelay=1500/.test(sa.remixFilter(-1.5)), 'both alignment directions');
const t0n = 1_000_000;
const act = Array.from({ length: 120 }, (_, s) => s >= 30 && s < 90);
assert.strictEqual(sa.secondsMissedByChrome([{ ts: t0n + 60000, sysActive: 15, window: 15 }], act, t0n), 0,
  'Chromium heard the window → nothing missed');
assert.strictEqual(sa.secondsMissedByChrome([{ ts: t0n + 60000, sysActive: 0, window: 15 }], act, t0n), 15,
  'Chromium deaf while native heard sound → those seconds count as missed');
assert.strictEqual(sa.chooseSystemTrack([false, false], [true]).use, 'chrome', 'a silent native track is never preferred');

// --- audioHealth: a dead system stream is re-reported while it stays dead (the latch used to
// make an ENDED track unrecoverable for the rest of the meeting).
const { createHealth: ch } = require('../src/recorder/audioHealth');
const rep = ch({ startedAt: 0, warmupMs: 1000, graceMs: 0, deathMs: 12000, deathRepeatMs: 30000 });
let reports = 0;
for (let t = 0; t <= 100000; t += 1000) { const e = rep.tick(t, 4e-4, 0); if (e && e.type === 'system-dead') reports++; }
assert.ok(reports >= 3, `sustained death is re-reported (got ${reports})`);

// --- media.js: the recording-media resolver (§5). The whole normalize state machine is read
// off the filesystem rather than from meta.status, because runPipeline writes status:'complete'
// BEFORE its final upsert while recoverAndRequeue only requeues recorded/transcribing/failed —
// so anything keyed off status and finishing late would be unresumable forever. These
// assertions pin the probe order and every disk state that machine can be in.
const media = require('../src/media');
const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ycai-media-'));
const touch = (...names) => {
  fs.readdirSync(mediaDir).forEach((f) => fs.unlinkSync(path.join(mediaDir, f)));
  names.forEach((n) => fs.writeFileSync(path.join(mediaDir, n), 'x'));
};

assert.strictEqual(media.resolveMedia(mediaDir), null, 'empty dir resolves to no media');
assert.strictEqual(media.needsNormalize(mediaDir).action, 'none', 'nothing on disk → nothing to do');

touch('capture.webm');
assert.strictEqual(media.resolveMedia(mediaDir).name, 'capture.webm');
assert.strictEqual(media.needsNormalize(mediaDir).action, 'normalize', 'a capture file IS the flag');

touch('video.mp4');
assert.strictEqual(media.resolveMedia(mediaDir).name, 'video.mp4');
assert.ok(media.resolveMedia(mediaDir).normalized, 'video.mp4 reports itself normalized');
assert.strictEqual(media.needsNormalize(mediaDir).action, 'none', 'already converted → skip');

touch('video.mp4', 'capture.webm');
assert.strictEqual(media.resolveMedia(mediaDir).name, 'video.mp4',
  'normalized output wins the probe order over the capture it came from');
assert.strictEqual(media.needsNormalize(mediaDir).action, 'cleanup',
  'crashed between rename and unlink → drop the leftover source, do not re-convert');

touch('capture.webm', 'video.mp4.part');
const partState = media.needsNormalize(mediaDir);
assert.strictEqual(partState.action, 'normalize');
assert.ok(partState.stale, 'a .part is always reported for deletion: +faststart relocates moov '
  + 'at the end, so a partial one has no usable index by construction');

// Legacy recordings must resolve (they still play and download) but must NEVER be swept into a
// conversion. Otherwise the first launch after an update transcodes a user's whole library.
touch('video.webm');
assert.strictEqual(media.resolveMedia(mediaDir).name, 'video.webm', 'pre-change recordings still resolve');
assert.strictEqual(media.resolveMedia(mediaDir).ext, '.webm');
assert.strictEqual(media.needsNormalize(mediaDir).action, 'none',
  'legacy video.webm is never auto-converted — Phase 6 does it opt-in');

// A zero-byte file is not media. The recorder can leave one behind when it errors right after
// the write stream was opened; treating it as playable gives a dead ▶ link and makes
// needsNormalize burn all three conversion attempts on an empty file.
touch();
fs.writeFileSync(path.join(mediaDir, 'capture.mp4'), '');
assert.strictEqual(media.resolveMedia(mediaDir), null, 'a 0-byte capture is not playable media');
assert.strictEqual(media.needsNormalize(mediaDir).action, 'none', 'a 0-byte capture is not converted');

// ...but a 0-byte .part must still be reported for deletion: +faststart relocates moov at the
// very end, so any partial .part is unusable by construction.
touch('capture.webm');
fs.writeFileSync(path.join(mediaDir, 'video.mp4.part'), '');
assert.ok(media.needsNormalize(mediaDir).stale, 'an empty .part is still cleaned up');

fs.rmSync(mediaDir, { recursive: true, force: true });

assert.strictEqual(media.captureNameFor('video/mp4;codecs=avc1.640028,mp4a.40.2'), 'capture.mp4');
assert.strictEqual(media.captureNameFor('video/x-matroska;codecs=avc1,opus'), 'capture.mkv');
assert.strictEqual(media.captureNameFor('video/webm;codecs=vp9,opus'), 'capture.webm');
assert.strictEqual(media.captureNameFor(undefined), 'capture.webm', 'unknown mime falls back to webm');

// The download name/filter follow the file that actually exists. Offering an .mp4 filter over a
// .webm file yields something Windows refuses to open — worse than the honest extension.
assert.strictEqual(media.downloadName('Team sync · Mon 3/4', { ext: '.mp4' }), 'Team sync - Mon 3-4.mp4');
assert.deepStrictEqual(media.downloadFilter({ ext: '.webm' }), { name: 'WebM video', extensions: ['webm'] });
assert.deepStrictEqual(media.downloadFilter({ ext: '.mp4' }), { name: 'MP4 video', extensions: ['mp4'] });
assert.ok(media.allMediaNames().includes('video.mp4') && media.allMediaNames().includes('video.webm')
  && media.allMediaNames().includes('video.mp4.part'),
  'retention must know every artifact, or an mp4 outlives AUTO_DELETE_DAYS forever');

// --- ffmpeg.js: the pure halves (argument builders and output parsers). No binary, no Electron.
const ffm = require('../src/ffmpeg');

// -f mp4 must be present on EVERY path. We write to "video.mp4.part" so a crash can never leave
// a half-file under the real name, and ffmpeg picks its muxer from the extension — which is
// ".part". Without an explicit format every conversion dies instantly with "Unable to choose an
// output format". This was a real bug, caught only by running it.
for (const ext of ['.mp4', '.mkv', '.webm']) {
  const args = ffm.buildArgs({ src: 'in' + ext, dst: 'out.mp4.part', ext, encoder: 'h264_mf', threads: 4 });
  const fi = args.indexOf('-f');
  assert.ok(fi >= 0 && args[fi + 1] === 'mp4', `-f mp4 required for a ${ext} source`);
  assert.strictEqual(args[args.length - 1], 'out.mp4.part', 'output path is last');
  assert.ok(args.includes('+faststart'), `${ext}: faststart is the entire point`);
  // Optional audio: loopback can hand back a stream with no audio track at all, and a mandatory
  // -map 0:a:0 would fail the whole job rather than just omitting the track.
  assert.ok(args.includes('0:a:0?'), `${ext}: audio mapping must be optional`);
  // VFR: getDisplayMedia suppresses unchanged frames, and letting ffmpeg force a constant rate
  // accumulates A/V drift that only shows up ~40 minutes into a recording.
  assert.ok(args.includes('passthrough'), `${ext}: -fps_mode passthrough`);
}

// An H.264 source is a stream copy — no encoder, no scaling, no re-encode. This is what makes
// the common path seconds instead of minutes.
const mp4Args = ffm.buildArgs({ src: 'capture.mp4', dst: 'o.part', ext: '.mp4' });
assert.ok(mp4Args.includes('-c') && mp4Args[mp4Args.indexOf('-c') + 1] === 'copy',
  'a fragmented-mp4 source is remuxed losslessly');
assert.ok(!mp4Args.includes('-vf'), 'no filtering on the copy path');

// MKV holds H.264 already, so only the audio is re-encoded: Opus in MP4 is legal but QuickTime
// and Safari refuse it.
const mkvArgs = ffm.buildArgs({ src: 'capture.mkv', dst: 'o.part', ext: '.mkv' });
assert.strictEqual(mkvArgs[mkvArgs.indexOf('-c:v') + 1], 'copy', 'mkv keeps the H.264 video');
assert.strictEqual(mkvArgs[mkvArgs.indexOf('-c:a') + 1], 'aac', 'mkv audio must become AAC');

// The transcode path needs even dimensions: H.264 4:2:0 forbids odd ones, and fractional display
// scaling produces them. Missing this fails on EVERY encoder, which reads as "ffmpeg is broken".
const webmArgs = ffm.buildArgs({ src: 'capture.webm', dst: 'o.part', ext: '.webm', encoder: 'h264_qsv', threads: 3 });
assert.ok(webmArgs.join(' ').includes('scale=trunc(iw/2)*2:trunc(ih/2)*2'), 'even dimensions enforced');
assert.strictEqual(webmArgs[webmArgs.indexOf('-pix_fmt') + 1], 'yuv420p');
assert.strictEqual(webmArgs[webmArgs.indexOf('-c:v') + 1], 'h264_qsv');
assert.strictEqual(webmArgs[webmArgs.indexOf('-threads') + 1], '3');
assert.ok(webmArgs.includes('-g'), 'explicit GOP — this IS the seek granularity of a transcode');

// libx264 is GPL and this project is MIT, so the shipped build deliberately lacks it. If it ever
// reappears in the candidate list, the licensing decision has been silently reversed.
assert.ok(!ffm.CANDIDATES.includes('libx264'), 'libx264 (GPL) must never be a candidate');
assert.ok(ffm.CANDIDATES[ffm.CANDIDATES.length - 1] === 'libopenh264',
  'software encoder is the last resort, hardware first');

// `ffmpeg -encoders` parsing, against real output shape.
assert.deepStrictEqual(ffm.parseEncoders([
  'Encoders:',
  ' V..... = Video',
  ' ------',
  ' V....D libopenh264          OpenH264 H.264 / AVC (codec h264)',
  ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
  ' V..... h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration) (codec h264)',
].join('\n')), ['libopenh264', 'h264_nvenc', 'h264_qsv'], 'video encoders only, audio ignored');

// -progress output is key=value terminated by progress=continue/end, and a line can be split
// across chunk boundaries — the parser must buffer the partial tail.
const seen = [];
const feed = ffm.createProgressParser((f) => seen.push(f));
feed('frame=12\nout_time_us=500000\npro');
feed('gress=continue\n');
assert.strictEqual(seen.length, 1, 'a key=value line split across chunks is still parsed');
assert.strictEqual(ffm.outTimeMs(seen[0]), 500, 'out_time_us converts to ms');
feed('out_time_us=N/A\nprogress=continue\n');
assert.strictEqual(ffm.outTimeMs(seen[1]), null, 'N/A early in the run is not a number');
feed('out_time_ms=2000000\nprogress=end\n');
assert.strictEqual(ffm.outTimeMs(seen[2]), 2000, 'out_time_ms fallback');

console.log('selfcheck: all assertions passed');
