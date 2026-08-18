# 4water Flow

Volunteer scheduling for 4water: availability, a shift exchange, the plan, planning with an auto-roster, and
administration. Phone-first, because the reported pain with the spreadsheet it replaces was "it's a nightmare
to use on the phone". Design decisions and open questions live in the discovery document, **"4water scheduling —
spec"**, which is 4water's own record and is deliberately not in this repository. Ask whoever handed you this
for it; nothing here depends on having it, and every decision it settles is also explained where it applies.

**Another organisation can run this.** It was built for 4water, but nothing about Copenhagen, salsa or Danish
is in the code — every activity name, weekday and user-visible string comes from `config/pattern.json` and
`strings/<locale>.json`, and `test/seams.test.mjs` fails the build if one leaks into `src/`. See *The seams*
below.

To adapt it you edit configuration, not code: your activities and weekly rhythm in `config/pattern.json`, your
season dates, `calendar.timezone`, and `locale`. **Danish and English ship complete** (421 keys each, kept in
step by a test), so a Danish or English-speaking org changes one word; another language means one new
`strings/<lang>.json`.

It runs from a clone with no install and no build step — Node >= 22.13 and SQLite, zero runtime dependencies.
`RUNBOOK.md` covers deployment, backup and handover. It is AGPL-3.0: run it, adapt it, and if you offer it as a
service, share your changes back.

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
possible and it is the one part of this stack that could change under a Node upgrade. CI runs the suite on both
**22.14** (what the Dockerfile pins) and **24**, so a breaking change shows up as a red build rather than a broken
deployment mid-season. RUNBOOK says what to do if `node:sqlite` ever does move under the app.

> This paragraph used to end *"it has never run: this repository has no remote yet"*. By then it had a remote and
> CI had run **thirteen times and gone red thirteen times**, and nobody looked — the notification said only "All
> jobs have failed" and the run page says "Sign in to view logs". **The two-version matrix earned its keep the moment it
> was readable**: `ALTER TABLE … DROP COLUMN` throws on the SQLite that Node 22.14 bundles and not on 24's, which
> is precisely the class of thing this matrix exists to catch and precisely the version that gets deployed. Three
> more defects were only ever visible there, and two of the tools meant to police this suite had **never once run
> to completion** on that Node. Same trap as the section above: no mechanical check covers a negative claim, and
> "CI has never run" is one.

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
matrix. Building a reader for 22 sheets and 86 MB of XML to avoid that would be the expensive way round.

**But be honest about what "that" is, because the sentence above used to say "typing forty names in" and the
capability matrix is the larger half.** Concretely, at cutover somebody sits down and does:

- ~40 invitations, one address at a time, each needing the volunteer to open the link and accept.
- **the capability matrix — up to 40 × 6 = 240 toggles.** The Administration screen has one button per person per
  activity and no JavaScript, so each is a form submission and a page reload. Half an hour of clicking, not five
  minutes, and worth putting in somebody's calendar rather than discovering at the season boundary.

**A wrong capability is silent, so check the matrix afterwards.** Nothing validates it: a volunteer you forgot to
mark as a Salsa leader is simply never offered Salsa, and the shift exchange tells them *"Nothing is open in the
activities you run"* — which is true, and hides the mistake. The Administration screen lists each person's
capabilities as text, so the check is to read that roster against the sheet once, before the season opens. If the
matrix ever grows past a few hundred cells, that is the point to reconsider an importer — not before.

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
- ~~**`board.cutoffDays`**~~ — **settled by 4water: `7`.** A week's notice, so there is realistic time to find a
  replacement. It does not block the hand-back; it marks it as short notice in the flash and in the channel
  announcement, so a planner sees the urgency without the volunteer having to relay it. `2` was the placeholder.
- **`calendar.eventMinutes`** — how long a shift runs. 90 is invented.
- **`locale`** — `"en"`, while a complete Danish translation ships beside it. One word switches every
  volunteer-facing string and the page's declared language. `export.csvDelimiter` is set for a Danish spreadsheet
  in the same file, so the two currently point in different directions. Either answer is fine; it should be one.
- **One timeslot per day** is a modelling guess, not a limit. The real export has four parallel schedules, and
  several times on one day is normal and fully supported — add them on the Administration screen.

And one modelling question that is cheap now and expensive later: whether *"active volunteer"* is judged on the
current season only or a longer window. Longer means a slim per-person-per-season history import at cutover.

**Cadence, and alternation.** 4water confirmed that not everything runs weekly: the evening class **alternates**
between the two dances rather than running them together. A weekly entry therefore takes two optional fields.
`everyNth` is how often — absent or `1` every week, `2` fortnightly, up to `8`. `weekOffset` is **which** of those
weeks, and without it alternation cannot be expressed at all: two fortnightly entries at the same hour would both
land on the same weeks. Two entries, same time, offsets `0` and `1`, take turns. The shipped
`config/pattern.json` now does exactly that, and the Administration screen offers both fields when a slot is added
and shows them for every slot listed.

Phase is counted in whole weeks from `season.from`, which is what makes a mid-season reseed idempotent — anchoring
it anywhere else would move a fortnightly slot to the opposite week whenever somebody edited the pattern. Holidays
do not shift it either: a suppressed date uses up its turn, as a cancelled class does in life.

Two consequences worth knowing. A day and a time **no longer identify a slot**, so removing one now matches on the
cadence too — without that, dropping one dance silently dropped the other. And an offset that can never come round
(`weekOffset` at or above `everyNth`) is refused at load rather than producing a slot that quietly never runs.

**Which dance falls in the season's first week is confirmed: salsa**, checked by 4water against the real rhythm.
Offset `0` is salsa on purpose rather than as a placeholder, so leave the two offsets alone unless the rhythm
itself changes — swapping them puts every evening of the season on the wrong dance.

Three more, which are places the software differs from what the spec says — the reasoning is in `PLAN.md` under
"Four places this app differs from the spec":

- **Notifications have no email fallback.** The spec says email covers people who are not in Mattermost; the app
  writes an **outbox** page instead, because a zero-dependency SMTP client is a project of its own. Somebody has to
  read that page. **Do not promise email to a volunteer who is not in Mattermost** — it is real work, not a setting.
- **"Active volunteer" is a flag an admin sets, not a number derived from Score.** Deriving it would make a brand
  new volunteer inactive, so ineligible, so never given a first shift. Confirm that "active" in 4water's reports
  means *"not stood down"* rather than *"has done something this season"*; for a newcomer those disagree.
