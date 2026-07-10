// Shared requesty.ai client (OpenAI-compatible). Key and base URL read at call time.
const MODEL = 'google/gemma-4-31b-it';

// Returns the full completion text. With onDelta, streams and calls onDelta(chunkText).
async function chatCompletion(messages, { onDelta, temperature = 0.3 } = {}) {
  const base = process.env.REQUESTY_BASE_URL || 'https://router.requesty.ai/v1';
  const key = process.env.REQUESTY_API_KEY;
  if (!key) throw new Error('REQUESTY_API_KEY not configured');

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature, stream: !!onDelta }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI request failed (${res.status}): ${body.slice(0, 200)}`);
  }

  if (!onDelta) {
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  }

  // SSE stream parse
  let full = '';
  let buf = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
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
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* partial frame */ }
    }
  }
  return full;
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

module.exports = { chatCompletion, parseLooseJson, MODEL };
