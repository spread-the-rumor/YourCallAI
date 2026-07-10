// Settings (§4.5): settings.json in userData. All SECRET keys now live on the Vercel
// backend — the client stores only non-secret local prefs. Feature availability comes
// from GET /api/config (booleans only), cached to config-cache.json for offline start.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { JsonFile } = require('./jsonFile');
const { PROXY_URL } = require('./proxy');

// Only non-secret, machine-local preferences live here now.
const KEYS = [
  'USER_DISPLAY_NAME',
  'AUTO_DELETE_DAYS',
];

const VERCEL_URL = PROXY_URL;

// ponytail: 8-line .env parser instead of dotenv — swap in dotenv if quoting/expansion ever matters
let envDefaults = null;
function loadEnvFile(file) {
  if (envDefaults) return envDefaults;
  envDefaults = {};
  try {
    for (const line of fs.readFileSync(file || path.join(app.getAppPath(), '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) envDefaults[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); // comment lines never match

    }
  } catch { /* no .env — fine, keys come from Settings/Vercel */ }
  return envDefaults;
}

let settingsFile, cacheFile;
function files() {
  if (!settingsFile) {
    settingsFile = new JsonFile(path.join(app.getPath('userData'), 'settings.json'), {});
    cacheFile = new JsonFile(path.join(app.getPath('userData'), 'config-cache.json'), {});
  }
  return { settingsFile, cacheFile };
}

async function getSettings() {
  const s = await files().settingsFile.read();
  const out = {};
  for (const k of KEYS) out[k] = s[k] || '';
  return out;
}

async function saveSettings(patch) {
  const clean = {};
  for (const k of KEYS) if (k in patch) clean[k] = String(patch[k] || '').trim();
  await files().settingsFile.update((data) => Object.assign(data, clean));
  await applyToEnv();
  return getSettings();
}

// Fetch which integrations the backend has configured; cache for offline start.
async function fetchTeamDefaults() {
  if (!VERCEL_URL) return;
  try {
    const res = await fetch(`${VERCEL_URL}/api/config`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const cfg = await res.json(); // { enabled: {...} }
    await files().cacheFile.update(() => cfg);
    await applyToEnv();
  } catch (e) {
    console.warn('[config] backend config fetch failed (using cache):', e.message);
  }
}

async function getEffectiveConfig() {
  const user = await getSettings();
  const merged = { ...loadEnvFile() };
  for (const k of KEYS) if (user[k]) merged[k] = user[k];
  if (!merged.USER_DISPLAY_NAME) merged.USER_DISPLAY_NAME = 'You';
  return merged;
}

// Renderer-safe view: which features the backend supports + local prefs. No secrets anywhere.
async function getConfiguredFlags() {
  const c = await getEffectiveConfig();
  const enabled = (await files().cacheFile.read()).enabled || {};
  return {
    deepgram: !!enabled.deepgram,
    requesty: !!enabled.requesty,
    slack: !!enabled.slack,
    getoverview: !!enabled.getoverview,
    userDisplayName: c.USER_DISPLAY_NAME,
    autoDeleteDays: Number(c.AUTO_DELETE_DAYS) || 0,
  };
}

// Only the two local prefs go to process.env (USER_DISPLAY_NAME read in transcribe.js).
async function applyToEnv() {
  const c = await getEffectiveConfig();
  for (const [k, v] of Object.entries(loadEnvFile())) {
    if (!KEYS.includes(k)) process.env[k] = v; // dev-only extras like VERCEL_BACKEND_URL
  }
  for (const k of KEYS) {
    if (c[k]) process.env[k] = c[k];
    else delete process.env[k];
  }
}

module.exports = { KEYS, getSettings, saveSettings, fetchTeamDefaults, getEffectiveConfig, getConfiguredFlags, applyToEnv, loadEnvFile };
