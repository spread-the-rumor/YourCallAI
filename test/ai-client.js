// Tests for the AI transport (src/ai/requesty.js), chat history and summary relabelling, with a
// scripted fake backend in place of fetch. node test/ai-client.js
//
// Each case reproduces a failure measured against production on 2026-11-12: a stream that stops
// mid-answer, a buffered reply that never completes, an error frame inside a 200, a 403/429.
const assert = require('assert');

process.env.APP_PROXY_TOKEN = 'test-token';
process.env.VERCEL_BACKEND_URL = 'http://fake.invalid';

// --- fake fetch: each call takes the next scripted response ---
let script = [];
let jobPolls = []; // answers to GET /api/ai?job= polls, in order; default "unknown"
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  if ((opts.method || 'GET') === 'GET') {
    calls.push({ url, poll: true, headers: opts.headers });
    const j = jobPolls.length ? jobPolls.shift() : { status: 'unknown' };
    return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  calls.push({ url, body: JSON.parse(opts.body || '{}'), headers: opts.headers });
  const step = script.shift();
  if (!step) throw new Error('unexpected extra request');
  if (step.throw) throw step.throw;
  const enc = new TextEncoder();
  const chunks = step.chunks || [];
  const stream = new ReadableStream({
    async start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (step.hang) {
        // Never closes: only an abort ends it (the stalled-connection case).
        opts.signal?.addEventListener('abort', () => controller.error(opts.signal.reason || new Error('aborted')));
        return;
      }
      controller.close();
    },
  });
  const isSse = /^(data:|: )/.test(chunks[0] || '');
  return new Response(stream, { status: step.status || 200, headers: isSse ? { 'Content-Type': 'text/event-stream' } : { 'Content-Type': 'application/json' } });
};

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (t) => sse({ choices: [{ delta: { content: t } }] });
const finish = sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });

const requesty = require('../src/ai/requesty');
const { chatCompletion, cleanMessage } = requesty;
const { historyForPrompt, askMeeting } = require('../src/ai/chat');
const { relabelSummary } = require('../src/ai/summarize');

