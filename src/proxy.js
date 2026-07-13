// Central proxy config for the Electron app. All external API keys live on the Vercel
// backend; the app only knows the backend URL + a shared app token (baked in at build time).
// Values resolve build-time (DefinePlugin) → process.env → .env file, read at ACCESS time —
// NOT at module load. proxy.js is required before app.whenReady()/applyToEnv() runs, so a
// module-load const would freeze to '' before .env is loaded (mirrors auth.js's cfg()).
/* global BUILD_VERCEL_BACKEND_URL, BUILD_APP_PROXY_TOKEN, BUILD_SLACK_CLIENT_ID */

// Lazy require: settingsStore requires proxy back (circular), so importing loadEnvFile at
// top-level would get a half-initialized module. Requiring it inside cfg() defers past load.
function cfg(buildVal, key, fallback = '') {
  if (typeof buildVal !== 'undefined' && buildVal) return buildVal;
  return process.env[key] || require('./settingsStore').loadEnvFile()[key] || fallback;
}

// PROXY_URL keeps a hardcoded fallback and never needs loadEnvFile, so it stays a plain
// load-time const — avoids triggering the settingsStore cycle during proxy.js load.
// eslint-disable-next-line no-undef
const PROXY_URL = (typeof BUILD_VERCEL_BACKEND_URL !== 'undefined' && BUILD_VERCEL_BACKEND_URL)
  || process.env.VERCEL_BACKEND_URL
  || 'https://your-call-ai.vercel.app';
// Shared secret that gates the proxy (server checks x-app-token). Ships in the client build;
// its job is to keep random callers of the URL out, not users. Read fresh (see note above).
// eslint-disable-next-line no-undef
const appProxyToken = () => cfg(typeof BUILD_APP_PROXY_TOKEN !== 'undefined' ? BUILD_APP_PROXY_TOKEN : '', 'APP_PROXY_TOKEN');
// Slack OAuth client id — public by design (rides in the authorize URL). Read fresh.
// eslint-disable-next-line no-undef
const slackClientId = () => cfg(typeof BUILD_SLACK_CLIENT_ID !== 'undefined' ? BUILD_SLACK_CLIENT_ID : '', 'SLACK_CLIENT_ID');

// POST JSON to a proxy route. Returns the fetch Response (caller reads json/stream).
function proxyPost(pathname, body, extra = {}) {
  const { headers, ...rest } = extra;
  return fetch(`${PROXY_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-token': appProxyToken(), ...headers },
    body: JSON.stringify(body),
    ...rest,
  });
}

module.exports = { PROXY_URL, appProxyToken, slackClientId, proxyPost };
