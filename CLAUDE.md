# Iron Log — notes for Claude Code

Iron Log is a mobile-first workout tracker (strength, yoga, home/bodyweight) with XP/streaks, an AI coach,
Crew (friends), and Apple Health import/export. It's a plain HTML/CSS/JS app with no framework and no bundler.
It is hosted on GitHub Pages and uses Supabase for accounts, sync and Crew.

Live site: https://saumild.github.io/iron-log/  ·  Supabase project: `iron-log` (ref `fmbabihfkejpuwtcjsng`, us-west-1)

## Commands
- `npm run build`: builds `dist/` with `python3 tools/build.py`. It inlines every `src/` file into one `dist/index.html` and copies `src/public/` (manifest, icons, `sw.js`).
- `npm test`: build, then all Playwright specs (~150 checks, a few minutes). Run it after every change.
- `node tests/<name>.spec.mjs`: run one spec: `smoke`, `accounts`, `ai`, `crew`, `offline`, `health`.
- `python3 tools/icons.py`: regenerate the app icons.
- First time: `npm ci && npx playwright install chromium`.

## Layout
```
src/index.html          page shell; <!--@inline path--> markers are replaced at build time
src/css/                styles (style-1.css is the app theme: off-white, ink, one blue accent)
src/js/config.js        Supabase URL + publishable key (public by design; RLS protects data)
src/js/ai.js            bring-your-own AI: copy & paste (any AI app) or OpenAI / Anthropic / Gemini with the user's key
src/js/platform.js      ironPlatform.use('db'|'user'|'auth'|'downloads'|'sample'): Supabase or on-device (IndexedDB)
src/js/auth.js          Iron Log accounts: username + password, data end-to-end encrypted (AES-GCM, PBKDF2),
                        recovery codes, offline-safe sync (encrypted on-device copy, pending saves, merge by record id)
src/js/app.js           state, storage tiers, rendering, coach, stats, backups
src/js/workout.js       live workout logging, routines, review
src/js/planner.js       daily plans (strength / yoga / home), AI plan prompts + parsing
src/js/exercises.js     exercise + yoga pose library
src/js/progress.js      measurements, check-ins
src/js/crew-artifact.js Crew data layer: private groups ilgrp/<id>/m/<account>/… joined by invite link (#crew=<id>)
src/js/social.js        Crew UI
src/js/health.js        Apple Health: Shortcut import (paste, file, or link #k=<key>&health=…) and Save to Apple Health
src/js/nav-v2.js        swipe navigation, animated tabs
src/vendor/supabase.js  vendored supabase-js UMD build (no CDN at runtime)
src/public/             manifest.webmanifest, icons/, sw.js (offline; __VERSION__ is filled in at build)
supabase/schema.sql     the full database schema + row-level security. Keep it in sync with the live project.
supabase/tests/rls_test.sql  security probes; safe to run on the live project (throwaway users, cleaned up)
tests/                  Playwright specs + harness.mjs (stand-in Supabase server that mirrors the RLS rules)
backup/                 the original single-file Claude artifact this project came from (restore point)
```

## Rules that matter
- **Edit `src/`, never `dist/`.** `dist/` is generated and git-ignored.
- **AI-neutral.** User-facing text must not assume any one AI. Say "AI" or "ChatGPT, Claude, Gemini or any AI app".
  Plans written by an AI are saved with `source:'ai'`. Plans saved by the first version say `'claude'`, and
  `fromAI()` in planner.js accepts both. Keep that for existing users' data.
- **Never treat a failed read as "no data."** Every account read and sync confirms the server sign-in first.
  Offline saves stay pending and merge on reconnect. Closing the app only saves real changes (`markClean`/`sigOf` in app.js).
- **Secrets stay out of synced data.** AI API keys live only in the device's localStorage (`ironlog-ai`),
  never in `state`, backups or Supabase. The Supabase password is derived from the account data key, never the user's password.
- **Database changes:** write a migration, apply it (Supabase MCP `apply_migration`), update `supabase/schema.sql`
  and `tests/harness.mjs` (`fakeSupabase` RLS), then run `supabase/tests/rls_test.sql` and the security advisor.
- **Crew privacy:** only members can read a group, and members write only under their own account. Don't add global reads.
- The service worker never caches Supabase or AI calls.
- Usernames map to synthetic emails `<username>@users.ironlog.app`. Supabase "Confirm email" must stay off.

## Commits
- Commits are authored by **Saumil Dedhia** `<32071583+saumild@users.noreply.github.com>`.
  Don't add AI co-author or session trailers to commit messages or PRs.

## Deploying
Pushing to `standalone` (the default branch) runs `.github/workflows/deploy.yml`: test, then build, then GitHub Pages.
The site only updates if all tests pass.
