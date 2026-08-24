// Asana helpers. All return { ok, ... } | { ok:false, error } and never throw.
// Per-user OAuth (same shape as slack.js): each user connects their own Asana account and
// tasks are created as them. We hold their access + refresh token locally and pass the
// access token to the proxy per call.
// Divergence from Slack: Asana access tokens expire in ~1h, so every call goes through
// validToken(), which refreshes via the backend (client_secret stays server-side) when the
// stored token is within 60s of expiry. Granular OAuth scopes (see SCOPES below) — NOT Asana's
// "Full permissions" mode, which forbids requesting individual scopes.
const path = require('path');
const crypto = require('crypto');
const { app, shell, BrowserWindow } = require('electron');
const { JsonFile } = require('../jsonFile');
const { proxyPost, PROXY_URL, asanaClientId } = require('../proxy');

const PROTOCOL = 'yourcallai';
const REDIRECT_URI = `${PROXY_URL}/api/asana/oauth-callback`;

// Space-delimited granular scopes, one per API call we make: /workspaces, /workspaces/*/projects,
// /workspaces/*/users, POST /tasks. This list MUST match the allowlist registered under
// OAuth > Permission scopes in the Asana developer console (Full permissions OFF) — requesting
// an unregistered scope fails the authorize page with forbidden_scopes. Adding one means updating
// BOTH places, and every connected user must Disconnect → Connect (tokens are frozen to the
// scopes granted at authorization, and re-auth is not additive).
// Deliberately absent: `teams:read` — we request opt_fields=team.name on projects, but `name` is
// one of the related-object fields Asana serves without an extra scope. `tasks:read` — createTask
// reads gid off its own POST response, which is the created resource, not a read (scopes are not
// hierarchical: write does not imply read).
const SCOPES = 'workspaces:read projects:read users:read tasks:write';

// Persistent cache of workspace/project/user lists, keyed by workspace where relevant.
// On a failed live fetch we serve the last good list instead of blanking the panel.
let cacheFile;
const cache = () => (cacheFile ||= new JsonFile(path.join(app.getPath('userData'), 'asana-cache.json'), {}));

// The connected user's Asana session { token, refreshToken, expiresAt, user }.
let sessionFile;
const session = () => (sessionFile ||= new JsonFile(path.join(app.getPath('userData'), 'asana-session.json'), {}));

let pendingState = null; // in-memory CSRF state for the current connect() attempt

// ---- token lifecycle ----

let refreshing = null; // in-flight refresh, shared so a burst of calls triggers one refresh

