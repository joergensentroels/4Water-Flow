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
possible and it is the one part of this stack that could change under a Node upgrade. The CI workflow is written
to run the suite on both the pinned LTS and current Node, so a breaking change shows up as a red build rather
than a broken deployment mid-season — but **it has never run: this repository has no remote yet.** Push it and
confirm the first build is green before relying on that. RUNBOOK says what to do if `node:sqlite` ever does move
under the app.

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

## What is NOT here

**One thing: an importer for the old workbooks, and that is deliberate.** The cutover plan (spec §7) switches at
a season boundary, and Score is per-season — so nothing needs importing except the ~40 people and the capability
matrix. Building a reader for 22 sheets and 86 MB of XML to avoid typing forty names in would be the expensive
way round.

Everything else is built: availability at two granularities, the shift exchange, the read-only plan, the planner
grid, auto-roster with proposals a planner locks or discards, leader/follower roles per session, notifications
with a Mattermost webhook and an outbox fallback, shift reminders, NextCloud OIDC with discovery plus invite
links, a subscribable calendar feed, GDPR retention/erasure/export, season rollover, and an operational status
page. `PLAN.md` lists all thirty-four increments.

> This section used to say auto-roster, notifications, OIDC, invite redemption and the planner grid were all
> missing, and that nothing consumed `invitations` or `auth_provider`. Every word of that was false by the time
> anybody would have read it. It survived because **no mechanical check covers a negative claim**: the suite
> verifies that everything these documents *name* exists, which cannot notice a sentence asserting something
> does not. If you land a feature, re-read this section — that is the only thing that catches it.

## Still to confirm with 4water

Some values in `config/pattern.json` are invented, and only 4water can settle them. **That file is the list** —
each is marked as a placeholder where it is set, with the reasoning beside it. Described here rather than counted,
because the count went stale the moment a fourth was added: three documents said "three" while the file listed four.

- **Clock times.** The Wednesday/Sunday rhythm is from the real export; the times were never stated anywhere.
- **`board.cutoffDays`** — how late a shift may be handed back. Spec question Q18, unanswered; `2` is a guess.
  Without a sensible value the shift exchange becomes the no-show channel.
- **`calendar.eventMinutes`** — how long a shift runs. 90 is invented.
- **`locale`** — `"en"`, while a complete Danish translation ships beside it. One word switches every
  volunteer-facing string and the page's declared language. `export.csvDelimiter` is set for a Danish spreadsheet
  in the same file, so the two currently point in different directions. Either answer is fine; it should be one.
- **One timeslot per day** is a modelling guess, not a limit. The real export has four parallel schedules, and
  several times on one day is normal and fully supported — add them on the Administration screen.

And one modelling question that is cheap now and expensive later: whether *"active volunteer"* is judged on the
current season only or a longer window. Longer means a slim per-person-per-season history import at cutover.

And the one question worth asking before a season is planned in this: **does anything in the rhythm happen
fortnightly or monthly rather than every week?** The weekly pattern creates a session on every matching date, so a
fortnightly activity cannot be expressed — it would have to be added weekly and half its dates cancelled by hand.
The spreadsheet has an `EveryNth` filter for exactly this and the app has no equivalent. If the answer is no, this
costs nothing; if yes, it is a small schema change and far cheaper now than later.

Three more, which are places the software differs from what the spec says — the reasoning is in `PLAN.md` under
"Four places this app differs from the spec":

- **Notifications have no email fallback.** The spec says email covers people who are not in Mattermost; the app
  writes an **outbox** page instead, because a zero-dependency SMTP client is a project of its own. Somebody has to
  read that page. **Do not promise email to a volunteer who is not in Mattermost** — it is real work, not a setting.
- **"Active volunteer" is a flag an admin sets, not a number derived from Score.** Deriving it would make a brand
  new volunteer inactive, so ineligible, so never given a first shift. Confirm that "active" in 4water's reports
  means *"not stood down"* rather than *"has done something this season"*; for a newcomer those disagree.
