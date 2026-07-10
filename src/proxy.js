// Central proxy config for the Electron app. All external API keys live on the Vercel
// backend; the app only knows the backend URL (baked in at build time).
// eslint-disable-next-line no-undef
const PROXY_URL = (typeof BUILD_VERCEL_BACKEND_URL !== 'undefined' && BUILD_VERCEL_BACKEND_URL)
  || process.env.VERCEL_BACKEND_URL // dev: settable via .env for `vercel dev`
  || 'https://your-call-ai.vercel.app';

// POST JSON to a proxy route. Returns the fetch Response (caller reads json/stream).
function proxyPost(pathname, body, extra = {}) {
  return fetch(`${PROXY_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...extra,
  });
}

module.exports = { PROXY_URL, proxyPost };
