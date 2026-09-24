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
   Guarded: the ch0 user can never win a ch1 vote. The AI tier always enforced that; this one did
   **not**, and Teams labels the user's own tile like any participant (`Myself video, Sagar, …`), so
   a captured meeting resolved 338 remote segments to the signed-in user. The check must use
   `matchToRoster` (≥0.7), **not** `nameKey` — the tile shows the mononym "Sagar" while the account
   is "Sagar Bansal", and `nameKey` is an exact match that lets that straight through.
4. **Roster-constrained AI inference** (`src/ai/inferSpeakerNames.js`), in four tiers, each falling
   through to the next only for labels still unresolved:
   a. strict/evidence-only (self-intros, being addressed) — high confidence;
   b. a bounded second pass over roster names nobody has claimed;
   c. **conversational** (`buildConversationalPrompt`) — addressing, hand-offs, who-reports-on-what.
      Capped at `CONVERSATIONAL_MAX = 0.7`, i.e. always below the 0.85 "verified" line. This tier
      exists because the strict prompt forbids inferring from context, and a recurring standup
      contains **no** introductions — so it correctly resolved nothing and every voice stayed
      `Speaker N`;
   d. `completeByElimination` — exactly one label and one unused roster name left is deduction, not
      guessing (0.55). Never assigns the ch0 user.
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

### Every alignment interval is capped (`MAX_HOLD_MS = 15 s`, `src/align.js`)
`toIntervals` used to hold each `active-speaker` event until the **next** one, uncapped. With a
sparse signal that is not "missing names", it is **confidently wrong** ones: in a captured 17-minute
meeting one event owned ~25 minutes and voted its name onto every voice it overlapped, assigning
**"Hernan Zapata" to two different diarized speakers** at 0.87 and 0.81. The cap is a no-op when
events are dense (a real signal repeats every few seconds) and converts a stale event into honest
`Speaker N` when they are not. Regression-tested both ways in `test/selfcheck.js`.

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

**`rosterIsTrustworthy` trusts STRUCTURE before name shape.** The exactly-two-word rule (tuned to
separate real rosters at 60–100% from the Meet pollution at 32%) also **rejected legitimate
rosters**: Meet guests joining as first names only (`["Sagar","Vicky","Priya"]` → 0%) and Zoom's
mixed case (`["Sagar","Vicky Rana","iPhone"]` → 33%). A rejected roster is treated as absent, which
silently disables the closed set the AI tiers depend on. Name *scoring* cannot fix this — measured,
`personScore("Back") == 0.85 == personScore("Sagar")` and
`personScore("History Navigation") == 1.00 == personScore("Vicky Rana")`. So an entry whose `source`
is `participants-panel` (a real accessible participants list, inside a window that passed
`LooksInCall`) is trusted regardless of shape; everything else still falls back to the word-count
heuristic. The captured pollution always came from the **tile-grid** fallback, never from a panel.

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
- **Active speaker** = **decoration delta** (a node reading `<known name> + extra`). **This does
  not work on Teams and is effectively dead there — do not invest in it again without new evidence.**
  Teams decorates *every* tile *all the time*, and the decorations are **mute state and menu
  availability, never speech**:
  `Carlos Brito, Has control of production tools, Context menu is available`.
  So `decorated.Count != 1` returns null on nearly every poll. Measured: **3** `active-speaker`
  events in a 17-min call, **0** in a 38-min call, and 0 across a fully-working 34-min call on the
  fixed binary. Emitting more of them would emit *mute-toggle* events — i.e. confidently wrong
  names, which are worse than none, because a wrong name propagates into the summary, the
  action-item assignee and the Slack/Asana send.
  **Consequence: attribution is transcript-first.** The agent's job is the ROSTER; the AI tiers do
  the matching. The `"<Name> is speaking"` regex remains a last-resort confirmation and has never
  once fired on real Teams.
- Dispatch now classifies by **owning process, not window title**, and no longer `return`s after the
  first window — browser-hosted Teams/Zoom had **no branch at all**, and modern Teams titles (no
  "Meeting"/"Call") never matched.
- `personScore()` is a score, not a gate: mononyms and single-initial tokens are accepted
  (common for Meet guests); decorations like `(Guest)`/`(She/Her)`/`, Host` are stripped first.
  Mirrored in three places — C#, Swift, and `src/roster.js` (the JS side re-validates, so it is the
  final safety net). **Keep them in step.**