// Refresh the access token via the backend and persist it. Serialized: concurrent callers
// await the same promise rather than each spending the refresh token.
function refreshToken(rt) {
  refreshing ||= (async () => {
    try {
      const res = await proxyPost('/api/asana/oauth-refresh', { refreshToken: rt });
      const d = await res.json();
      if (!d.ok || !d.token) return null;
      await session().update((cur) => { cur.token = d.token; cur.expiresAt = d.expiresAt || 0; });
      return d.token;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

const NOT_CONNECTED = 'Asana not connected';
const EXPIRED = 'Asana session expired — reconnect in Settings.';

// The access token to use right now, refreshed if it's expired or about to be.
// Returns { token } on success or { error } — a failed refresh must NOT report
// "not connected" (the user IS connected; their session went stale and needs reconnecting).
async function validToken() {
  const s = await session().read();
  if (!s.token) return { error: NOT_CONNECTED };
  // 60s skew margin so a token doesn't expire mid-request.
  if (s.expiresAt && s.expiresAt - Date.now() > 60_000) return { token: s.token };
  if (!s.refreshToken) return { token: s.token }; // nothing to refresh with; let the 401 path report it
  const fresh = await refreshToken(s.refreshToken);
  return fresh ? { token: fresh } : { error: EXPIRED };
}

// ---- REST plumbing ----

// One Asana call through the proxy. On 401 (token rejected despite our expiry check —
// revoked, or clock skew) we force one refresh and retry exactly once.
async function asanaApi(pathname, { method = 'GET', body } = {}, retried = false) {
  const { token, error } = await validToken();
  if (!token) return { ok: false, error };
  try {
    const res = await proxyPost('/api/asana', { pathname, method, body, token }, { signal: AbortSignal.timeout(15000) });
    const out = await res.json().catch(() => ({ ok: false, error: `Asana ${res.status}` }));
    if (out.status === 401) {
      // Token rejected despite the expiry check (revoked, or clock skew) — refresh once, retry once.
      const s = await session().read();
      if (!retried && s.refreshToken && await refreshToken(s.refreshToken)) {
        return asanaApi(pathname, { method, body }, true);
      }
      return { ok: false, error: EXPIRED };
    }
    return out; // proxy already returns { ok, status, body } | { ok:false, error }
  } catch (err) {
    return { ok: false, error: `Asana request failed: ${err.message}` };
  }
}

// On a failed live fetch, serve the last cached list if we have one. `key` may be nested
// per-workspace (e.g. projects.<gid>), so read via the resolver.
async function fallbackList(read, outKey, failure) {
  const cached = await read();
  if (cached?.length) return { ok: true, [outKey]: cached, stale: true };
  return failure;
}

// Walk Asana's offset pagination, collecting .data from every page. Asana returns
// next_page.offset until the last page, where next_page is null.
async function paginate(basePath, params = {}) {
  const all = [];
  let offset;
  do {
    const qs = new URLSearchParams({ limit: '100', ...params, ...(offset ? { offset } : {}) });
    const page = await asanaApi(`${basePath}?${qs}`);
    if (!page.ok) return { ok: false, error: page.error };
    all.push(...(page.body?.data || []));
    offset = page.body?.next_page?.offset;
  } while (offset);
  return { ok: true, data: all };
}

// ---- public API (task creation only — no summary/transcript export to Asana) ----

async function listWorkspaces() {
  const res = await paginate('/workspaces', { opt_fields: 'name' });
  if (!res.ok) return fallbackList(async () => (await cache().read()).workspaces, 'workspaces', res);
  const workspaces = res.data.map((w) => ({ gid: w.gid, name: w.name }));
  await cache().update((d) => { d.workspaces = workspaces; });
  return { ok: true, workspaces };
}

async function listProjects(workspaceGid) {
  if (!workspaceGid) return { ok: false, error: 'Pick an Asana workspace first.' };
  const res = await paginate(`/workspaces/${encodeURIComponent(workspaceGid)}/projects`, {
    opt_fields: 'name,team.name,permalink_url',
    archived: 'false',
  });
  const cached = async () => ((await cache().read()).projects || {})[workspaceGid];
  if (!res.ok) return fallbackList(cached, 'projects', res);
  const projects = res.data.map((p) => ({
    id: p.gid,
    name: p.name,
    team: p.team?.name || 'No team',
    url: p.permalink_url || '',
  }));
  projects.sort((a, b) => a.name.localeCompare(b.name));
  await cache().update((d) => { (d.projects ||= {})[workspaceGid] = projects; });
  return { ok: true, projects };
}

async function listUsers(workspaceGid) {
  if (!workspaceGid) return { ok: false, error: 'Pick an Asana workspace first.' };
  const res = await paginate(`/workspaces/${encodeURIComponent(workspaceGid)}/users`, { opt_fields: 'name,email' });
  const cached = async () => ((await cache().read()).users || {})[workspaceGid];
  if (!res.ok) return fallbackList(cached, 'users', res);
  const users = res.data.map((u) => ({ gid: u.gid, name: u.name || u.email || u.gid, email: u.email || '' }));
  users.sort((a, b) => a.name.localeCompare(b.name));
  await cache().update((d) => { (d.users ||= {})[workspaceGid] = users; });
  return { ok: true, users };
}

// Create one task in a project. dueDate is only forwarded when it's a real ISO date —
// the AI-extracted value is free text and Asana 400s on anything else.
async function createTask(projectGid, { title, assigneeGid, dueDate, description } = {}) {
  if (!title) return { ok: false, error: 'Task title is required.' };
  if (!projectGid) return { ok: false, error: 'Pick an Asana project first.' };
  const data = {
    name: title,
    projects: [String(projectGid)],
    notes: description || '',
    ...(assigneeGid ? { assignee: String(assigneeGid) } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(dueDate || '') ? { due_on: dueDate } : {}),
  };
  const res = await asanaApi('/tasks', { method: 'POST', body: { data } });
  if (!res.ok) return res;
  const t = res.body?.data || {};
  return { ok: true, task: { gid: t.gid, url: t.permalink_url || '' } };
}

// ---- Per-user OAuth connect / disconnect ----

function emitChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('asana-changed');
  }
}

// Open the Asana authorize page in the system browser. Asana -> Vercel callback -> yourcallai://asana.
async function connect() {
  const clientId = asanaClientId();
  if (!clientId) return { ok: false, error: 'Asana OAuth not configured.' };
  pendingState = crypto.randomBytes(16).toString('hex');
  // scope is appended separately: URLSearchParams form-encodes spaces as '+', but Asana's docs
  // call for %20 ("spaces become %20"), so encode it with encodeURIComponent instead of gambling
  // on their parser accepting '+'.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code', // required by Asana (Slack's authorize URL omits it)
    state: pendingState,
  });
  const url = `https://app.asana.com/-/oauth_authorize?${params}&scope=${encodeURIComponent(SCOPES)}`;
  await shell.openExternal(url);
  return { ok: true };
}

// Handle yourcallai://asana?code=<otc>&state=... — redeem the OTC for the real token pair.
async function handleDeepLink(url) {
  let params;
  try { params = new URL(url).searchParams; } catch { return; }
  if (params.get('error')) { console.warn('[asana] connect failed:', params.get('error')); emitChanged(); return; }
  if (!pendingState || params.get('state') !== pendingState) { console.warn('[asana] state mismatch'); return; }
  pendingState = null;
  const otc = params.get('code');
  if (!otc) return;
  try {
    const res = await proxyPost('/api/asana/oauth-redeem', { code: otc });
    const data = await res.json();
    if (!data.ok || !data.token) { console.warn('[asana] redeem failed:', data.error); emitChanged(); return; }
    await session().update(() => ({
      token: data.token,
      refreshToken: data.refreshToken || '',
      expiresAt: data.expiresAt || 0,
      user: data.user || null,
    }));
    await cache().update(() => ({})); // drop the previous account's workspace/project lists
    emitChanged();
  } catch (err) {
    console.warn('[asana] redeem error:', err.message);
    emitChanged();
  }
}

async function isConnected() {
  const s = await session().read();
  return { connected: !!s.token, user: s.user?.name || s.user?.email || '' };
}

async function disconnect() {
  await session().update(() => ({}));
  await cache().update(() => ({}));
  emitChanged();
  return { ok: true };
  // ponytail: local forget only; Asana has a token revoke endpoint if server-side revoke is ever required.
}

module.exports = {
  listWorkspaces, listProjects, listUsers, createTask,
  connect, handleDeepLink, isConnected, disconnect, PROTOCOL,
};
