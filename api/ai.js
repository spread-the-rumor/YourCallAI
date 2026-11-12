// /api/ai — proxy Requesty (OpenAI-compatible) chat completions; injects the key server-side.
//   POST            run a completion (SSE stream, or one JSON body for old buffered clients)
//   GET ?job=<id>   the stored progress/result of a POST that carried `jobId` (see below)
//
// NODE runtime (not Edge) since v2.5.1, maxDuration in vercel.json.
//
// Why jobs. Measured 2026-11-12 with request tracing: the FUNCTION ran every long request to the
// end (finish_reason "stop" at 101 s and 120 s, client never seen leaving) while the client's
// connection stopped receiving bytes at 7–53 s and was reset ~70 s later — on Edge and on Node,
// through Node's fetch and Chromium's net.fetch alike. Long answers (names on a big meeting take
// 100–170 s of model reasoning) were complete on the server and lost on the way back. So the
// answer is also written to Redis as it is produced; a client whose stream dies polls
// GET ?job=<id> with short requests instead of starting the whole completion again.
//
// Also, both modes:
//  - the first byte goes out immediately and a keep-alive every 5 s (SSE comment / whitespace);
//  - an upstream silent for STALL_MS is aborted and retried once if no answer text was sent yet;
//  - a failure after the response started is reported IN the body (an SSE `error` frame, or an
//    `{error}` JSON), never as a cut connection.
const { env, redisClient } = require('./_shared');

const MODEL = 'google/gemma-4-31b-it';
// Reasoning models go quiet while they think: gemma on a 965-segment names prompt was measured
// silent for >20 s and still answered correctly at 168 s. The CLIENT stays alive on our pings.
const STALL_MS = 90000;
const HEADERS_MS = 45000;
const KEEPALIVE_MS = 5000;
const JOB_TTL_S = 900;
const JOB_SAVE_MS = 3000;
const JOB_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

// Per-purpose model, chosen SERVER-side. The client may name a purpose, never a model: the proxy
// token is baked into the installer, so accepting a model string would let anyone who extracts it
// run arbitrarily expensive models on this account. Override per purpose with an env var.
//
// names: NOT nemotron-3.5-lightning by default. Measured 2026-11-12 on a real 45 KB names prompt
// it reasoned for 186–365 s before answering (13–24k reasoning frames; reasoning_effort:low,
// enable_thinking:false and /no_think did not stop it) — past every function limit, so naming
// failed on every meeting — and its answers were mostly null. gemma: 44 s, correct name.
const PURPOSE_MODELS = {
  names: () => env('NAMES_MODEL') || MODEL,
};

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// The innermost human-readable message of a Requesty/provider error body.
function upstreamMessage(text) {
  const m = String(text || '').match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return (m ? m[1].replace(/\\"/g, '"') : String(text || '')).slice(0, 300);
}

// One upstream call. Resolves with the Response once headers arrive; `abort()` cancels it.
function startUpstream(base, key, model, payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('upstream sent no headers')), HEADERS_MS);
  const p = fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: ac.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, model, stream: true }),
  }).finally(() => clearTimeout(timer));
  return { p, abort: (why) => ac.abort(why) };
}

// Reads SSE frames from an upstream response. onFrame(line, frame) for every `data:` line.
// Rejects with err.stalled = true when no byte arrives for STALL_MS.
async function pumpFrames(upstream, abort, onFrame) {
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let stallTimer;
  let stalled = false;
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stalled = true; abort(new Error('upstream stalled')); }, STALL_MS);
  };
  const handle = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    let frame = null;
    if (payload !== '[DONE]') { try { frame = JSON.parse(payload); } catch { return; } }
    onFrame(line, frame);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    buf += dec.decode();
    if (buf.trim()) handle(buf);
  } catch (err) {
    if (stalled) { const e = new Error('The AI stopped responding'); e.stalled = true; throw e; }
    throw err;
  } finally {
    clearTimeout(stallTimer);
  }
}