### The agent was BLIND in every shipped installer (fixed 2026-09-08, v2.2.5)
Symptom: zero `roster` events for whole meetings, which reads exactly like a bad heuristic. It was
not. Every UI Automation call threw, so the agent enumerated **zero windows**:
```
TypeInitializationException: System.Windows.Automation.CacheRequest
  -> ... -> MS.Internal.UIAutomationTypes.Interop.OSVersionHelper
  -> System.DllNotFoundException: Dll was not found.
```
`YourCallAgent.csproj` set `PublishSingleFile` + `SelfContained` but **not**
`<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>`. Single-file
publish bundles only the **managed** assemblies and drops the native ones (WPF/UIA:
`PresentationNative_cor3.dll`, `wpfgfx_cor3.dll`, `vcruntime140_cor3.dll`, …) beside the exe — and
`agents/windows/build.ps1` ends with
`Get-ChildItem agents/dist -Exclude YourCallAgent.exe,.gitkeep | Remove-Item`, deleting exactly
those. Build output was 256 files; `agents/dist` was 1. **Never remove that csproj property.**
A correctly-built agent exe is ~161 MB; ~153 MB means the natives are missing again.

**Diagnose blindness before ever touching a heuristic.** The agent now emits
`{"type":"agent-diag","windows":N,"inCall":N,"nodes":N,"depth":N,"rosterSize":N,"topLevelWindows":N}`
on change. `topLevelWindows: -1` = the root enumeration **threw** (blind); `0` = UIA saw nothing.
Two rounds of widening regexes were wasted on code that never executed.

Two related limits fixed at the same time:
- `UiaHelpers.CollectNodes` is **breadth-first with a hard node cap**, and `Poll` used **400** while
  `--dump` used **1200** — so the instrument saw 3× more than the real code and would "prove" a
  roster the detector could never reach. Both now use `NodeBudget = 3000`, with the poll slowed
  500 ms → `PollIntervalMs = 2500` to pay for the UIA round-trips (the roster changes slowly, and
  active-speaker is dead on Teams, so 2×/s bought nothing). Verified against live Teams: participant
  rows sit at **depth 14**, unreachable by a 400-node BFS in a wide Chromium/WebView2 tree.
- `LooksInCall` **must stay strict** (contribute nothing when false). Relaxing it to "report a
  participants-panel anyway" was tried and disproved within minutes on a live desktop: an ordinary
  **Gemini web page** produced the roster `["Targets: LinkedIn", "The Tech: Undetected headless
  browsers"]`, and that junk passes *every* downstream guard (`isPersonName` true,
  `rosterIsTrustworthy` true), so it would have poisoned the closed set.

**Verified live 2026-09-08 on Teams desktop** (`ms-teams.exe`): `topLevelWindows: 7`, `windows: 3`,
`inCall: 1`, `depth: 19`, and the real 8-person roster at `participants-panel` / 0.9. With no meeting
open it emits zero rosters. Google Meet and Zoom remain **unverified** — the blindness fix is
platform-independent so both are strictly better, but their panel shapes are unconfirmed.

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

## Audio capture — device-aware, self-verifying (v2.2.5)

Capture used to bind to whatever Windows called "default" at the instant recording started, record
nothing about which device that was, and never check a single sample arrived. A user on Bluetooth
earphones recorded a meeting with **no meeting audio at all** and no error.

**Four documented mechanisms produce that identical symptom**, and the old code could distinguish
none of them (one `AnalyserNode` summed mic+system, so it could not even say which side died):
1. **WASAPI does not follow default-device changes** (Microsoft docs) — unlike MediaFoundation/
   DirectShow/winMM. Connect earphones *after* recording starts and the loopback stays bound to the
   old endpoint, going silent while audio plays elsewhere. **Measured live**: system RMS 0.104 →
   exactly `0` three seconds after a Jabra connected, and the track stayed `readyState:"live"`.
2. WASAPI loopback delivers **nothing (not silence)** when no playback is active on some endpoints,
   and which endpoint type breaks is *driver-specific*.
3. The **A2DP→HFP switch is triggered by our own `getUserMedia`**, which is why the mic is now
   acquired **first**, with a short settle, *before* the display/loopback binds — so loopback binds
   to the post-switch endpoint. (Ordering is the substantive part; the 400 ms is insurance.)
