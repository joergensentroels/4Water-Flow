# 4water scheduling — slice 1 (data layer)

Volunteer scheduling for 4water. This is **slice 1 only**: schema, seeding, and the vagtbørs behaviour.
No HTTP, no login, no UI — those are later slices. Design decisions and open questions live in
`../4water-scheduling-spec.md`.

```bash
npm test
```

Zero dependencies. Node ≥ 22.5 for the built-in `node:sqlite`, and `node:test` for the suite. Nothing to
install; there is no `node_modules`.

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
`ELIGIBLE_OPEN_IDS` in `src/queries.mjs` is shared by the board listing and the claim guard. Two copies
would drift, and the drift is not cosmetic — a volunteer could claim a slot the board never offered them.

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
