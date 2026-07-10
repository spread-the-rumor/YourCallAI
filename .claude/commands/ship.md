---
description: Commit local changes, bump version, and trigger the release + Vercel deploy workflow
---

Run the ship pipeline for this repo.

1. Show `git status` so I can see what will be committed.
2. Run `npm run ship -- "<commit message>" <patch|minor|major>`, using a commit message summarizing the current changes (default bump: patch).
3. This commits everything, bumps the version in package.json, tags `vX.Y.Z`, and pushes — which triggers `.github/workflows/release.yml` to build the Windows + macOS releases and deploy the `/api` backend to Vercel.
4. Report the Actions URL and confirm the tag pushed.

If there are no changes to commit, still bump + tag to re-run the release/deploy.
