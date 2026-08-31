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
- `api/asana.js` — proxy to Asana REST API; per-request user token; **path** allowlist; app-token gated.
- `api/asana/oauth-callback.js`, `-redeem.js`, `-refresh.js` — Asana OAuth (see below).
- `api/config.js` — `{enabled:{deepgram,requesty,slack,getoverview,asana}}` booleans only.
- `api/ai.js`, `api/transcribe*.js`, `api/blob-upload.js`, `api/getoverview.js`.

## Config / secrets — where things live

| Value | Location | Notes |
|---|---|---|
| Slack + Asana `client_secret`, Deepgram/Requesty/GetOverview keys, Upstash + Vercel tokens | Vercel env only | Never on client, never in git/installer |
| `SLACK_CLIENT_ID`, `ASANA_CLIENT_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Vercel + GitHub secret + baked into installer + local `.env` | Public by design |
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

## Per-user "Connect to Asana" OAuth (second PM tool)

Same OAuth shape as Slack — authorize in the system browser → Vercel callback exchanges the code
server-side → 120s single-use OTC rides `yourcallai://asana` → app redeems it over HTTPS. Reuses
the same Upstash store (`asana:otc:*`) and the same `yourcallai://` scheme, so **no packaging or
protocol-registration change** was needed; only a new branch in `routeDeepLink` (`src/main.js`).