4. Non-built-in endpoints are a known failure class in this API (Electron #15829).

**Recovery is automatic.** Measured with a throwaway probe: a *fresh* `getDisplayMedia` DOES bind to
the new default (`deviceId: "loopback"` is a sentinel Chromium resolves at acquisition time), while
the original stream stays permanently dead. So on `devicechange` the recorder acquires a replacement,
**proves it is alive** (`probeStreamAlive`, `src/recorder/devices.js`) and only then splices it into
the existing `ChannelMerger`. `MediaRecorder` is bound to the `MediaStreamDestination`, **not** the
source, so the recording continues across the swap — no restart, no container break, ~2–3 s gap.
Verified in a real meeting: `captureHealth.recovered: true`.

**Two false-positive traps, both measured, both now unit-tested** (`src/recorder/audioHealth.js`):
- A **healthy** loopback emits an isolated `0.000006` sample and recovers on the next tick, so one
  dead reading proves nothing — death must be **sustained** (`SYSTEM_DEATH_MS = 12 s`).
- With nothing playing, a healthy endpoint also reads zero. "Nothing playing" and "dead endpoint"
  are indistinguishable by RMS alone, so the death check **also requires the mic to carry signal** —
  otherwise it re-acquires in a loop through every quiet stretch of a meeting.

**Digital silence ≠ a quiet room.** A live path always carries a noise floor (~1e-4 RMS); a broken
one delivers memset-zero buffers. `DEAD_RMS = 1e-5` sits in that gap. The existing
`SILENCE_RMS = 0.0025` sits *above* the noise floor, which is exactly why it can only ever say
"quiet" and never "dead" — **do not reuse it for health checks.**

### The probe threshold was inside the noise (fixed 2026-09-24)

`probeStreamAlive` gated on `DEAD_RMS` (1e-5), and that gate sat **in the middle of a single
cluster**, not between two. Measured across **51 real recovery probes** from 7 captured meetings:
15 readings at 8.9e-6–9.8e-6 (called dead) and 25 at 1.0e-5–2.0e-5 (called ALIVE) — i.e. **69% of
every "alive" verdict** was physically indistinguishable from a dead one, and only 4 probes of 51
ever saw real audio (≥1e-3). The verdict was decided by jitter in the fifth decimal.

That is worse than having no probe: it launders a coin flip into recorded evidence
(`recover-ok, maxRms: 0.0000102`) and then **swaps a working source out for a dead one** — exactly
how the 2026-09-17 meeting lost 45 minutes. Accepting a candidate now requires `ALIVE_RMS = 1e-4`
(10× above the ambiguous band, ~1000× below real speech), and the probe no longer early-exits on
a noise-floor reading. `DEAD_RMS` is still correct for the *warm-up* verdict; the two thresholds
answer different questions and must not be merged.

Three more failures from the same meeting, all of which produced **zero** user-visible signal:
- **`all-dead`** (`TOTAL_DEATH_MS = 45 s`). `system-dead` requires the mic to carry signal, so
  "everything is dead" — the worst case — was the one state it could structurally never see.
  Note the flat test is `<=` deadRms: the real capture logged `sysRms` exactly `0.00001`.
  Evaluated **before** the 30 s `silence` event, which would otherwise mask it every time.
- **A mic `trackended` only logged.** A track that ends never revives, so it now warns at once.
- **The level timer had no try/catch and silently died at t=150 s**, taking every detector with
  it — `setInterval` keeps its schedule after a callback throws, so the timer "ran" for 46 more
  minutes doing nothing. Now wrapped, plus an `AudioContext` `onstatechange` watchdog (a
  suspended context freezes the graph *and* the MediaRecorder feed), plus `capture-alive` — an
  **unconditional** per-tick pulse to main. `capture-audio` only fires when there IS sound, so
  main could never distinguish a quiet meeting from a dead monitor; its absence now alarms after
  `MONITOR_DEAD_MS`. That is **45 s, calibrated, not guessed**: across 23 real recordings the
  worst healthy start→first-event gap was **15.9 s**, so the obvious 15 s would false-alarm.

Verified by replaying every real `capture.jsonl` through the new detectors: **29 healthy
recordings clean, 0 false positives.**

## Meeting audio follows the Windows DEFAULT output — and that is the bug (v2.3.3)

**Chromium loopback can only ever capture the Windows default render endpoint.** Electron 37's
`setDisplayMediaRequestHandler` accepts `'loopback' | 'loopbackWithMute' | WebFrameMain` and
nothing else (`electron.d.ts`) — there is **no API to loopback a named device**, and a loopback
track carries no endpoint identity (`getSettings()` has none), which is why `devices.js` can only
*infer* the endpoint from the current default.

Connecting an external display makes **its** speakers the Windows default. Measured live
2026-09-22: default was `E24-30 (HD Audio Driver for Display Audio)`, the meeting played out of
`Speakers (Realtek)`, `sysRms` was **exactly 0 for the whole 18 minutes**, and six recovery
attempts all re-bound to the same silent monitor. Same root cause as 2026-09-17, where the default
flipped `Headphones → E24-30` mid-meeting. **Re-acquiring `getDisplayMedia` can never fix this** —
it returns the default, which is the problem.

So the only lever is to change the Windows default itself, which needs native code. `--audio` is a
second mode on the **existing** agent binary (no new module, no packaging change — `extraResource`
already ships `agents/dist`):
- `--audio list` → every render endpoint with `isDefault` and a **peak level** read via
  `IAudioMeterInformation`, which does **not** open a capture stream. This is the primitive
  Electron cannot provide: it answers "which device has sound *right now*" for **every** endpoint,
  while the renderer can only ever measure the one it is bound to. Measured on real hardware:
  silence `0.000000`, ordinary speech `0.557926`; `LIVE_PEAK = 0.01` sits in that gap. It is a
  **peak**, not an RMS — do not compare it against `ALIVE_RMS`.
  Sampled 10× over ~1 s and kept as a max, because an instantaneous meter reads 0 between words.
- `--audio set <id>` → `IPolicyConfig::SetDefaultEndpoint` for all three roles (eConsole drives
  loopback; setting only it leaves media/calls split).

`--audio` **must be routed before the UIA poll loop and must `Environment.Exit`** — it is one-shot
and does no UIA work.

**Escalation, in `recoverSystemAudio`.** Two plain re-acquires (covers a genuine endpoint glitch),
then ask main to switch the default; the existing `ondevicechange` listener fires and the normal
recovery path re-binds. **No new splice logic** — `MediaRecorder` is bound to
`stereoDest`/`monoDest`, not to `sysSrc`, so the recording never stops.
- The switch is **one-shot per dead stretch** (`endpointSwitchTried`), reset only on success.
- `devicechange` gets a **shorter cooldown, not an exemption**. Exempting it is unbounded:
  Windows fires it repeatedly and a switch onto another silent device re-triggers it. Simulated
  over 30 min of a permanently dead endpoint, the exempt version ran **1763 probes vs 90** — at 4 s
  each that is continuous probing competing with the capture it is repairing. Regression-tested.
- **Nothing live to switch to → select nothing.** `chooseLiveEndpoint` never returns the current
  default (if it were live we would already be recording it) and never picks below `LIVE_PEAK`, so
  a genuinely silent meeting cannot cause the app to reassign the user's audio device.

**The switch is deliberately NOT restored** when recording ends (user's call — a restore that only
runs on a clean stop is a promise the crash path breaks). It is a system-wide change the user did
not make, so the popup names the device and says it stays selected.

**Everything degrades to today's behaviour**: missing binary, an older binary without `--audio`, or
a Windows build where `IPolicyConfig` has gone (it is **undocumented** — stable since Win 7 and
what nircmd/SoundVolumeView use, but not contractual) all return null/`{ok:false}` and fall back to
warning the user. `agentBinaryPath()` is wrapped in try/catch because it runs **on the recovery
path during a live recording**. **macOS keeps notify-only** — no equivalent API without a virtual
audio device.

**The failure message must name the device.** "Meeting audio not captured" tells the user nothing;
`no-live-endpoint` now reads *"Windows is set to “X” but nothing is playing there."*

**UX: warn, keep recording, never auto-stop.** A false positive that kills a real meeting is
unrecoverable; a false negative costs one dismissable popup (`capture-degraded`). Mic failure is
fatal (ch0 anchors §7); system-audio failure is not — a mic-only recording still transcribes.
Per-recording diagnostics land in `<recordingsDir>/<id>/capture.jsonl`, mirroring `speakers.jsonl`.

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

## Video: capture → seekable MP4 (§5)

Recordings used to be written as WebM and were **not seekable** — not a player problem, a
container one. MediaRecorder emits "live" WebM: **no `Cues`/`SeekHead`** (no keyframe index) and
no usable duration. Measured on a real 20 s capture: `ffmpeg -i capture.webm` reports
`Duration: N/A`. Chunks are raw-appended to a write stream (`src/main.js` `capture-chunk`), so
nothing ever rewrites the header. `express.static`'s Range support (`src/server.js`) is therefore
irrelevant: byte ranges serve fine, but there is no timestamp→offset map to turn a scrub into one.

**Two-name scheme.** Capture writes `capture.{mp4,mkv,webm}`; a post-pass produces `video.mp4`
(progressive, `+faststart`). **The presence of a `capture.*` file IS the "needs normalizing"
flag** — the state machine is the filesystem, never `meta.status`. That is load-bearing:
`runPipeline` writes `status:'complete'` *before* its final upsert while `recoverAndRequeue` only
requeues `recorded|transcribing|failed`, so anything keyed off status and finishing late would be
**unresumable forever** after a quit — and quit is guaranteed (`before-quit` waits a hard 12 s then
calls `app.quit()`). Retrying via `runPipeline` would also re-bill Deepgram and clobber
`actionItems`. `src/media.js` owns the naming; `src/normalize.js` owns the queue.

### What actually gets recorded (measured, Electron 37 / Chromium 138)
`recorder.js` walks `VIDEO_MIMES` best-first with a **real constructor call**, because
`isTypeSupported` is necessary but not sufficient (it reports codec-string parseability plus a
static capability check; the muxer can still fail to initialise).
- `video/mp4;codecs=avc1.640028,mp4a.40.2` → **supported**. Emits **fragmented** MP4
  (`ftyp moov moof mdat … mfra`), no `stss`. Chromium may hand back a lower level
  (`640028` came back as `64001f`); the profile is what matters.
- `video/webm;codecs=vp9,opus` → the pre-change default; `Duration: N/A`, no `Cues`.

**Both still need the normalize pass** to become progressive and indexed — H.264 only changes what
that pass *costs*: a lossless `-c copy` remux (**80 ms** for 20 s, measured) instead of a full
transcode (~17× realtime on `h264_qsv`, so ≈3–4 min for a 1 h recording). Probe the **full** mime
including audio: bare `avc1` can yield `video/mp4;codecs=avc1,opus`, which passes, muxes, and then
will not play in QuickTime.

### ffmpeg is bundled, and it is LGPL on purpose
`scripts/fetch-ffmpeg.mjs` (`npm run fetch:ffmpeg`) provisions a **pinned, SHA-256-verified**
ffmpeg into gitignored `vendor/ffmpeg/`, shipped by a **second** `extraResource` entry. It must
**not** live in `agents/dist` — `agents/windows/build.ps1` deletes everything there except the
agent exe.

**LGPL, not GPL,** because this project is MIT: no `--enable-gpl`, no libx264, no
`--enable-nonfree`. The two platforms reach that differently, and the difference is forced.
- **Windows downloads a prebuilt.** BtbN publishes an explicitly `-lgpl-` flavour whose software
  H.264 encoder is libopenh264 (Cisco, BSD-2) instead of libx264. When re-pinning, the asset name
  must contain `-lgpl-`.
- **macOS COMPILES ffmpeg from source**, because **no LGPL macOS prebuilt exists**. Each candidate
  was checked by reading `FFMPEG_CONFIGURATION` straight out of the Mach-O rather than trusting a
  README, and every one was disqualified:
  `eugeneware/ffmpeg-static` (what this was first pinned to) is `--enable-gpl` **and**
  `--enable-nonfree` — a combination FFmpeg itself calls **unredistributable**, so it was not a
  licence preference but a thing we could not legally ship at all; `ffmpeg.martin-riedl.de` is
  `--enable-gpl --enable-libx264 --enable-version3`; evermeet.cx and osxexperts are GPL too.
  Building it is also **better provenance**: the source tarball is GPG-signed by the FFmpeg
  release key (`FCF986EA15E6E293A5644F10B4322F04D67658D8`, verified before pinning), whereas the
  Windows pin trusts a third party's autobuild. Both platforms use the same release (9.0.1).
- **`--disable-autodetect` is the load-bearing flag**, and disabling libs one at a time is not a
  substitute. The first attempt named `--disable-lzma --disable-bzlib --disable-sdl2` and the
  v2.3.0 build still linked **Homebrew's `libxcb` + `libX11`** (x11grab) from the runner image —
  i.e. a "Library not loaded" crash on every user's Mac, and the one class of bug CI can never
  reproduce, because Homebrew is sitting right there. `assertSelfContained()` caught it and failed
  the build. `--disable-autodetect` makes the result a function of the flags instead of the
  runner's image. **It also disables `THREADS_LIST` and the hwaccels**, so `--enable-pthreads`,
  `--enable-videotoolbox`, `--enable-audiotoolbox` and `--enable-zlib` must be named explicitly;
  forgetting `--enable-pthreads` yields a silently single-threaded ffmpeg.
- **No external libraries are enabled on macOS**, which is what keeps it LGPL — and costs nothing:
  `h264_videotoolbox` encodes on every Mac, and VP8/VP9/Opus/AAC decoding is native to FFmpeg.
  The consequence to know: **macOS has no software H.264 fallback.** If VideoToolbox fails to
  validate, `pickEncoder` returns null and the recording stays `.webm` — which only affects the
  legacy transcode path, since a new Mac recording is already H.264 and remuxes with `-c copy`.
- **A source build cannot be hash-pinned**, so the checks move to the built artifact and all of
  them are fatal: `configure` must print `License: LGPL version 2.1 or later` (FFmpeg's own
  verdict, not our reading of the flags); `-version` must not mention gpl/nonfree/libx264;
  `otool -L` must show **only** `/usr/lib` + `/System/Library` (a Homebrew dylib autodetected on
  the runner is a "Library not loaded" crash on a user's Mac, and CI is the one place that would
  never notice); required encoders/decoders/muxers/demuxers/**devices**/**filters** must be
  present; and a **smoke test must actually produce a faststart, `stss`-indexed MP4** through the
  same flag shape `src/ffmpeg.js` uses. That last one is worth more than all the list checks — it
  covers the lavfi device, the `scale` filter, the mp4 muxer and `-progress pipe:1` in one run.
  Buckets matter: `lavfi` is a **device**, `scale`/`testsrc` are **filters**. Listing either as a
  demuxer makes its assertion permanently unsatisfiable, which fails the build for a reason that
  has nothing to do with the build. (It was wrong exactly that way first.)
- CI **caches `vendor/ffmpeg`** keyed on the script's hash, so the compile is a once-per-pin cost.
  The fetch step still runs on a cache hit and re-verifies, so a bad cache entry cannot ship.
- **Not `ffmpeg-static`:** the main process is webpack-bundled, and that package's whole API is
  `path.join(__dirname, 'ffmpeg.exe')`, which after bundling resolves inside `.webpack/main`.
- Ship `ffmpeg` only, never `ffprobe` — nothing here needs it (codec from `meta.video.mime`,
  duration from `startedAt`/`endedAt`, sweep state from filenames) and it would double the payload.
- `ffmpegPath()` probes **both** `resources/ffmpeg/` and `resources/vendor/ffmpeg/`, same hedge as
  `src/agents.js`. A missing binary is **non-fatal**: keep the capture file, log once, never throw.

### Flags that are all load-bearing
- **`-f mp4` is mandatory.** Output goes to `video.mp4.part` so a crash can never leave a half-file
  under the real name — and ffmpeg picks its muxer from the extension, which is `.part`. Without it
  every path dies instantly with *"Unable to choose an output format"*. (Cost a debug cycle.)
- `-movflags +faststart` rewrites the file at the end to move `moov` to the front. That is also why
  **a `.part` is never salvageable** — a partial one has no index by construction.
- `-fps_mode passthrough`: `getDisplayMedia` is variable-frame-rate (Chromium suppresses unchanged
  frames), and the default forces a constant rate, accumulating A/V drift visible only ~40 min in.
- `-map 0:a:0?` — **optional** audio. Loopback can return no audio track at all; a mandatory map
  would fail the whole job instead of omitting the track.
- `-vf scale=trunc(iw/2)*2:… -pix_fmt yuv420p` on the transcode path: H.264 4:2:0 forbids odd
  dimensions, which fractional display scaling produces. Missing it fails on *every* encoder, so it
  reads as "ffmpeg is broken" rather than as geometry.
- `-g 45` (3 s at 15 fps) **is** the seek granularity of a transcode. Copy paths inherit Chromium's
  GOP, which is ~3 s in practice.

### Encoder selection: presence is not proof
`ffmpeg -encoders` gives what is compiled in; an encoder can still fail at runtime (no GPU, stale
driver, NVENC's 2–3 concurrent-session cap when OBS is open). So each candidate gets a **1-second
synthetic encode** before it is trusted, and the winner is persisted in `VIDEO_ENCODER` so the probe
is paid once per install. A mid-job failure retries **once** with the next candidate.
**An input error is not an encoder error** — `INPUT_ERROR` in `normalize.js` short-circuits, because
without it one unreadable recording blacklists a good hardware encoder and every later conversion
in the session silently falls back to a slower one.
Parsing note: the name pattern is not `\S+` — `ffmpeg -encoders` has a legend line reading
` V..... = Video`, which `\S+` captures as an encoder named `=`.

### Queue invariants
Concurrency **1**. Kicked off **un-awaited** from `runPipeline` (it overlaps the network-bound
Deepgram call for free, so `pipelineRunning` keeps meaning "expensive AI work"). **Never runs while
`rec` is live** — a saturated CPU drops capture frames and can glitch WASAPI loopback, trading a
cosmetic problem for a corrupted recording; `startRecording` kills it, `stopRecording` resumes.
`before-quit`/`will-quit`/`process.on('exit')` all kill the child (Electron does not reap children;
an orphan holds 100 % CPU and the output handle) and quit **never waits** for it, since the work is
fully redoable from an untouched source.
Order is always **write `.part` → fsync → rename → unlink source**. Output shorter than
`ACCEPT_RATIO` of the wall-clock span is accepted but marked `partial` and the **source is kept**.
That threshold is **0.75, calibrated against a real library, not guessed**: content/wall runs
86.5 %-100 % on complete recordings (median 99.6 %) because capture starts slightly after
`startedAt` and `getDisplayMedia` suppresses unchanged frames, whereas a genuinely truncated
capture measures ~46 %. The original 0.95 flagged a quarter of healthy recordings as partial and
never reclaimed their disk. `attempts` caps at 3 so an
undecodable file is not retried on every launch forever. Progress percentage uses
`endedAt - startedAt`, because the source's missing duration is the very bug being fixed
(ffprobe would return `N/A`). Sweep jobs are **silent** — driving the global status pill from a
crash-recovery sweep would leave "Preparing video…" up for an hour after launch.

**A killed job is requeued, and that cannot happen inside `killCurrent()`** — `current` is still
set there, so `enqueue()` would hit its own "already running" guard and silently discard the job.
It is done from `drain()`'s `finally`, once `current` is cleared. Getting this wrong is how a
preempted conversion (and every job displaced by a recording starting) used to vanish until the
next launch's sweep. Quit passes `{ requeue: false }`, or shutdown would spawn a fresh ffmpeg.

**`normalize.json`, not `meta.json`.** The queue keeps its own state file
(`attempts`/`encoder`/`ms`/`partial`/`lastError`) and only ever *reads* `meta.json`, for
`startedAt`/`endedAt`. Both processes would otherwise read-modify-write the same file
concurrently — and they genuinely interleave, since the conversion is fire-and-forget from
`runPipeline`. A lost update reverting `status:'complete'` to `'transcribing'` would make
`recoverAndRequeue` re-run the entire pipeline next launch, **re-billing Deepgram and nulling
`actionItems`**. Separate files removes the race outright instead of adding a lock.

**Encoder probing is async.** `pickEncoder` runs `-encoders` plus a real 15-frame test encode per
candidate. Those were `spawnSync` — seconds of frozen main thread on the first conversion of a
session, up to ~80 s with a wedged GPU driver, landing exactly when a user clicks. The validated
choice persists in `VIDEO_ENCODER`, read **inside `configure()`**: reading it at module scope was
useless, because `main.js` requires this file at startup while `applyToEnv()` (which populates it,
and `delete`s unset `KEYS`) only runs later in `app.whenReady()`.

### `videoUrl` is DERIVED, not stored
`list-meetings` recomputes it via `media.mediaUrl()`. It is written at three points in a
recording's life and the file it names changes when `capture.*` becomes `video.mp4`, so the stored
value is a cache nobody reads — which makes a dead ▶ link unrepresentable.
**The bug this closed:** `sync.js` `rehydrate()` gated on `video.webm` existing. The moment an mp4
shipped, that went false → `videoUrl: null` → `putRaw` shallow-merged the null over a good local
record → the play/download buttons silently vanished, for signed-in users only, on every launch,
with the file sitting right there on disk.
**No migration:** `videoUrl` is in `LOCAL_FIELDS`, so **no Supabase row has ever contained one**.

### Playback: no in-app player — convert on demand
There is **no `<video>` in the app**, deliberately. `▶ Open in player` and `⬇ Download` both go
through main, which calls `normalize.ensureMp4()` first: instant when the recording is already
`video.mp4` (one stat), otherwise it converts that one recording and waits. `▶ Open in player` then
uses `shell.openPath` (OS player: frame stepping, playback speed, real fullscreen) and only falls
back to `shell.openExternal` when conversion was impossible, since a browser is the one thing that
reliably plays a live-muxed WebM. `⬇ Download` prompts **before** converting — a modal appearing
minutes later, after the user has switched apps, is worse than picking the destination up front —
and offers `.mp4` whenever we can actually produce one, the honest extension otherwise.

`ensureMp4` **preempts** background work (redoable, so requeued) and **refuses while recording**
rather than queueing, so the user gets an answer instead of a hang.

### Legacy recordings: never swept, always convertible
`media.needsNormalize` reports `none` for `video.webm`, so `sweep()` never touches them — an
established library is ~55 recordings / ~30 hours, i.e. hours of unrequested 100 %-CPU transcoding
on the first launch after updating.

**But gating on that alone made the whole feature invisible**, which is exactly what happened on
first release: every recording predated the change, so both buttons kept handing back WebM and the
work looked broken. Conversion therefore has to be reachable from the buttons themselves, not only
from a background sweep. `ensureMp4` and Settings → **Older recordings → Convert to MP4** both just
rename `video.webm` to `capture.webm` and enqueue it, so a legacy file goes through the same queue,
acceptance check, `.part` → fsync → rename ordering and crash recovery as a fresh recording. No
second conversion code path exists.

### Also fixed here (pre-existing, unrelated to the container)
`recorder.js` wired only `ondataavailable`. A `MediaRecorder` that errored mid-meeting simply
**stopped emitting chunks and nothing noticed** — the liveness heartbeat is driven by the
AudioContext *sources*, not the recorders, so `isAudioActive()` kept returning true and the user got
a 5-minute video of a 50-minute meeting with no warning. Worse, `recA`'s construction sat in the
same `try` as everything else, so a video-encoder rejection ran `capture.error()` →
`finalizeRecording()`, closing the **audio** stream and destroying the transcript of a meeting whose
audio was fine. Now: `recA` is built in its own loop+catch, `recA === null` means **audio-only and
recording continues**, and both recorders have `onerror` routed through the existing
`capture-degraded` path (warn, keep recording, never finalize). `videoDead` needed a branch in all
three places that render that message (notification, status pill, popup) or it read as
"Microphone not captured".

**Write streams had no `'error'` listener.** A `WriteStream` that emits `'error'` unhandled throws
in the **main** process — the app dies mid-recording and takes the audio with it. The `try/catch`
around `stream.write()` does not help: fs stream write errors arrive asynchronously via the event,
not from the write call. Disk-full is the realistic trigger, and normalization doubles peak disk
use. All four capture streams now go through `openRecStream()`, which warns via the status pill and
never finalizes.

**`retentionSweep` could delete a file a conversion was writing.** It removes every media name
including `video.mp4.part`, runs from the `save-settings` handler at arbitrary times, and on-demand
conversion targets exactly the old recordings retention is about to delete. It now skips
`normalize.currentId()`. On Windows the unlink would fail with EBUSY; on macOS/Linux it silently
succeeds and ffmpeg keeps writing to the unlinked inode, so `video.mp4` **reappears** after
retention thought it was gone.

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
  Note `ship.mjs` runs `git add -A`, so anything untracked and unignored goes in; `vendor/ffmpeg/*`
  is gitignored precisely so the 110 MB binary cannot be committed by it.
- **release.yml:** builds Windows + macOS installers → **draft** GitHub Release; separate `deploy-api`
  job runs `vercel deploy --prod`. Also runs on `workflow_dispatch` (re-build without a bump).
- **The matrix sets `fail-fast: false`.** The two platforms are independent builds uploading to the
  same draft, and the default cancels one when the other fails: on v2.3.0 the macOS ffmpeg build
  failed and **killed a healthy Windows job mid-upload**, leaving the draft holding `RELEASES` and
  the `.nupkg` but no `Setup.exe`. A partially-uploaded draft must be deleted, not published —
  Squirrel reads `RELEASES` and would hand clients a missing installer.
- Draft release must be **published manually** (`gh release edit vX.Y.Z --draft=false`).
- **Dev:** `npm start` (electron-forge). Main-process code changes need a **full restart** — kill all
  `electron.exe` and relaunch (single-instance lock can hand off to a stale process; delete
  `.webpack/` for a clean rebuild). **Check for an in-progress recording before killing Electron** —
  `taskkill /IM electron.exe` mid-meeting ends it. The recording is not lost (`recoverAndRequeue()`
  marks it `interrupted` and re-queues on next launch) but capture stops there.
- **Agent changes need `npm run build:agent`** and a full app restart; `agents/dist` is gitignored,
  so a JS-only ship carries whatever binary CI builds. A sanity check that the installer's agent is
  sound: `Setup.exe` grew ~3.6 MB from v2.2.4 → v2.2.5 when the UIA natives were finally bundled.

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

11. **Speaker names never resolved (v2.2.4 → v2.2.5)** — three consecutive meetings emitted zero
    roster events. Read as a heuristic bug; it was **three separate defects**, none of them in the
    heuristics:
    - the agent was **blind** — `PublishSingleFile` without `IncludeNativeLibrariesForSelfExtract`,
      so UIA's native DLLs never shipped and every `RootElement.FindAll` threw
      `DllNotFoundException`. This affected **every installer ever released**, because
      `build.ps1` deletes everything in `agents/dist` except the exe. Two rounds of widening
      `LooksInCall` regexes were spent on code that never executed. **Confirm the agent can see
      windows (`agent-diag.topLevelWindows`) before debugging any heuristic.**
    - `Poll` collected 400 nodes breadth-first while `--dump` collected 1200, and Teams participant
      rows sit at depth 14 — the diagnostic could show a roster the detector could never reach.
    - alignment intervals were uncapped, so one stale event claimed ~25 minutes and produced
      *confidently wrong* names (one person on two channels) rather than missing ones.
    The user-visible "wrong names" also included the signed-in user appearing as a remote speaker:
    the agent vote had no ch0-user guard, and the guard needs `matchToRoster` (mononym "Sagar" vs
    account "Sagar Bansal"), not `nameKey`.

## Known follow-ups / caveats

- `APP_PROXY_TOKEN` is a shared baked secret — anyone unpacking the app can relay traffic through the
  proxy (burns your Deepgram/LLM credits; allowlist limits scope). Upgrade path: gate `/api/*` with
  the user's Supabase JWT (`Authorization: Bearer`) instead — but that would require Google sign-in
  before Slack connect.
- Local token files (`slack-session.json`, `auth-session.json`) are **plaintext** in userData.
  Harden with Electron `safeStorage` (OS keychain) if needed.
- `.vercel/.env.production.local` has a committed `VERCEL_OIDC_TOKEN` — rotate / gitignore.
- Old draft releases v2.0.6 / v2.0.7 / **v2.2.3** linger — safe to delete.
- **Speaker names on Google Meet and Zoom are unverified.** Teams desktop is confirmed working end
  to end (2026-09-08). The v2.2.5 blindness fix is platform-independent, so both are strictly better
  than before, but neither participants-panel shape has been observed live. If names do not resolve,
  read the `agent-diag` line in `speakers.jsonl` **first** (it says whether the agent could see
  anything at all), then run `--dump` *while that meeting is open*.
- Teams exposes **no speaking indicator**, so ch1 attribution is inference over a known roster, not
  measurement. Names will be right materially more often than before and wrong ones render as
  suggestions, but this cannot reach the reliability of a true active-speaker feed.
