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

- **A string that explains WHY something is the case must be justified in `test/claims.test.mjs`.** Three such
  strings shipped confidently wrong — `/status` told operators no webhook was configured when one was, the
  outbox banner said nothing was delivered above rows marked Sent, and the planner blamed availability when
  nobody was even capable. None could fail a test, because a false explanation renders exactly as well as a
  true one. So any new one has to be listed with a note saying what makes it true. If you cannot write the
  note, reword the string to describe the state rather than its cause.
- **If you add a check that forbids a phrase or a character, do not write that thing into the comment explaining
  the check.** This has caught four separate commits now, so it is a rule rather than a joke. The comment saying
  "write `﻿` as an escape, never the literal character" contained three literal byte-order marks. The comment
  explaining that a test count had gone stale quoted the stale count — twice, in two files. The comment explaining
  that the throttled-endpoint list must not be given as a number gave it as a number. In each case the new gate
  failed on its own documentation, which at least means the gate worked. Describe the forbidden thing, assemble
  test fixtures from parts at runtime (`seams.test.mjs` and `docs.test.mjs` both do), and expect the first run to
  catch you.
- **When you prove a check by breaking the code, verify the break landed.** The rule below about sweeps —
  sabotage a colour and confirm the report names it — has a failure mode one level up: if the sabotage silently
  does not apply, the run comes back green and that is indistinguishable from a working control. It has happened
  three times here: a find-and-replace whose target string had changed, one that left the value it was supposed
  to remove, and one where the pattern being searched for was matched by the *comment* explaining the fix rather
  than by any code. Each produced a clean run that read as evidence.
  So: assert the file actually changed, and when a check is meant to fail, print something distinguishable from
  a pass rather than letting a zero speak for itself. This matters most for a probe you expect NOT to fire,
  because then a silent no-op agrees with you. Two claims in these comments — that `handBackSlot`'s old unchecked
  branch was unreachable, and that a table-derived test cannot notice a missing entry — rest on exactly that kind
  of probe, and were re-run with the landing check before being trusted.
  No tool for this is committed on purpose: it is a habit, not a fixture, and the project's own answer is still
  the stronger one — write the test first and watch it fail before the fix exists.
- **`test/journey.test.mjs` is the acceptance gate, and it deliberately does not use `tools/testkit.mjs`.**
  Everything else builds its world with that harness, and twice the harness supplied something production did
  not — open slots, and a notifier — so a green suite reported success over a deployment that could not work.
  The journey boots `node src/server.mjs` on an empty database under `NODE_ENV=production` and walks the whole
  thing over HTTP: bootstrap, invite, sign in, capability, availability, claim, calendar feed, auto-roster, lock
  in, hand back, outbox, CSV, export. If you add a feature that a real deployment has to wire up, add it there
  too — that file is the only one that can tell you it was never wired.
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

## Contrast and target size — the standard, and how to check it

Nothing in this repository said what accessibility standard was applied, which meant the next person to change a
colour had no way to know a check existed. It does, and the numbers matter for volunteers reading a schedule on a
phone outdoors.

**The standard.** WCAG 2.2 **1.4.3** for text (4.5:1, or 3:1 for large text), **1.4.11** for the visual boundary
of an author-styled control (3:1), and **2.5.8** for target size (24×24 CSS px, or spacing that keeps 24px circles
on adjacent targets from overlapping). Native radios and checkboxes are exempt under 1.4.11's default-rendering
exception and are skipped.

**Where it currently stands**, measured over every screen in both colour schemes:

| | text floor | controls floor |
|---|---|---|
| Light | 5.99 (a link on `/admin`) | 3.66 |
| Dark | 7.14 (a hint on `/availability`) | 3.24 |

Both are above the minimum with margin, so a palette change has room — but not much on the dark controls.

**Two things that make this check lie if you do not know them:**

1. **Content inside a collapsed `<details>` is not measured.** `getComputedStyle` reports it as `display: none`
   and any sane sweep skips it — so the planner's distribution card and the availability bulk actions are
   invisible to the check until every `<details>` is opened first. A sweep that has not done that reports zero
   failures while never having looked at them. This is exactly how "I reasoned the new CSS adds no new colour
   pair" nearly became a verified claim without a measurement behind it.
2. **A sweep that finds nothing must be shown to find something.** Give one rule a deliberately failing colour and
   confirm the report names it. Doing that is what proved the distribution rows were being reached: sabotaging
   `ul.dist small` produced `failures=1, floor=1.39, on /planner`, which the clean run could not have told you.

The colour tokens themselves also carry their reasoning: 4water's own water blue measures 3.3:1 on white, which
fails 1.4.3, so `--accent` is a darker relative of it. Do not "correct" it back to the brand hex.

## Before opening a pull request

- `npm test` green.
- If you touched a screen, **look at it in a browser** at 375px in both colour schemes. Four real bugs in this
  codebase were invisible to a passing suite: a 403 dead end, unstyled 404s, light-mode form controls on a dark
  page, and an administrator who could not reach the planner screen.
- If you added a `POST` route, `test/csrf-audit.test.mjs` will check it automatically. If you added an outcome
  code, add its message to both locales — a test checks that too.
- If you changed something a runbook step depends on, update `RUNBOOK.md`. It is the succession plan, and it is
  wrong the moment it stops matching.
- **If you landed a feature, re-read README's "What is NOT here" section.** `test/docs.test.mjs` verifies that
  everything these documents *name* exists — a path, a route, an environment variable, a config key, a function.
  It cannot notice a sentence asserting something **does not** exist, because there is nothing to look up. That
  section once listed auto-roster, notifications, OIDC, invite redemption and the planner grid as missing, long
  after all five shipped, and claimed nothing consumed `invitations` — in the file a reader opens first. No check
  will catch the next one; reading it will.
