// POST /api/ai — proxy Requesty (OpenAI-compatible) chat completions. Edge runtime so we can
// pipe the upstream SSE stream straight to the client. Injects the key server-side.
export const config = { runtime: 'edge' };

const MODEL = 'google/gemma-4-31b-it';

// Per-purpose model, chosen SERVER-side. The client may name a purpose, never a model: the proxy
// token is baked into the installer, so accepting a model string would let anyone who extracts it
// run arbitrarily expensive models on this account. Override per purpose with an env var.
const PURPOSE_MODELS = {
  names: () => process.env.NAMES_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b',
};

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const key = process.env.REQUESTY_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: 'AI not configured on server.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const base = process.env.REQUESTY_BASE_URL || 'https://router.requesty.ai/v1';
  const { messages, temperature = 0.3, stream = false, purpose } = await req.json();
  const wanted = PURPOSE_MODELS[purpose] ? PURPOSE_MODELS[purpose]() : MODEL;

  // Always ask upstream to stream, even when the client wants a single JSON body.
  // The Edge runtime kills an invocation that produces no bytes for ~25s, and that timer is on
  // time-to-first-byte, not total duration: a buffered request for a long completion 504s
  // (FUNCTION_INVOCATION_TIMEOUT) while the identical streamed one survives well past it.
  // maxDuration is not an option — it doesn't apply to Edge functions. So we stream from upstream
  // unconditionally and, for non-streaming callers, reassemble the frames below.
  const call = (model) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });
  let upstream = await call(wanted);
  // A purpose model the router does not know (renamed, retired, typo in the env var) must not
  // break the feature: fall back to the default model rather than failing the request.
  if (!upstream.ok && wanted !== MODEL && [400, 404, 422].includes(upstream.status)) {
    upstream = await call(MODEL);
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    return new Response(JSON.stringify({ error: `AI request failed (${upstream.status}): ${body.slice(0, 200)}` }),
      { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  }

  // Stream: pipe SSE frames through untouched (client's parser reads identical frames).
  if (stream) {
    return new Response(upstream.body, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }

  // Non-stream: assemble the SSE frames into one completion, byte-identical in shape to what
  // upstream would have returned unstreamed — src/ai/requesty.js reads choices[0].message.content
  // either way, so no client change is needed.
  //
  // The response is returned as a stream that emits keep-alive whitespace while we assemble.
  // Measured: the Edge runtime kills any invocation that sends no response byte for ~25s, and that
  // timer is on the RESPONSE's time-to-first-byte — merely reading from upstream does NOT reset it.
  // Same prompt, same work: streamed 200 (72s), buffered 504 (25.2s). Emitting a byte immediately
  // keeps the invocation alive for as long as generation takes. JSON.parse ignores leading
  // whitespace, so the client parses the payload exactly as before.
  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(' ')); // first byte now — starts the response, stops the clock
      const keepAlive = setInterval(() => {
        try { controller.enqueue(enc.encode(' ')); } catch { /* already closed */ }
      }, 5000);

      let content = '';
      let finishReason = null;
      let model = MODEL;
      let usage;
      let id;
      let created;
      try {
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let frame;
            try { frame = JSON.parse(payload); } catch { continue; } // partial frame — next read completes it
            const choice = frame.choices?.[0];
            if (choice?.delta?.content) content += choice.delta.content;
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            // Trailing frames carry the totals; keep the last non-empty value of each.
            if (frame.usage) usage = frame.usage;
            if (frame.model) model = frame.model;
            if (frame.id) id = frame.id;
            if (frame.created) created = frame.created;
          }
        }
      } catch (err) {
        // Headers are already sent, so we can't switch to an error status — return the failure in
        // the body's shape instead. requesty.js surfaces an empty completion as "empty response".
        clearInterval(keepAlive);
        controller.enqueue(enc.encode(JSON.stringify({ error: `AI stream failed: ${err.message}` })));
        controller.close();
        return;
      }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(JSON.stringify({
        choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
        model,
        object: 'chat.completion',
        ...(id ? { id } : {}),
        ...(created ? { created } : {}),
        ...(usage ? { usage } : {}),
      })));
      controller.close();
    },
  });
  return new Response(out, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
}
