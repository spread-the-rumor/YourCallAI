# Your Call AI — Project Guide

Local-first Electron meeting notetaker: records screen + meeting audio, transcribes (Deepgram),
resolves speaker names, AI summaries (Requesty/LLM), and sends summaries to Slack / GetOverview.

## Architecture

- **Electron app** (`src/`) holds **no API keys**. All third-party secrets live on a **Vercel
  serverless backend** (`api/`, base `https://your-call-ai.vercel.app`). The app calls proxy
  routes; the backend injects the secret server-side.
- **Supabase** provides Google SSO + per-user meeting sync (`src/auth.js`, `src/sync.js`).
- Recordings stay local; meeting metadata/transcripts sync per user (last-write-wins).

### Key client files
- `src/main.js` — Electron main; IPC handlers; deep-link routing; app lifecycle.
- `src/preload.js` — contextBridge `window.api` (invoke/on wrappers).
- `src/proxy.js` — `PROXY_URL` + `proxyPost()`; resolves build/env/.env values (see Config).
- `src/settingsStore.js` — local prefs + `/api/config` feature flags; `loadEnvFile()`, `applyToEnv()`.
- `src/integrations/slack.js` — Slack client (OAuth + send). `src/integrations/getoverview.js`.
- `src/renderer/{index.html,renderer.js,styles.css}` — UI.
- `src/jsonFile.js` — atomic JSON persistence (used for all local state files).

### Backend routes (`api/`)
- `api/_shared.js` — `json`, `readJson`, `env`, `requireAppToken`, `redisClient`.
- `api/slack.js` — proxy to Slack Web API; per-request user token; method allowlist; app-token gated.
- `api/slack/oauth-callback.js`, `api/slack/oauth-redeem.js` — Slack OAuth (see below).
- `api/config.js` — `{enabled:{deepgram,requesty,slack,getoverview}}` booleans only.
- `api/ai.js`, `api/transcribe*.js`, `api/blob-upload.js`, `api/getoverview.js`.

## Config / secrets — where things live

