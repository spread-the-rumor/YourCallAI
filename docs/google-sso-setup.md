# Google SSO + Server Sync — Setup

Signing in with Google syncs each user's **meeting data** (transcripts, history,
summaries, chats, notes) to Supabase so they can log in on any machine. **Recordings
(video/audio) stay local only.** Sign-in is optional — without it the app is local-only
as before.

## 1. Supabase project

1. Create a project at https://supabase.com.
2. **Auth → Providers → Google**: enable it. You'll need a Google Cloud OAuth client
   (Console → APIs & Services → Credentials → OAuth client, type "Web application").
   Put the Google client ID + secret into the Supabase Google provider config.
3. In the **Google Cloud** OAuth client, add Supabase's callback as an Authorized redirect URI:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`
4. **Supabase → Auth → URL Configuration → Redirect URLs**, add:
   - `yourcallai://auth` (the packaged desktop app)
   - `http://localhost` (dev, if needed)

## 2. Database table + RLS

Run in the Supabase SQL editor:

```sql
create table meetings (
  id text not null,
  user_id uuid not null references auth.users(id) default auth.uid(),
  data jsonb not null,              -- full meeting object minus videoUrl/transcriptUrl
  updated_at timestamptz not null,  -- last-write-wins ordering
  deleted_at timestamptz,           -- soft-delete (trash) mirror
  primary key (user_id, id)
);
alter table meetings enable row level security;
create policy "own rows" on meetings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

## 3. Credentials (build-time)

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are baked into the app at build time via
`webpack.main.config.js` (same pattern as `VERCEL_BACKEND_URL`). The anon key is public
by design — RLS is what protects data.

- **Dev:** put them in the root `.env`:
  ```
  SUPABASE_URL=https://<ref>.supabase.co
  SUPABASE_ANON_KEY=<anon-key>
  ```
- **Release (GitHub Actions):** add `SUPABASE_URL` and `SUPABASE_ANON_KEY` as repo
  secrets and pass them into the `release` job's build step (alongside `VERCEL_BACKEND_URL`).

If these are absent, the "Sign in with Google" UI stays hidden and the app runs local-only.

## How sync works

- Server is source of truth. On login / app start: pull all rows, reconcile with local
  by `updatedAt` (last-write-wins per meeting).
- Every local meeting write (`src/store.js`) pushes to Supabase; offline writes queue to
  `sync-queue.json` and flush on the next successful sync.
- Recordings are never uploaded. On another machine, a meeting shows all its data but the
  video/audio player won't load (the file isn't there) — expected.

Reconcile logic self-check: `node src/sync.js`.