**Scope of the feature:** Asana is **task-creation only** — no summary/transcript export (that's
GetOverview's job). The meeting send block's Asana panel is: workspace select → project select
(grouped by team) → `⚡ Create tasks from action items`. Action-item rows get an **assignee
`<select>`** of real workspace users (Asana needs a user gid, not a name), pre-selected by
fuzzy-matching the AI-extracted name (exact → first name → email local-part → Unassigned).

**Two things Asana forces that Slack didn't:**
1. **Token expiry.** Access tokens last ~1h and come with a `refresh_token`. `asana-session.json`
   stores `{token, refreshToken, expiresAt, user}`; `validToken()` refreshes via
   `/api/asana/oauth-refresh` when within 60s of expiry, and `asanaApi()` also refreshes+retries
   once on a `401`. Concurrent refreshes are coalesced through one module-level in-flight promise.
   A failed refresh says *"session expired — reconnect"*, **not** *"not connected"* (the user is
   connected; the session went stale). Refreshing needs `client_secret`, hence the backend route.
2. **`response_type=code`** is mandatory in the authorize URL (Slack's omits it).

**Asana app config** (`app.asana.com/0/my-apps`): redirect URL must be exactly
`https://your-call-ai.vercel.app/api/asana/oauth-callback`.

**OAuth scopes — granular, NOT "Full permissions".** Asana apps are in one of two modes, and a
freshly created app is in *neither*, which fails the authorize page with *"Your app does not have
any scopes registered."* We use granular scopes: developer console → **OAuth** → **Permission
scopes**, leave **Full permissions OFF**, check exactly `workspaces:read`, `projects:read`,
`users:read`, `tasks:write`, save. `SCOPES` in `src/integrations/asana.js` must match that list —
requesting an unregistered scope fails with `forbidden_scopes`; conversely, with Full permissions
ON you may NOT request individual scopes (must send `scope=default` or omit it).
- Space-delimited, and appended with `encodeURIComponent` rather than through `URLSearchParams` —
  the latter form-encodes spaces as `+`, while Asana's docs call for `%20`.
- Adding a scope means updating **both** the console and `SCOPES`, and every connected user must
  **Disconnect → Connect**: tokens are frozen to the scopes granted at authorization, and
  re-authorization is **not additive** (the full set must be sent). Same caveat as Slack.
- **Not** needed, so don't add them "just in case": `teams:read` — we request
  `opt_fields=team.name` on projects, and `name` is one of the related-object fields
  (`gid`/`name`/`resource_type`/`resource_subtype`) Asana serves without an extra scope; a
  *non*-default related field would 403 the **whole project list**, not just the label.
  `tasks:read` — `createTask` reads `gid` off its own POST response, which is the created
  resource, not a read (scopes are not hierarchical: `write` does not imply `read`).
**Proxy path allowlist** (`api/asana.js`, method+regex pairs — query strings are stripped before
matching so `opt_fields`/`limit`/`offset` are free): `GET /workspaces`,
`GET /workspaces/{gid}/projects`, `GET /workspaces/{gid}/users`, `POST /tasks`.

**Client API:** `connect()`, `handleDeepLink()`, `isConnected()`, `disconnect()`,
`listWorkspaces()`, `listProjects(wsGid)`, `listUsers(wsGid)`, `createTask(projectGid, {...})`.
IPC: `asana-connect/-disconnect/-status`, `list-asana-workspaces/-projects/-users`,
`create-asana-task`, `onAsanaChanged`. UI: `#asana-block` in `index.html`, `renderAsana()` +
`renderAsanaPanel()` in `renderer.js`.

**Gotchas hit while building it:**
- `due_on` is only sent when the value matches `^\d{4}-\d{2}-\d{2}$` — the AI-extracted date is
  free text and Asana 400s on anything else (e.g. "next Friday").
- Asana wraps request **and** response payloads in `{data: …}`, and is a JSON API — this is the one
  place NOT to copy Slack's `application/x-www-form-urlencoded` body.
- `renderSendBlock()` was a binary if/else; a third destination silently fell through to
  GetOverview. It's now a `SEND_PANELS` map keyed by `data-dest` / `#send-<key>`.
- `renderActionItemRows()` is shared: `opts.users` switches the assignee cell to a `<select>`,
  `opts.onCreate` swaps the create call. Omitting both keeps GetOverview's original behaviour.

## Speaker names (§7) — candidate/evidence model

Names are resolved by `resolveSpeakers()` (`src/speakerResolve.js`, pure) which merges every signal
into one `speakerMap` of `{ name, source, confidence, lockedByUser, sampleText }`, keyed
`"<channel>:<diarizedSpeaker>"`. Sources are applied in descending trust and **each step only
touches labels still unresolved**, so a weaker source can never overwrite a stronger one:

1. **channel 0 → the signed-in user** (0.95). ch0 is the local mic by construction. Name comes from
   `auth.getUser()?.name`, falling back to `USER_DISPLAY_NAME`.
2. **Prior manual renames** (1.0) — the Retry-transcription fix. `speakerMap` used to be
   *write-only*, so every rename was silently destroyed by a re-transcribe.
3. **Native-agent overlap vote** (`src/align.js`, ~0.9) — real names read off the meeting UI.
4. **Roster-constrained AI inference** (`src/ai/inferSpeakerNames.js`, 0.5–0.8).
5. Leftovers keep `Speaker N` and are reported in `nameAttribution.unresolved`.

**Staleness check.** Deepgram's diarized ids are **not stable across runs**, so a lock for `1:3`
from run A may point at a different person in run B. Each manual rename stores a `sampleText` (first
~200 chars that speaker said); on re-apply, a word-overlap mismatch **demotes** the entry to
`prior-manual-stale` at 0.7 (shown as unverified) instead of confidently mislabelling someone.

**Confidence is surfaced.** `< 0.85` renders with a dotted underline and a trailing `?`
(`.speaker.unverified`), tooltip naming the source. A wrong name propagates into the summary, the
action-item `assignee` and the Slack/Asana send, so it must read as a suggestion, not a fact.

**Read-side back-compat is mandatory:** `speakerMap` values were bare strings before this change.
`readSpeakerMap()` accepts a string as `{source:'manual', confidence:1, lockedByUser:true}` — existing
`meetings.json` files and already-synced Supabase rows still hold that shape. `sync.js` stores the
meeting as opaque JSON, so no migration was needed.

### Prompt windowing — the bug that made long meetings unnameable
`transcriptToPrompt` keeps the **last** 48 KB, which is right for summaries (decisions are at the
end) and **wrong for names** (introductions are in the first two minutes). On any meeting past
~45 min the name prompt received exactly the portion containing no introductions.
`transcriptToNamePrompt` (`src/transcriptUtils.js`) instead emits a **name-dense excerpt first**
(intro-cue lines + the first/last two turns of every speaker), then fills head-first and tail-last.
`transcriptToPrompt` is deliberately untouched — `summarize`/`chat`/`extractActionItems`/
`getoverview` all depend on its tail-keeping behaviour.

### The roster is a CLOSED set, not a hint
The old prompt said "Known participants: …" and validated only the *key*, so any hallucinated value
was accepted. Now `parseInferenceResponse` (pure, unit-tested) enforces: name must match the roster
via `matchToRoster`, one person cannot hold two labels, and **the ch0 user can never be a ch1
speaker**. With an *empty* roster it falls back to open-ended inference at ≤0.55 — today's
behaviour, kept as the floor rather than resolving nothing.

`src/roster.js` merges roster sources by confidence. **A `dictionary: true` source may only
canonicalise a name another source already supplied — never introduce one.** That is what keeps the
whole Slack workspace (`listSlackUsers()` returns thousands) out of a 3-person meeting's roster.

### Ground truth: what live Teams actually emits (captured 2026-08-27, via `--dump`)

The heuristics were originally written against *assumptions* about a11y output and every one was
wrong. These are the real strings; `test/selfcheck.js` uses them verbatim as fixtures. **Do not
"simplify" those fixtures** — they are the only evidence the parser is correct.

```
Menu                                            <- container is a MENU, not a List
  MenuItem 'System'                             <- Win32 window menu, NOT a participant
  MenuItem 'Myself video, Sagar, Has control of production tools, Muted, Has context menu'
  MenuItem 'Carlos Brito, Has control of production tools, Context menu is available'
  MenuItem 'SBPM Dev, Has control of production tools, muted, Context menu is available'
Button 'People'                                 <- NO participant count anywhere
Text   'Elapsed time 18:56' / '23:08'           <- false-match hazard for a count regex
MenuItem 'Content shared by Hernan Zapata'      <- contains a name, is not a roster row
```

Four bugs this exposed, all fixed in C#, Swift **and** `src/roster.js` (keep the three in step):
1. **The name is one comma-separated field; the rest is status.** `ROLE_WORDS` only stripped single
   role words, so `", Has control of production tools, Context menu is available"` survived and blew
   the ≤5-token limit — **every real name scored 0.00**. Note Teams prefixes its own tile
   (`Myself video, Sagar, …`), so the name is *not* reliably the first field: take the first field
   that isn't status-clause-shaped.
2. **The container is `Menu`/`MenuItem`, not `List`/`ListItem`.** Accepting only list roles is why
   the roster came back empty. `Menu` and `Group` are now accepted too.
3. **Exact-match denylist for UI artifacts.** `System` and `Workspaces` score **0.85 — identical to
   a real mononym** like `Sagar` or `Nav`, so scoring can never separate them. Whole-string match
   only, so a person named `Nav` is unaffected. A denylist can't be complete, which is why…
4. **An active speaker MUST be on the roster.** A Chrome window's `Workspaces` label was reported as
   the active speaker in a live call. `FindActiveByPhrase` now rejects off-roster names outright
   rather than down-weighting them — a speaker who isn't a participant is a contradiction.

`expectedCount` returns **0 = unknown, never "nobody"**: Teams exposes no count at all. The regex
requires the number *adjacent* to the keyword and excludes clock-shaped values, because a looser
rule read `Elapsed time 18:56` and reported a 5-person call as 18 participants.

### Google Meet exposed the real design flaw: scope, not name-shape

A live 19-minute Meet call (`platform: google-meet`, auto-detected, pipeline `complete`) produced a
roster of **Chrome's toolbar**: `["Back","Forward","Reload","Work","History Navigation","PDF
Creator","Mentions","REPORTS", …]` — 22 entries, another tab's sidebar included. The two real
participants were `Sagar Bansal` and `Vicky Rana`; Vicky never entered the roster at all.

Every junk string scored **0.74–1.00**, i.e. indistinguishable from a real name (`PDF Creator` and
`History Navigation` both score exactly 1.00, same as `Vicky Rana`). **No amount of name-shape
scoring or denylisting can fix this** — the flaw was that the agent walks an entire Chrome window,
where the participants panel is a small region in a tree full of browser chrome and other tabs.

**The damage was in the guard, not the transcript.** The transcript stayed clean (`Sagar Bansal` on
ch0, `Speaker 1` on ch1) — but the polluted roster became a *closed set that excluded the real
participant*, so the correctly-inferred "Vicky Rana" was **rejected by our own anti-hallucination
guard** and she stayed `Speaker 1` for the whole meeting. Junk in the roster caused a guaranteed
miss, which is worse than having no roster.

Fixes, in order of importance:
1. **`LooksInCall()` gate** (`Program.cs` / `main.swift`): a window contributes names only if it has
   a leave/hangup control **plus** another call control (mic/camera/share/participants). Slack's
   formatting toolbar (`Bold`, `Italic`, `Code` — which the agent emitted as a 10-person roster with
   no meeting open at all) and Chrome's toolbar have neither. This is the one place English strings
   are unavoidable; a localized client yields no names and falls back to AI inference.
2. **`rosterIsTrustworthy()`** (`src/roster.js`): an untrustworthy roster is treated as **absent**,
   not as a closed set, so it can never exclude a real person. The measured discriminator is the
   share of **exactly-two-word** names — real Meet 100%, real Teams 60%, the pollution 32%. A plain
   multi-word test does *not* separate them (55% vs 60%).
3. `Group` dropped as a roster container (too generic — Chrome's toolbar qualified); a depth gate
   (`MinWebContentDepth = 6`) separates browser chrome from web content; browser windows additionally
   require multi-word names; and the `tile-grid` fallback now needs the same item-role evidence a
   panel does.

**Verified: Teams desktop (correct roster) and the no-meeting case (zero output).** Zoom and
browser-hosted Teams/Zoom remain unverified. Use `agents/dist/YourCallAgent.exe --dump` *while that
meeting is open* before touching a heuristic — every heuristic written from assumption was wrong.

### Native agent (`agents/windows/Program.cs`, `agents/macos/main.swift`)
Rewritten to match **structure, never English UI strings**:
- **Roster** = the best-scoring sibling group whose children mostly look like people (an accessible
  List/DataGrid, or ≥2 ListItems). Meet/Zoom/Teams all render the participants panel that way, in
  every language. Falls back to the tile grid at 0.75 (Meet's panel is usually *closed*).
- **Active speaker** = **decoration delta**: we already know the clean roster names, so a node
  reading `<known name> + extra` is that person with a status appended. Matching a name *we
  extracted* is immune to localization and to Meet/Teams rewording their status text. The old
  `"<Name> is speaking"` regex is demoted to a last-resort confirmation.
- Dispatch now classifies by **owning process, not window title**, and no longer `return`s after the
  first window — browser-hosted Teams/Zoom had **no branch at all**, and modern Teams titles (no
  "Meeting"/"Call") never matched.
- `personScore()` is a score, not a gate: mononyms and single-initial tokens are accepted
  (common for Meet guests); decorations like `(Guest)`/`(She/Her)`/`, Host` are stripped first.
  Mirrored in three places — C#, Swift, and `src/roster.js` (the JS side re-validates, so it is the
  final safety net). **Keep them in step.**

**`npm run build:agent`** builds the binary locally. It previously existed only in CI, so
`agents/dist` was empty in every dev checkout and Layer 1 **never ran outside a shipped installer**.
Lifecycle events (`{"type":"agent-status","state":"missing-binary"|"started"|…}`) now land in
`speakers.jsonl`, so "found nobody" is distinguishable from "never ran". `<binary> --dump` prints the
raw a11y tree of every candidate window — the instrument for diagnosing a platform whose names stop
resolving. **Windows needs the .NET 8 SDK** (the runtime alone is not enough).

Not built: voice fingerprinting (audio never reaches main as PCM; needs ffmpeg + an embedding model;
solves clustering, not naming; persistent biometric identifiers) and Google Calendar attendees
(sensitive scope, re-consent, Google review, and invited ≠ attended). Slack Huddle has no detection
or agent branch — the manual `start-huddle` button is the only path, though every platform-independent
layer above still improves those recordings.

## Action-item extraction is cached on the meeting

Extraction is a full-transcript AI call (~12s). `renderSendBlock()` rebuilds the panel with
`innerHTML = ''` on every destination switch, so the rows were destroyed and re-extracted each
time a user flipped Slack ↔ Asana ↔ GetOverview (and the two panels have separate `aiBox`es, so
trying both destinations cost two calls minimum).

`extract-action-items` is now a **read-through cache** persisting `actionItems` on the meeting
record, like `summary` and `chat`. `wireActionItems()` (renderer) restores cached rows on wire with
no IPC call; the button then reads **Re-extract** and passes `{force:true}`.

- **Only successes are cached** — caching an `{items:[], error}` would make a transient AI outage
  sticky. An *empty* success **is** cached (`[]` is truthy), so a meeting with genuinely no action
  items doesn't re-run the AI on every visit.
- **Invalidate wherever the transcript changes**: `rename-speaker` (speaker names feed the assignee
  field) and the pipeline's record build (covers Retry transcription). The pipeline sets
  `actionItems: null` **explicitly** — `upsertMeeting` shallow-merges, so omitting it would keep
  the stale value.
- The renderer must also mirror the result onto the in-memory meeting: `current()` reads
  `state.meetings`, which only refreshes on `listMeetings()`, so without that the next rebuild
  would miss the cache and re-run the AI.
- No migration: `store.js` is schema-less and `stripLocal()` only *removes* `LOCAL_FIELDS`, so the
  field syncs to Supabase automatically.
- **Rejected**: extracting from the summary instead. Its `⚡ Action Items` section is strictly
  lossier — restricted to "immediate, tactical tasks assigned to specific people" (strategic items
  go to `🚀 Next Steps`), contradictory rules for owner-less items, free-text dates rather than the
  ISO `due_on` Asana requires, and absent entirely when summarization failed.

## Vercel env vars required

`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET`,
`APP_PROXY_TOKEN`, Upstash Redis
(`SLACK_KV_REST_API_URL` / `SLACK_KV_REST_API_TOKEN` — code also accepts `KV_REST_API_*` /
`UPSTASH_REDIS_REST_*`; the same store holds the `asana:otc:*` keys), plus the transcription/AI
keys. GitHub Actions secrets (for the installer build): `SLACK_CLIENT_ID`, `ASANA_CLIENT_ID`,
`APP_PROXY_TOKEN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VERCEL_*`.

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
9. **`store_failed: fetch failed` on an OAuth callback** — the **Upstash DB was archived for
   inactivity** while its env vars stayed configured. The two Upstash failure modes are
   distinguishable by message, which is the fastest way to tell them apart:
   `Failed to parse URL from /pipeline` = creds **missing** (bug #5); `fetch failed` = creds
   **present, host unreachable** (archived/paused/deleted). Redis is shared, so an outage breaks
   **Slack and Asana together** — a quick check is that non-Redis routes (`/api/config`) return
   200 while every `*/oauth-redeem` returns 500. Restore: Vercel → Storage → create an Upstash
   Redis DB, then Upstash console → Inactive databases → Restore; delete stale env pairs, since
   `redisClient()` takes the **first** match of `SLACK_KV_*` → `KV_REST_API_*` →
   `UPSTASH_REDIS_REST_*` and a stale pair would win. Redeploy afterward — env changes don't
   reach existing deployments. Expect recurrence on the free tier (OAuth traffic is sparse); both
   `oauth-redeem` routes now catch store errors and return
   `Token store unavailable: <cause>` at HTTP 200 instead of an opaque 500.
10. **`AI request failed (504): FUNCTION_INVOCATION_TIMEOUT`** — reported from the Asana task
    flow, but **not** integration code: every integration funnels through `/api/ai`. Two separate
    defects, both measured against prod:
    - **`api/ai.js` is Edge runtime**, and with `stream:false` it awaited the whole completion
      before emitting a byte. Same prompt: `stream:false` → **504 at 25.2s**; `stream:true` →
      **200, first byte 2.3s, total 131s**. The limit is on **time-to-first-byte**, not total
      duration. `maxDuration` is **not** a fix — it doesn't apply to Edge functions (`vercel.json`
      sets it only for `api/transcribe.js`, a Node function).
      **The subtlety that cost a release (v2.2.1 → v2.2.2):** the timer is on the **response's**
      TTFB, and *reading* from the upstream stream does **not** reset it — only **sending** a byte
      downstream does. v2.2.1 switched upstream to `stream:true` and reassembled frames in the
      handler, which still emitted nothing until the end and still 504'd at 25.2s (even for a
      300-word essay). Fix: return a `ReadableStream` that emits a space immediately, then
      keep-alive whitespace every 5s while assembling, then the JSON. `JSON.parse`/`Response.json()`
      ignore leading whitespace, so the client contract is unchanged. Verified: the exact prompt
      that returned 504@25.2s now returns 200, first byte 2.1s, total **134s**.
      3 of 4 AI callers passed no `onDelta` and were all exposed —
      note `summarizeTranscript` was called **both** ways, so live recording survived while
      *re-summarizing* the same meeting 504'd.
    - **No transcript cap.** `transcriptToText` sent every segment. Bisected: 60,868 B → 200 in
      7.5s, **67,618 B → 429 in 1.0s**. The ~1s fast-fail with no model work (while small prompts
      still returned 200) means a **per-request token limit**, not a drained account — the
      provider's "exceeded your current quota… check your plan and billing" text is misleading and
      will send you to the billing page for an oversized request. Fix: `transcriptToPrompt()` caps
      at 48 KB keeping the **tail** (decisions/action items are at the end) with an
      `[earlier portion…omitted]` marker; `transcriptToText` stays uncapped for non-AI callers.

## Known follow-ups / caveats

- `APP_PROXY_TOKEN` is a shared baked secret — anyone unpacking the app can relay traffic through the
  proxy (burns your Deepgram/LLM credits; allowlist limits scope). Upgrade path: gate `/api/*` with
  the user's Supabase JWT (`Authorization: Bearer`) instead — but that would require Google sign-in
  before Slack connect.
- Local token files (`slack-session.json`, `auth-session.json`) are **plaintext** in userData.
  Harden with Electron `safeStorage` (OS keychain) if needed.
- `.vercel/.env.production.local` has a committed `VERCEL_OIDC_TOKEN` — rotate / gitignore.
- Old draft releases v2.0.6 / v2.0.7 linger — safe to delete.
