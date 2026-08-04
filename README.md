# 4water Flow

Volunteer scheduling for 4water: availability, a shift exchange, the plan, planning with an auto-roster, and
administration. Phone-first, because the reported pain with the spreadsheet it replaces was "it's a nightmare
to use on the phone". Design decisions and open questions live in `../4water-scheduling-spec.md`.

```bash
npm test
```

```bash
node tools/demo.mjs
```

That builds `demo.db` and prints how to start it with the developer sign-in enabled. `RUNBOOK.md` is the real
deployment; `CONTRIBUTING.md` is how the code is laid out and what will trip you up.

Zero dependencies. Nothing to install; there is no `node_modules`.

**Node ≥ 22.13** (or ≥ 23.4 on the newer line). Not 22.5, which this file used to claim: `node:sqlite` was
*added* in 22.5.0 but sat behind `--experimental-sqlite` until 22.13.0, so 22.5–22.12 cannot run this at all.
`src/db.mjs` checks the version and says so, rather than dying at `No such built-in module: node:sqlite`.

`node:sqlite` is **Stability 1.2, "Release candidate"** — not stable. It is what makes zero dependencies
possible and it is the one part of this stack that could change under a Node upgrade. CI runs the suite on
both the pinned LTS and current Node so that shows up as a red build rather than a broken deployment; see
RUNBOOK for what to do if it ever does.

## The four decisions that shape everything else

**1. `assignments.person_id` is nullable, and that is load-bearing.**
A row with no person *is* an open slot. So "nobody ever took this" and "someone handed it back" are the same
state, which means the vagtbørs is one query over one table — no exchange table, no state machine, no
planner approval step. It also makes claiming race-safe for free: the `WHERE person_id IS NULL` guard *is*
the concurrency control, and the loser of a race sees `changes === 0`.

**2. Score is never stored.**
It is `COUNT(*)` of a person's confirmed assignments in a season. Storing it would recreate exactly the
staleness the spreadsheet already fights. Only `confirmed` counts — an auto-roster proposal the planner has
not locked in is not something the volunteer has done.

**3. Eligibility is defined once.**
Five named gates in `src/queries.mjs` — is the slot open, is the person capable of the activity, does the role
match, have they said they are free, are they already busy at that hour — composed into one predicate that the
board listing, the claim guard, the planner's candidate list and auto-roster all build on. Two copies would
drift, and the drift is not cosmetic: a volunteer could claim a slot the board never offered them, or a planner
could be shown a suggestion the system would then refuse.

The gates are named individually rather than written as one block because two screens have to explain
themselves. "Nothing here you can take" and "nobody can take this" both mean *one of these five gates emptied
the list*, and saying which one requires relaxing them one at a time — from the same definition, so an
explanation cannot drift into contradicting the rule it describes.

**4. Silence is not consent.**
A volunteer with no availability row counts as **unavailable**, not available. Assigning someone who never
answered is precisely the failure the availability nudge exists to prevent.

## Availability has two granularities

`availability_day` and `availability_hour`, because the source workbooks have both ("per Day" and
"per Hour"). An hour-level row overrides the day-level row for that hour; if neither exists, see decision 4.

## The seams — why no Copenhagen vocabulary is in the code

Another department will run its own instance with its own files, so **every** activity name, weekday name and
user-visible string comes from `config/pattern.json` and `strings/<locale>.json`. `test/seams.test.mjs`
enforces it by scanning string literals under `src/` and `test/`, and it also proves it can fail by planting
a name at runtime and asserting the check fires.

It scans string literals only, not whole files: a literal can reach a user's screen, a comment cannot.
Comment-scanning would also forbid writing a weekday name next to the column that means one, which makes the
code worse for no safety gain. The extractor is a hand-written scanner rather than a regex — the first
version was a regex and reported three offences that were all prose inside comments.

## What is NOT here yet

Auto-roster, notifications (Mattermost webhook), OIDC, invite redemption, the planner grid, the importer.
`invitations` and `auth_provider` exist in the schema because retrofitting an identity column later is far
more expensive than carrying it now — but nothing consumes them.

## Confirm before building slice 2

- Clock times in `config/pattern.json` are **placeholders**. The Wed/Sun rhythm is from the real export; the
  times were never stated.
- `board.cutoffDays` is spec question Q18 and unanswered. `2` is a guess.
- Whether "active volunteer" is judged on the current season only or a longer window. If longer, a slim
  per-person-per-season history import is needed at cutover.
