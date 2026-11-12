// Shared AI client — proxied through the Vercel backend (no key on the client).
// The server picks the model; we just send messages. Kept name MODEL for callers/back-compat.
//
// Every AI feature (chat, summary, action items, names) goes through chatCompletion, so this is
// where a bad connection is absorbed. Measured 2026-11-12 before the fix: ~30% of AI responses
// stalled mid-flight and were cut ~70 s later (`TypeError: terminated`); the reader waited for the
// socket to close, threw away the text it had, and never retried. Now:
//   - the stream ends at `[DONE]` / finish_reason, not at socket close;
//   - no byte for IDLE_MS aborts the attempt (the server pings every 5 s, so silence = dead);
//   - a dead or incomplete attempt is retried (up to ATTEMPTS in total); onReset tells a streaming
//     caller to clear the text it showed before the retry streams the answer again;
//   - server/provider errors are thrown with their real message, not as "empty response".
//   - each attempt carries a jobId; the server keeps the answer in Redis as it is produced. When
//     the stream dies after the server accepted it, the answer is collected with short polls
//     (GET /api/ai?job=) instead of being generated again — measured: the server finished every
//     long answer while the connection back to the app was what failed (see api/ai.js).
const crypto = require('crypto');
const { proxyPost, PROXY_URL, appProxyToken } = require('../proxy');

const MODEL = 'google/gemma-4-31b-it';
const IDLE_MS = 30000; // the server pings every 5 s; 30 s of nothing is a dead connection
const ATTEMPTS = 3;
const POLL_MS = 2000;
const POLL_MAX_MS = 290000;   // the function's maxDuration is 300 s
const JOB_DEAD_MS = 60000;    // the server re-saves a running job every 15 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AiError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

// A readable message out of whatever the server returned (it may itself wrap the provider's JSON).
function cleanMessage(raw) {
  let s = String(raw || '').trim();
  try { const j = JSON.parse(s); s = typeof j.error === 'string' ? j.error : (j.error?.message || j.message || s); } catch { /* not JSON */ }
  const inner = s.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (inner) s = inner[1].replace(/\\"/g, '"');
  return s.replace(/^AI request failed \(\d+\):\s*/, '').slice(0, 300);
}

function friendly(status, message) {
  if (status === 429) return 'The AI service is busy — try again in a minute.';
  if (status === 401) return 'The app is not authorised to use the AI service (update the app).';
  return message ? `AI request failed (${status}): ${message}` : `AI request failed (${status})`;
}

// One attempt. Resolves to the full text; throws AiError.
async function attempt(messages, { onDelta, temperature, purpose, jobId }) {
  const ac = new AbortController();
  let idle;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('idle')), IDLE_MS); };
  arm();
  let res;
  try {
    // ALWAYS the streaming format, even when the caller wants only the final text. The buffered
    // format's keep-alive is one byte every 5 s, and the network path to Vercel was measured
    // holding such tiny writes back for up to 69 s — indistinguishable from a dead connection, so
    // the idle watchdog killed answers that were on their way. A stream carries real frames
    // (including the model's reasoning) every few hundred ms.
    res = await proxyPost('/api/ai', { messages, temperature, stream: true, jobId, ...(purpose ? { purpose } : {}) }, { signal: ac.signal });
  } catch (err) {
    clearTimeout(idle);
    throw new AiError(ac.signal.aborted ? 'The AI did not respond' : `Network error: ${err.cause?.code || err.message}`, { retryable: true });
  }
  if (!res.ok) {
    clearTimeout(idle);
    const body = await res.text().catch(() => '');
    let retryable = res.status === 429 || res.status >= 500;
    try { if (JSON.parse(body).retryable === false) retryable = false; } catch { /* not JSON */ }
    throw new AiError(friendly(res.status, cleanMessage(body)), { retryable, status: res.status });
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let full = '';
  let finished = false;
  try {
    // A JSON body (an older or misbehaving server answering the buffered way) is still accepted.
    const sse = /event-stream/i.test(res.headers.get('content-type') || '');
    if (!sse) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
      let json;
      try { json = JSON.parse(text); } catch { throw new AiError('The AI response was cut off', { retryable: true }); }
      if (json.error) { const e = new AiError(cleanMessage(json.error), { retryable: json.retryable !== false }); e.fromServer = true; throw e; }
      const choice = json.choices?.[0];
      if (!choice) throw new AiError('The AI response was cut off', { retryable: true });
      return choice.message?.content || '';
    }

    // SSE: `data: {...}` frames, `: ping` comments, `data: [DONE]`.
    let buf = '';
    const handle = (raw) => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { finished = true; return; }
      let frame;
      try { frame = JSON.parse(payload); } catch { return; }
      if (frame.error) {
        const e = new AiError(cleanMessage(JSON.stringify(frame)), { retryable: frame.error.retryable !== false });
        e.fromServer = true;
        throw e;
      }
      const choice = frame.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) { full += delta; if (onDelta) onDelta(delta); }
      if (choice?.finish_reason) finished = true;
    };
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += dec.decode(value, { stream: true });
      let i;
      while (!finished && (i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (!finished) { buf += dec.decode(); if (buf.trim()) handle(buf); }
    if (!finished) throw new AiError('The AI response was cut off', { retryable: true });
    return full;
  } catch (err) {
    const e = err instanceof AiError ? err
      : new AiError(ac.signal.aborted ? 'The AI stopped responding' : `Connection dropped (${err.cause?.code || err.message})`, { retryable: true });
    // The server accepted this request, so it may still be producing (or have finished) the answer.
    if (e.retryable && !e.fromServer) e.jobId = jobId;
    throw e;
  } finally {
    clearTimeout(idle);
    reader.cancel().catch(() => {});
  }
}

