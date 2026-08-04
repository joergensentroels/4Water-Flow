# Working on this

`npm test` runs everything. No network, no database, no services, no `npm install`. If any of that changes,
that is the news — not a detail.

```bash
npm test
```

To look at it:

```bash
node tools/demo.mjs
```

then start it with the developer sign-in enabled (the command is printed for you). Demo names are deliberately
`Demo One` / `demo1@example.invalid` so a demo database can never be mistaken for production.

## Six rules that are not preferences

**1. Zero dependencies.** `node:*` only. There is no `node_modules` and no build step, because the people who
inherit this are volunteers, and a dependency is something they will one day have to upgrade under pressure.
Adding one is a decision to discuss, not a commit.

**2. No Copenhagen vocabulary in code.** No activity name, no weekday name, no user-visible string outside
`config/pattern.json` and `strings/*.json`. `test/seams.test.mjs` fails the build otherwise — and it has caught
real slips, including an SQL comment and a test of my own. Another department will run its own copy with its
own files; a hardcoded name is a defect, not a shortcut.

**3. Eligibility is defined once.** `eligiblePredicate` in `src/queries.mjs`, used in four directions: the
board's listing, the claim guard, the planner's candidate list, and auto-roster. Two copies is how a volunteer
becomes able to claim something the board never offered. Adding the double-booking rule to it closed a real bug
in three places at once.

**4. Silence is not consent.** A volunteer with no availability answer is **unavailable**. Three states per
date, never two. Auto-roster and the børs both honour it; a planner may assign someone who has not answered
(and is told to go and ask them) but never someone who answered "cannot".

**5. Every increment adds tests that would fail without it.** A test that passes before the change tests
nothing. Prefer driving the real server on an ephemeral port over mocking — the bugs worth catching are in the
plumbing, and the two most embarrassing ones here were invisible to unit tests entirely.

**6. Mobile is the target.** The reported pain was "a nightmare to use on the phone". Phone-first is the
design, not a media query. Planners too: whoever fixes a Sunday-morning dropout is holding a phone.

## Where things live

| | |
|---|---|
| `src/*.mjs` | logic — one concern per file |
| `src/pages/*.mjs` | one screen each, rendering only |
| `src/server.mjs` | routes and wiring, no logic |
| `src/calendar.mjs` | the ICS feed: local-time→UTC via Intl, RFC 5545 escaping and folding, feed tokens |
| `config/`, `strings/` | the seams. Everything department-specific, and nothing else |
| `tools/` | things you run: backup, demo, bootstrap, the test harness |
| `docs/` | OIDC checklist, privacy position |

## Things that will trip you up

- **`node:sqlite` is synchronous.** `new DatabaseSync(...)`, `db.exec`, `db.prepare(...).run/get/all`. There is
  no `node:sqlite3` and no callbacks.
- **`node:sqlite` is a release candidate (Stability 1.2), and needs Node ≥ 22.13** — added in 22.5.0 but behind
  `--experimental-sqlite` until 22.13. `src/db.mjs` checks that at load, which is why it imports `node:sqlite`
  dynamically and carries a top-level await. `package.json` `engines` cannot enforce it: a project with no
  dependencies never has `npm install` run against it, so nothing ever reads that field.
- **`db.prepare()` will not mix `?` and `:named` parameters in one statement.** Pick one per query. Mixing them
  fails at bind time with "Provided value cannot be bound to SQLite parameter N", which reads like a type error
  and is not one.
- **Availability is keyed by DATE, not season**, so `ON DELETE CASCADE` does not reach it. Anything that deletes
  a season must sweep it — see `pruneSeasons`.
- **The clock is injected** (`buildApp({ today })`). Do not call `new Date()` in a handler; three separate calls
  is how the cutoff, the nudge window and "upcoming" drift apart.
- **`t()` returns the KEY when a translation is missing**, so a typo renders `board.claimOk` on a button rather
  than throwing. `test/strings.test.mjs` walks every `t()` call for exactly this reason.
- **Config edits write a file.** `buildApp` takes `patternFile` so tests never rewrite the repository's own
  config — which they silently did until it was caught.

## Before opening a pull request

- `npm test` green.
- If you touched a screen, **look at it in a browser** at 375px in both colour schemes. Four real bugs in this
  codebase were invisible to a passing suite: a 403 dead end, unstyled 404s, light-mode form controls on a dark
  page, and an administrator who could not reach the planner screen.
- If you added a `POST` route, `test/csrf-audit.test.mjs` will check it automatically. If you added an outcome
  code, add its message to both locales — a test checks that too.
- If you changed something a runbook step depends on, update `RUNBOOK.md`. It is the succession plan, and it is
  wrong the moment it stops matching.
