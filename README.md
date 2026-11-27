# Iron Log

A workout tracker for getting strong, athletic and lean without bodybuilding. You log strength,
yoga and no-equipment home sessions, and get an AI coach that works with whichever AI you already use.

**Open it:** https://saumild.github.io/iron-log/. On iPhone, tap **Share → Add to Home Screen** to
install it. It works offline.

## What it does
- **Train:** a daily plan (strength, yoga or home), live set logging, rest timers, routines, supersets and PRs.
  Every session is kept to 30–45 minutes.
- **Coach:** AI plans, yoga flows, coaching and photo form checks, plus a built-in rule engine for progressive overload.
- **Stats:** volume, PRs, streaks, XP and levels, measurements, check-ins, and recovery data from Apple Health.
- **Crew:** a private group of friends you invite with a link. Share workouts, 💪 likes, comments,
  nudges and a buddy streak. Your full training log stays private.

## Your data
- You sign in with an **Iron Log username and password**. Your workouts are **encrypted on your phone** before
  they are stored, so the server only ever holds scrambled data. Keep the recovery code you're given when you
  sign up: if you lose your password, it is the only way back in.
- Your data syncs between your devices. If you're offline, workouts save on the phone and sync later. If two
  devices changed things meanwhile, they're merged rather than overwritten.
- **Back up** any time from the **You** tab.

## AI: use any assistant
Go to **You → AI coach** and pick one:
- **Copy & paste** (default, no key): Iron Log copies a prompt. Paste it into ChatGPT, Claude, Gemini or any
  AI app, then paste the reply back.
- **OpenAI, Anthropic or Google Gemini:** paste your own API key and the AI runs inside the app. The key stays
  on that device only. It's never synced or included in backups.

## Apple Health (iPhone)
No website can access Apple Health directly, so two small Shortcuts do it. The app shows step-by-step
setup for both:
- **Daily import:** a morning automation reads weight, sleep, resting heart rate, steps and exercise minutes,
  and opens Iron Log with the data. Nothing to paste.
- **Save to Apple Health:** on the workout summary, sends the session to Health so it counts toward your Activity rings.

## Run your own copy
1. Fork this repo. In **Settings → Pages**, set the source to **GitHub Actions**.
2. Create a Supabase project and run `supabase/schema.sql` in its SQL editor. Under **Authentication →
   Sign In / Providers → Email**, turn **off** "Confirm email".
3. Put your project URL and publishable key in `src/js/config.js`. Leave them blank to run
   on-device only (no sync, no Crew).
4. Push. The workflow runs the tests, then publishes.

## Develop
```
npm ci && npx playwright install chromium
npm test        # build + all tests
```
See `CLAUDE.md` for the code layout and project rules.
