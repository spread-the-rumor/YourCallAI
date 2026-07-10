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

  const upstream = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature, stream }),
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
  // Non-stream: forward the JSON.
  return new Response(upstream.body, { headers: { 'Content-Type': 'application/json' } });
}
