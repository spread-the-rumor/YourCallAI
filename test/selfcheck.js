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

console.log('selfcheck: all assertions passed');
