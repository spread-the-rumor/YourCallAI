// POST /api/ai — proxy Requesty (OpenAI-compatible) chat completions. Edge runtime so we can
// pipe the upstream SSE stream straight to the client. Injects the key server-side.
export const config = { runtime: 'edge' };

const MODEL = 'google/gemma-4-31b-it';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const key = process.env.REQUESTY_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: 'AI not configured on server.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const base = process.env.REQUESTY_BASE_URL || 'https://router.requesty.ai/v1';
  const { messages, temperature = 0.3, stream = false } = await req.json();

  // Always ask upstream to stream, even when the client wants a single JSON body.
  // The Edge runtime kills an invocation that produces no bytes for ~25s, and that timer is on
  // time-to-first-byte, not total duration: a buffered request for a long completion 504s
  // (FUNCTION_INVOCATION_TIMEOUT) while the identical streamed one survives well past it.
  // maxDuration is not an option — it doesn't apply to Edge functions. So we stream from upstream
  // unconditionally and, for non-streaming callers, reassemble the frames below.
  const upstream = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature, stream: true }),
  });

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

  // Non-stream: consume the SSE frames and hand back one assembled completion, byte-identical in
  // shape to what upstream would have returned unstreamed — src/ai/requesty.js reads
  // choices[0].message.content either way, so no client change is needed.
  let content = '';
  let finishReason = null;
  let model = MODEL;
  let usage;
  let id;
  let created;

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
      try { frame = JSON.parse(payload); } catch { continue; } // partial frame — the next read completes it
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

  const body = {
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
    model,
    object: 'chat.completion',
    ...(id ? { id } : {}),
    ...(created ? { created } : {}),
    ...(usage ? { usage } : {}),
  };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