| Value | Location | Notes |
|---|---|---|
| Slack `client_secret`, Deepgram/Requesty/GetOverview keys, Upstash + Vercel tokens | Vercel env only | Never on client, never in git/installer |
| `SLACK_CLIENT_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Vercel + GitHub secret + baked into installer + local `.env` | Public by design |
| `APP_PROXY_TOKEN` | same as above | Shared proxy gate (low-value); baked in — extractable. Rotate if abused. Consider replacing with per-user Supabase-JWT auth. |
| Slack user token (`xoxp-`), Google/Supabase session | User's machine only (`userData/*.json`) | Plaintext on disk, per-user, never centralized |
| Slack OTC | Upstash Redis via Vercel, 120s TTL, single-use | Ephemeral |

- **Build-time bake:** `webpack.main.config.js` DefinePlugin injects `BUILD_VERCEL_BACKEND_URL`,
  `BUILD_SUPABASE_URL`, `BUILD_SUPABASE_ANON_KEY`, `BUILD_APP_PROXY_TOKEN`, `BUILD_SLACK_CLIENT_ID`
  from `process.env` (GitHub Actions secrets in CI).
- **Dev resolution:** `src/proxy.js` and `src/auth.js` resolve values `build → process.env →
  loadEnvFile()` at **access time** (NOT module-load — `.env` is only in `process.env` after
  `applyToEnv()` runs in `app.whenReady()`). `proxy.js` lazily `require`s `settingsStore` inside
  `cfg()` to avoid a circular-require. `PROXY_URL` keeps a hardcoded fallback.
- **`.env`** (dev, gitignored) holds all of the above plus dev-only keys. `loadEnvFile()` is an
  8-line parser that trims spaces and strips quotes.

## Per-user "Connect to Slack" OAuth (main feature built)

Replaced the old single shared bot token (`Bot_User_OAuth_Token`, kept only as optional server
fallback) with **per-user OAuth**: each user connects their own workspace and posts **as themselves**.

**Flow:**
1. Settings → "Connect to Slack" → `slack.connect()` builds the authorize URL (user_scope + random
   `state` for CSRF) → `shell.openExternal`.
2. Slack → `GET /api/slack/oauth-callback` → exchanges code at `oauth.v2.access` (with
   `client_secret`, server-side) → gets `authed_user.access_token` (`xoxp-`) → stores it in Upstash
   under a random **one-time code (OTC)**, 120s TTL → `302 yourcallai://slack?code=<otc>&state=`.
3. OS deep-link → `main.js` routes `yourcallai://slack` to `slack.handleDeepLink` (else Supabase
   auth) → verifies `state` → `POST /api/slack/oauth-redeem {code}` over HTTPS → backend returns the
   token and **deletes the OTC** (single-use) → token saved to `slack-session.json` → `slack-changed`
   emitted → renderer refreshes.
- **Security:** real token never rides the deep link (only the single-use OTC does); CSRF via
  `state`; token stored locally, never synced.

**Client API:** `connect()`, `handleDeepLink()`, `isConnected()`, `disconnect()`,
`listSlackChannels()`, `listSlackUsers()`, `sendToSlack()`. IPC: `slack-connect/-disconnect/-status`,
`onSlackChanged`. Settings UI: `#slack-block` in `index.html`; `renderSlack()` in `renderer.js`.

**Send targets** (meeting Slack panel): channels + people in a `<select>`. `sendToSlack({type,id})`
opens a DM (`conversations.open`) for users, then `chat.postMessage` (`unfurl_links:false`). User
tokens can't auto-join, so `not_in_channel` → clear error (no `conversations.join`).

**External (Slack Connect) support:**
- Channels: external/shared channels appear via `users.conversations` (they're private); labeled
  `#name (external)` when `is_ext_shared`/`is_shared`.
- People: external DM contacts aren't in `users.list`. `listSlackUsers` also enumerates
  `users.conversations types:im` (needs `im:read`), resolves unknown partners via `users.info`
  (cached in `slack-cache.json` `dmNames`, so one call per external ever), shown in an
  "External people" optgroup.

## Slack app config (api.slack.com) — required setup

- **Redirect URL:** `https://your-call-ai.vercel.app/api/slack/oauth-callback` (must match exactly).
- **User Token Scopes:** `chat:write, channels:read, groups:read, users:read, im:write, mpim:read, im:read`.
- App must be **distributed** (public) so users outside your workspace can authorize.
- Adding a scope requires updating BOTH the dashboard AND `USER_SCOPES` in `slack.js`, and every
  connected user must **Disconnect → Connect** to mint a token with the new scope.
- **Proxy method allowlist** (`api/slack.js`): `users.conversations, conversations.open, users.list,
  users.info, chat.postMessage`.

## Vercel env vars required

`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `APP_PROXY_TOKEN`, Upstash Redis
(`SLACK_KV_REST_API_URL` / `SLACK_KV_REST_API_TOKEN` — code also accepts `KV_REST_API_*` /
`UPSTASH_REDIS_REST_*`), plus the transcription/AI keys. GitHub Actions secrets (for the installer
build): `SLACK_CLIENT_ID`, `APP_PROXY_TOKEN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VERCEL_*`.

## Build / release / deploy

- **Ship:** `npm run ship -- "<msg>" <patch|minor|major>` (or `/ship`) — commits, bumps version,
  tags `vX.Y.Z`, pushes → triggers `.github/workflows/release.yml`.
- **release.yml:** builds Windows + macOS installers → **draft** GitHub Release; separate `deploy-api`
  job runs `vercel deploy --prod`. Also runs on `workflow_dispatch` (re-build without a bump).
- Draft release must be **published manually** (`gh release edit vX.Y.Z --draft=false`).
- **Dev:** `npm start` (electron-forge). Main-process code changes need a **full restart** — kill all
  `electron.exe` and relaunch (single-instance lock can hand off to a stale process; delete
  `.webpack/` for a clean rebuild).

## Debugging history (root causes, so we don't repeat)

Slack per-user OAuth was landed across v2.0.3–v2.0.8. Bugs hit and fixed, in order:
1. **Connect did nothing** — `SLACK_CLIENT_ID` not reaching client + renderer discarded `connect()`
   error. Surface errors in `#slack-status`; add keys to `.env`.
2. **"Slack OAuth not configured"** — `proxy.js` froze config as module-load consts before `.env`
   loaded. Fixed: resolve lazily via `loadEnvFile()` at access time (mirrors `auth.js`).
3. **404 on callback** — routes never deployed (untracked/uncommitted). Fixed by shipping.
4. **`bad_redirect_uri`** — callback used `VERCEL_URL` (per-deployment host) ≠ authorize `redirect_uri`.
   Hardcoded canonical URL.
5. **`Failed to parse URL from /pipeline`** — Upstash client got undefined url/token (env names were
   `SLACK_`-prefixed). Centralized `redisClient()` reading all name variants; honest `store_failed`.
6. **`ratelimited`** — `conversations.list` is hard-throttled for non-Marketplace apps. Switched to
   `users.conversations` (also the correct set for a user token).
7. **`method not allowed: conversations.list`** — stale running Electron process on old bundle. Full
   restart (kill all `electron.exe` + delete `.webpack`).
8. **External channels missing** — **proxy sent params as JSON body**, which Slack read methods
   ignore → `types` dropped → only public channels. Fixed: proxy sends
   `application/x-www-form-urlencoded` via `URLSearchParams` (all our params are flat).

## Known follow-ups / caveats

- `APP_PROXY_TOKEN` is a shared baked secret — anyone unpacking the app can relay traffic through the
  proxy (burns your Deepgram/LLM credits; allowlist limits scope). Upgrade path: gate `/api/*` with
  the user's Supabase JWT (`Authorization: Bearer`) instead — but that would require Google sign-in
  before Slack connect.
- Local token files (`slack-session.json`, `auth-session.json`) are **plaintext** in userData.
  Harden with Electron `safeStorage` (OS keychain) if needed.
- `.vercel/.env.production.local` has a committed `VERCEL_OIDC_TOKEN` — rotate / gitignore.
- Old draft releases v2.0.6 / v2.0.7 linger — safe to delete.