// Collects the answer of an attempt whose connection died. Returns { text } when the server
// finished it, { error } when the server failed it, or null when the job is unknown or went
// silent (then the caller retries from scratch). ui.show(text) keeps a streaming UI in step.
async function pollJob(jobId, ui) {
  const deadline = Date.now() + POLL_MAX_MS;
  let unknown = 0;
  let lastTs = null;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let job;
    try {
      const r = await fetch(`${PROXY_URL}/api/ai?job=${encodeURIComponent(jobId)}`, {
        headers: { 'x-app-token': appProxyToken() }, signal: AbortSignal.timeout(15000),
      });
      if (r.status === 400 || r.status === 401 || r.status === 405) return null; // no job support
      if (!r.ok) continue;
      job = await r.json();
    } catch { continue; } // a failed poll is just a missed poll
    if (!job || job.status === 'unknown') { if (++unknown >= 5) return null; continue; }
    unknown = 0;
    if (job.content) ui.show(job.content);
    if (job.status === 'done') return { text: job.content || '' };
    if (job.status === 'error') return { error: job.error || 'The AI request failed' };
    if (job.ts !== lastTs) { lastTs = job.ts; lastChange = Date.now(); }
    else if (Date.now() - lastChange > JOB_DEAD_MS) return null; // the server stopped updating it
  }
  return null;
}

// Returns the full completion text. With onDelta, streams and calls onDelta(chunkText); onReset()
// is called before a retry so the caller can clear text it already displayed.
// `purpose` lets the server pick a purpose-specific model (e.g. 'names').
async function chatCompletion(messages, { onDelta, onReset, temperature = 0.3, purpose, attempts = ATTEMPTS } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let shownText = ''; // what the caller's UI currently shows for this attempt
    const delta = onDelta ? (d) => { shownText += d; onDelta(d); } : undefined;
    // Keeps a streaming UI in step with text collected by polling.
    const ui = {
      show(text) {
        if (!onDelta || text === shownText) return;
        if (text.startsWith(shownText)) onDelta(text.slice(shownText.length));
        else { if (onReset) { try { onReset(); } catch { /* UI only */ } } onDelta(text); }
        shownText = text;
      },
    };
    const jobId = crypto.randomUUID();
    try {
      return await attempt(messages, { onDelta: delta, temperature, purpose, jobId });
    } catch (err) {
      lastErr = err;
      if (err.retryable && err.jobId) {
        const polled = await pollJob(err.jobId, ui);
        if (polled && polled.text != null) return polled.text;
        if (polled && polled.error) lastErr = new AiError(cleanMessage(polled.error), { retryable: true });
      }
      if (!lastErr.retryable || i === attempts - 1) break;
      if (shownText && onReset) { try { onReset(); } catch { /* UI only */ } }
      await sleep(lastErr.status === 429 ? 4000 : 800);
    }
  }
  throw lastErr;
}

// Defensive JSON extraction: strip code fences, isolate the first [...] or {...}.
function parseLooseJson(text, opener = '[') {
  const closer = opener === '[' ? ']' : '}';
  let t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf(opener);
  const end = t.lastIndexOf(closer);
  if (start < 0 || end <= start) throw new Error('no JSON found in AI response');
  return JSON.parse(t.slice(start, end + 1));
}

module.exports = { chatCompletion, parseLooseJson, cleanMessage, MODEL, AiError };
