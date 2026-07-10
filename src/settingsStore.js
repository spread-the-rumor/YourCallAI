// Settings (§4.5): settings.json in userData; optional Vercel team defaults cached
// to config-cache.json. Effective config = .env (dev) < Vercel defaults < user overrides.
// Keys are pushed into process.env so every module reads them AT CALL TIME.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { JsonFile } = require('./jsonFile');

const KEYS = [
  'DEEPGRAM_API_KEY',
  'REQUESTY_API_KEY',
  'Bot_User_OAuth_Token',
  'GetOverview_BASE_URL',
  'GetOverview_Access_Token',
  'USER_DISPLAY_NAME',
  'AUTO_DELETE_DAYS',
];

// eslint-disable-next-line no-undef
const VERCEL_URL = typeof BUILD_VERCEL_BACKEND_URL !== 'undefined' ? BUILD_VERCEL_BACKEND_URL : '';

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

async function fetchTeamDefaults() {
  if (!VERCEL_URL) return;
  try {
    const res = await fetch(`${VERCEL_URL}/api/config`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const cfg = await res.json();
    await files().cacheFile.update(() => cfg);
  } catch (e) {
    console.warn('[config] team defaults fetch failed (using cache):', e.message);
  }
}

async function getEffectiveConfig() {
  const defaults = await files().cacheFile.read();
  const user = await getSettings();
  const merged = { ...loadEnvFile(), ...defaults };
  for (const k of KEYS) if (user[k]) merged[k] = user[k];
  if (!merged.USER_DISPLAY_NAME) merged.USER_DISPLAY_NAME = 'You';
  return merged;
}

// Renderer-safe view: which features are configured, without leaking key values.
async function getConfiguredFlags() {
  const c = await getEffectiveConfig();
  return {
    deepgram: !!c.DEEPGRAM_API_KEY,
    requesty: !!c.REQUESTY_API_KEY,
    slack: !!c.Bot_User_OAuth_Token,
    getoverview: !!(c.GetOverview_BASE_URL && c.GetOverview_Access_Token),
    userDisplayName: c.USER_DISPLAY_NAME,
    autoDeleteDays: Number(c.AUTO_DELETE_DAYS) || 0,
  };
}

async function applyToEnv() {
  const c = await getEffectiveConfig();
  // .env entries outside KEYS (e.g. REQUESTY_BASE_URL) go straight to env
  for (const [k, v] of Object.entries(loadEnvFile())) {
    if (!KEYS.includes(k)) process.env[k] = v;
  }
  for (const k of KEYS) {
    if (c[k]) process.env[k] = c[k];
    else delete process.env[k];
  }
}

module.exports = { KEYS, getSettings, saveSettings, fetchTeamDefaults, getEffectiveConfig, getConfiguredFlags, applyToEnv, loadEnvFile };