// Job store (Upstash Redis, the store the OAuth one-time codes already use). Every failure is
// swallowed: without it the request behaves exactly as it did before jobs existed.
let testBackend = null; // tests: an in-memory { set, get } in place of Redis
const redisConfigured = () => ['SLACK_KV_REST_API_URL', 'KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'].some((k) => env(k))
  && ['SLACK_KV_REST_API_TOKEN', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'].some((k) => env(k));
function jobStore(jobId) {
  if (!jobId || !JOB_ID_RE.test(jobId)) return null;
  let redis = testBackend;
  if (!redis) {
    if (!redisConfigured()) return null; // jobs off: the request behaves as before they existed
    try { redis = redisClient(); } catch { return null; }
  }
  const key = `ai:job:${jobId}`;
  let chain = Promise.resolve();
  let lastSave = 0;
  let savedLen = -1;
  return {
    // force: write even if nothing changed (start, heartbeat, end).
    save(state, force = false) {
      const now = Date.now();
      if (!force && (now - lastSave < JOB_SAVE_MS || state.content.length === savedLen)) return chain;
      lastSave = now;
      savedLen = state.content.length;
      const value = JSON.stringify({ ...state, ts: now });
      chain = chain.then(() => redis.set(key, value, { ex: JOB_TTL_S })).catch(() => {});
      return chain;
    },
    async read() {
      const v = await redis.get(key);
      if (!v) return null;
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
  };
}

async function getJob(req, res) {
  const jobId = String((req.query && req.query.job) || new URL(req.url, 'http://x').searchParams.get('job') || '');
  const store = jobStore(jobId);
  if (!store) return sendJson(res, 400, { status: 'unknown', error: 'bad job id' });
  try {
    const job = await store.read();
    return sendJson(res, 200, job || { status: 'unknown' });
  } catch (err) {
    return sendJson(res, 200, { status: 'unknown', error: `job store unavailable: ${err.message}` });
  }
}

module.exports = async (req, res) => {
  const expected = env('APP_PROXY_TOKEN');
  if (expected && req.headers['x-app-token'] !== expected) return sendJson(res, 401, { error: 'Unauthorized' });
  if (req.method === 'GET') return getJob(req, res);
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST or GET only' });
  const key = env('REQUESTY_API_KEY');
  if (!key) return sendJson(res, 503, { error: 'AI not configured on server.' });

  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body.' }); }
  const { messages, temperature = 0.3, stream = false, purpose, jobId } = body || {};
  if (!Array.isArray(messages) || !messages.length) return sendJson(res, 400, { error: 'messages required.' });
  const base = env('REQUESTY_BASE_URL') || 'https://router.requesty.ai/v1';
  const wanted = PURPOSE_MODELS[purpose] ? PURPOSE_MODELS[purpose]() : MODEL;
  const payload = { messages, temperature };
  const job = jobStore(jobId);

  // Open the upstream; a purpose model the router refuses (not approved = 403, renamed = 404, …)
  // falls back to the default model rather than failing the feature. 401/429 are not the
  // model's fault, so they are returned as they are.
  async function open() {
    let call = startUpstream(base, key, wanted, payload);
    let up = await call.p;
    if (!up.ok && wanted !== MODEL && up.status >= 400 && up.status < 500 && ![401, 429].includes(up.status)) {
      await up.body?.cancel().catch(() => {});
      call = startUpstream(base, key, MODEL, payload);
      up = await call.p;
    }
    return { up, abort: call.abort };
  }

  let first;
  try { first = await open(); } catch (err) {
    return sendJson(res, 502, { error: `AI request failed: ${err.message}`, retryable: true });
  }
  if (!first.up.ok) {
    const text = await first.up.text().catch(() => '');
    const status = first.up.status;
    return sendJson(res, status, { error: `AI request failed (${status}): ${upstreamMessage(text)}`, retryable: status === 429 || status >= 500 });
  }

  const state = { status: 'running', content: '', finishReason: null, error: null };
  let clientGone = false;
  let current = first;
  // One trace line per request at the end, a heartbeat while it runs, and a line when the client
  // connection closes early. Vercel's request log shows all of these as a plain 200 otherwise.
  const tStart = Date.now();
  let frames = 0;
  const trace = (evt, extra) => console.log(JSON.stringify({ ai: evt, ms: Date.now() - tStart, frames, purpose: purpose || null, stream, job: !!job, ...extra }));
  const heartbeat = setInterval(() => { trace('alive'); if (job) job.save(state, true); }, 15000);
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    trace('client-closed');
    // With a job the answer is still wanted: the client will collect it by polling.
    if (!job) current.abort(new Error('client closed'));
  });
  const write = (s) => { if (!res.writableEnded && !res.destroyed) res.write(s); };

  res.statusCode = 200;
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    write(': ok\n\n');
  } else {
    res.setHeader('Content-Type', 'application/json');
    write(' '); // JSON.parse ignores leading whitespace
  }
  res.flushHeaders?.();
  if (job) job.save(state, true);
  const keepAlive = setInterval(() => write(stream ? ': ping\n\n' : ' '), KEEPALIVE_MS);

  let usage;
  let model = MODEL;
  let id;
  let sentAnswer = false; // the client has received answer text; a retry would duplicate it

  try {
    for (let attempt = 0; attempt < 2 && !(clientGone && !job); attempt++) {
      if (attempt > 0) {
        try { current = await open(); } catch (err) { state.error = `AI retry failed: ${err.message}`; break; }
        if (!current.up.ok) {
          state.error = `AI request failed (${current.up.status}): ${upstreamMessage(await current.up.text().catch(() => ''))}`;
          break;
        }
      }
      try {
        await pumpFrames(current.up, current.abort, (line, frame) => {
          if (frame && frame.error) { state.error = upstreamMessage(JSON.stringify(frame.error)); return; }
          if (stream) write(`${line}\n\n`);
          frames++;
          if (!frame) return;
          const choice = frame.choices?.[0];
          if (choice?.delta?.content) { state.content += choice.delta.content; sentAnswer = true; if (job) job.save(state); }
          if (choice?.finish_reason) state.finishReason = choice.finish_reason;
          if (frame.usage) usage = frame.usage;
          if (frame.model) model = frame.model;
          if (frame.id) id = frame.id;
        });
        break; // completed
      } catch (err) {
        if (clientGone && !job) break;
        // Retry only while nothing of the answer has reached the client (buffered mode never sends
        // any, so it can always retry once). Otherwise report it and let the client decide.
        if (err.stalled && !sentAnswer && attempt === 0) { state.content = ''; state.finishReason = null; continue; }
        state.error = err.stalled ? 'The AI stopped responding' : `AI stream failed: ${err.message}`;
        break;
      }
    }
  } finally {
    clearInterval(keepAlive);
    clearInterval(heartbeat);
  }

  // Without a finish_reason the answer is incomplete: say so rather than pass off a truncation.
  if (!state.error && !state.finishReason) state.error = 'The AI response ended early';
  state.status = state.error ? 'error' : 'done';
  if (job) await job.save(state, true);
  trace('end', { finishReason: state.finishReason, error: state.error, clientGone });
  if (res.writableEnded || res.destroyed) return;

  if (stream) {
    // Upstream's own [DONE] was forwarded on success.
    if (state.error) write(`data: ${JSON.stringify({ error: { message: state.error, retryable: true } })}\n\n`);
    res.end();
    return;
  }
  if (state.error) {
    res.end(JSON.stringify({ error: state.error, retryable: true }));
    return;
  }
  res.end(JSON.stringify({
    choices: [{ index: 0, finish_reason: state.finishReason, message: { role: 'assistant', content: state.content } }],
    model,
    object: 'chat.completion',
    ...(id ? { id } : {}),
    ...(usage ? { usage } : {}),
  }));
};

module.exports.upstreamMessage = upstreamMessage;
module.exports._setJobBackend = (b) => { testBackend = b; };
