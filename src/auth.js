// Google SSO via Supabase (main process). Optional: no login = local-only as before.
// Login flow = system browser + custom protocol deep link (yourcallai://auth).
// SUPABASE_URL/ANON_KEY are baked in at build (webpack DefinePlugin); dev falls back to .env.
const { app, shell, BrowserWindow } = require('electron');
const path = require('path');
const { JsonFile } = require('./jsonFile');
const { loadEnvFile } = require('./settingsStore');

/* global BUILD_SUPABASE_URL, BUILD_SUPABASE_ANON_KEY */
function cfg(k, buildVal) {
  if (typeof buildVal !== 'undefined' && buildVal) return buildVal;
  return process.env[k] || loadEnvFile()[k] || '';
}
const SUPABASE_URL = cfg('SUPABASE_URL', typeof BUILD_SUPABASE_URL !== 'undefined' ? BUILD_SUPABASE_URL : '');
const SUPABASE_ANON_KEY = cfg('SUPABASE_ANON_KEY', typeof BUILD_SUPABASE_ANON_KEY !== 'undefined' ? BUILD_SUPABASE_ANON_KEY : '');
const PROTOCOL = 'yourcallai';
const REDIRECT_TO = `${PROTOCOL}://auth`;

const enabled = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let client = null;
let currentUser = null;
let sessionFile = null;

function getSessionFile() {
  if (!sessionFile) sessionFile = new JsonFile(path.join(app.getPath('userData'), 'auth-session.json'), {});
  return sessionFile;
}

// Lazy singleton. persistSession:false — we persist tokens ourselves to auth-session.json,
// since there's no browser localStorage in the main process.
function getClient() {
  if (!enabled()) return null;
  if (!client) {
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    });
    client.auth.onAuthStateChange((_event, session) => {
      currentUser = session?.user || null;
      if (session) persistSession(session);
    });
  }
  return client;
}

async function persistSession(session) {
  await getSessionFile().update(() => ({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })).catch((e) => console.warn('[auth] persist failed:', e.message));
}

function emitAuthChanged() {
  const payload = getUser();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('auth-changed', payload);
  }
}

function emitSyncStatus(state) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('sync-status', { state });
  }
}

// Run the login/startup full-sync and broadcast its status to the UI (yellow→green/red).
async function syncWithStatus(reason) {
  emitSyncStatus('syncing');
  try { await require('./sync').fullSync(); emitSyncStatus('synced'); }
  catch (e) { emitSyncStatus('error'); console.warn(`[auth] ${reason} sync:`, e.message); }
}

// Restore a saved session on app start (no-op if none / disabled). Returns true if signed in.
async function restore() {
  const sb = getClient();
  if (!sb) return false;
  const saved = await getSessionFile().read();
  if (!saved.access_token || !saved.refresh_token) return false;
  const { data, error } = await sb.auth.setSession({
    access_token: saved.access_token,
    refresh_token: saved.refresh_token,
  });
  if (error) { console.warn('[auth] restore failed:', error.message); return false; }
  currentUser = data.user || null;
  return !!currentUser;
}

async function signIn() {
  const sb = getClient();
  if (!sb) return { ok: false, error: 'Sign-in not configured' };
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: REDIRECT_TO, skipBrowserRedirect: true },
  });
  if (error) return { ok: false, error: error.message };
  await shell.openExternal(data.url); // opens the system browser
  return { ok: true };
}

async function signOut() {
  const sb = getClient();
  if (sb) await sb.auth.signOut().catch(() => {});
  currentUser = null;
  await getSessionFile().update(() => ({})).catch(() => {});
  emitAuthChanged();
  return { ok: true };
}

// Handle the yourcallai://auth?code=... deep link. Exchanges code → session, then full-syncs.
async function handleDeepLink(url) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return;
  const sb = getClient();
  if (!sb) return;
  let code;
  try { code = new URL(url).searchParams.get('code'); } catch { return; }
  if (!code) return;
  const { data, error } = await sb.auth.exchangeCodeForSession(code);
  if (error) { console.error('[auth] code exchange failed:', error.message); return; }
  currentUser = data.user || null;
  emitAuthChanged();
  await syncWithStatus('post-login');
}

function getUser() {
  if (!currentUser) return null;
  return { id: currentUser.id, email: currentUser.email, name: currentUser.user_metadata?.full_name, avatar: currentUser.user_metadata?.avatar_url };
}

// Register the protocol + restore any saved session; called from app-ready. Deep-link
// argv/open-url wiring stays in main.js (it owns the single-instance lock).
async function init() {
  if (!enabled()) return false;
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
  const authed = await restore();
  if (authed) { emitAuthChanged(); await syncWithStatus('startup'); }
  return authed;
}

module.exports = { enabled, getClient, getUser, signIn, signOut, init, handleDeepLink, PROTOCOL };