(async () => {
  // Shrink the idle watchdog so the stall cases run in milliseconds.
  const IDLE = 300;
  // requesty reads IDLE_MS at module scope; the fake "hang" is ended by the watchdog's abort.
  // Patch via the module's attempt timeout by overriding setTimeout durations of 20000.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 30000 ? IDLE : (ms >= 800 && ms <= 4000 ? 1 : ms), ...a);

  // 1. Stream ends at [DONE] even though the socket never closes.
  script = [{ chunks: [delta('Hel'), delta('lo'), finish, 'data: [DONE]\n\n'], hang: true }];
  let got = '';
  let out = await chatCompletion([{ role: 'user', content: 'hi' }], { onDelta: (d) => { got += d; } });
  assert.strictEqual(out, 'Hello');
  assert.strictEqual(got, 'Hello');
  assert.strictEqual(calls[0].headers['x-app-token'], 'test-token', 'app token sent');

  // 1b. Without onDelta the client still asks for the stream format and assembles the text.
  script = [{ chunks: [': ok\n\n', delta('A'), delta('B'), finish] }];
  calls.length = 0;
  assert.strictEqual(await chatCompletion([{ role: 'user', content: 'q' }], { purpose: 'names' }), 'AB');
  assert.strictEqual(calls[0].body.stream, true, 'always requests the stream format');
  assert.strictEqual(calls[0].body.purpose, 'names');

  // 2. A stream that stalls mid-answer is retried; onReset clears what was shown.
  script = [
    { chunks: [': ok\n\n', delta('Partial ')], hang: true },
    { chunks: [delta('Full answer'), finish] },
  ];
  got = ''; let resets = 0;
  out = await chatCompletion([{ role: 'user', content: 'q' }], { onDelta: (d) => { got += d; }, onReset: () => { resets++; got = ''; } });
  assert.strictEqual(out, 'Full answer', 'retry returns the complete answer');
  assert.strictEqual(got, 'Full answer', 'UI text was reset before the retry re-streamed');
  assert.strictEqual(resets, 1);

  // 2b. A stream that dies is first COLLECTED from the server's job record, not regenerated.
  script = [{ chunks: [': ok\n\n', delta('Part')], hang: true }];
  jobPolls = [{ status: 'running', content: 'Part', ts: 1 }, { status: 'running', content: 'Partial answ', ts: 2 }, { status: 'done', content: 'Partial answer done', ts: 3 }];
  calls.length = 0; got = ''; resets = 0;
  out = await chatCompletion([{ role: 'user', content: 'q' }], { onDelta: (d) => { got += d; }, onReset: () => { resets++; got = ''; } });
  assert.strictEqual(out, 'Partial answer done', 'answer collected by polling');
  assert.strictEqual(got, 'Partial answer done', 'UI received only the missing text, no duplication');
  assert.strictEqual(resets, 0);
  assert.strictEqual(calls.filter((c) => !c.poll).length, 1, 'no second completion request');
  const jobId = calls[0].body.jobId;
  assert.ok(/^[0-9a-f-]{36}$/.test(jobId) && calls.filter((c) => c.poll).every((c) => c.url.includes(jobId)), 'polls the job of the dead attempt');
  assert.strictEqual(calls.find((c) => c.poll).headers['x-app-token'], 'test-token');

  // 2c. The job failed on the server → retried from scratch.
  script = [{ chunks: [': ok\n\n'], hang: true }, { chunks: [delta('again'), finish] }];
  jobPolls = [{ status: 'error', error: 'The AI stopped responding', ts: 1 }];
  assert.strictEqual(await chatCompletion([{ role: 'user', content: 'q' }], { onDelta: () => {} }), 'again');

  // 3. Buffered mode: whitespace keep-alives then silence → retried; then success.
  script = [
    { chunks: ['   '], hang: true },
    { chunks: ['  ', JSON.stringify({ choices: [{ message: { content: 'ok' } }] })] },
  ];
  assert.strictEqual(await chatCompletion([{ role: 'user', content: 'q' }]), 'ok');

  // 4. An error frame inside a 200 stream is an error, not an empty answer.
  script = [
    { chunks: [sse({ error: { message: 'boom', retryable: false } })] },
  ];
  await assert.rejects(chatCompletion([{ role: 'user', content: 'q' }], { onDelta: () => {} }), /boom/);

  // 5. A buffered {error} body (was read as "empty response") is thrown with its message.
  script = [{ chunks: [' ', JSON.stringify({ error: 'AI not configured on server.', retryable: false })] }];
  await assert.rejects(chatCompletion([{ role: 'user', content: 'q' }]), /AI not configured/);

  // 6. 429 is retried, then reported in plain words.
  script = [
    { status: 429, chunks: [JSON.stringify({ error: 'AI request failed (429): {"error":{"message":"quota"}}', retryable: true })] },
    { status: 429, chunks: [JSON.stringify({ error: 'x', retryable: true })] },
    { status: 429, chunks: [JSON.stringify({ error: 'x', retryable: true })] },
  ];
  await assert.rejects(chatCompletion([{ role: 'user', content: 'q' }]), /busy/);
  assert.strictEqual(script.length, 0, 'three attempts in total');

  // 7. A stream that ends without finish_reason/[DONE] is incomplete → retried.
  script = [
    { chunks: [delta('cut')] },
    { chunks: [delta('whole'), finish] },
  ];
  assert.strictEqual(await chatCompletion([{ role: 'user', content: 'q' }], { onDelta: () => {} }), 'whole');

  // 8. Network error → retried.
  const netErr = new TypeError('fetch failed'); netErr.cause = { code: 'ECONNRESET' };
  script = [{ throw: netErr }, { chunks: [delta('fine'), finish] }];
  assert.strictEqual(await chatCompletion([{ role: 'user', content: 'q' }], { onDelta: () => {} }), 'fine');

  // 9. Doubly wrapped error text is unwrapped.
  assert.strictEqual(cleanMessage('{"error":"AI request failed (403): {\\"error\\":{\\"message\\":\\"The requested model is not approved\\"}}"}'),
    'The requested model is not approved');

  // --- chat history ---
  const hist = historyForPrompt([
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'Chat unavailable — terminated' },
    { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
  ]);
  assert.deepStrictEqual(hist.map((t) => t.content), ['q1', 'a1', 'q3', 'a3'], 'failed turn and its question dropped');
  const long = [];
  for (let i = 0; i < 40; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) });
  const capped = historyForPrompt(long);
  assert.ok(capped.length <= 12 && capped[0].role === 'user', 'history capped and starts on a user turn');

  // askMeeting returns a structured failure, never a fake answer.
  script = [{ chunks: [sse({ error: { message: 'nope', retryable: false } })] }];
  const a = await askMeeting([{ speaker: 'A', channel: 1, diarizedSpeaker: 0, text: 'hello' }], [], 'q', { onDelta: () => {} });
  assert.deepStrictEqual(a, { ok: false, error: 'nope' });
  assert.deepStrictEqual(await askMeeting([], [], 'q'), { ok: false, error: 'This meeting has no transcript yet.' });

  // --- relabelSummary ---
  const before = new Map([['1:0', 'Speaker 1'], ['1:1', 'Speaker 12']]);
  const after = [{ channel: 1, diarizedSpeaker: 0, speaker: 'Jo $& Co' }, { channel: 1, diarizedSpeaker: 1, speaker: 'Ana' }];
  assert.strictEqual(relabelSummary('Speaker 1 and Speaker 12 agreed.', before, after), 'Jo $& Co and Ana agreed.',
    'names with $ inserted literally; Speaker 1 does not eat Speaker 12');

  global.setTimeout = realSetTimeout;
  console.log('ai-client: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
