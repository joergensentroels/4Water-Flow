# Execution plan — 4water scheduling

Planned as ten increments; it ran to thirty-four (A–Z, then AA–AH), and the lettering stops there: the work
after AH is one defect per commit, so read `git log` for it rather than counting rows in the table below and
concluding the project ended at AH. **Each one ends with `npm test` green and is independently
shippable**; the app is usable by volunteers from D onward even while planners are still on the spreadsheet.

**Not only defects any more.** 4water answered the questions from the spec read-back, and the answers were feature
work: attendance counting (which forced Score into two numbers — see item 5 below), an audit trail with a screen to
read it, disclosure of both to the board and to volunteers, and public holidays suppressed by default with the
planner opting a date back in. Still one thing per commit, still `git log` as the record. **One thing they asked for
is NOT built: a chat facility**, which needs a decision between a planner broadcast and per-slot notes — Mattermost
already runs with the same sign-in, so a third general chat is the option worth arguing against. Shift swaps are
noted but not designed.
Order follows `../4water-scheduling-spec.md` §5, which front-loads the pain that was actually reported (mobile,
and chasing cover) rather than the part that is most interesting to build — auto-roster is eighth on purpose.

Status: **✅ A–AH complete plus the commits since, 440 tests green** — and green in a fresh `git clone` of the
current commit, not only in the working copy where the tests were written.

That last part is checked rather than assumed, because it has been false before: three tests once read a file
`.gitignore` excludes, so they could only ever pass on the machine that wrote them. Re-verified after the recent
run of new test files, one of which reads `.env.example`, `compose.yml`, the `Dockerfile` and `.github/workflows` —
any of which a clone could have been missing. **And the clone run was itself controlled**: `ROOT` was confirmed to
resolve inside the clone, and a false claim planted in the clone's `README.md` failed the clone's suite while the
original stayed clean. Without that, a clone whose tests silently read the original would report a green run that
means nothing.

**Read "Still not verified" below before trusting that number.** A green suite twice reported success over a
deployment that could not have worked, and why is written down there rather than left for somebody to rediscover.

## Round two: K–P

The first pass declared itself done while a fresh deployment was a locked door — it migrated but never seeded,
and there was no way to become the first administrator. Round two therefore began by opening the app in a
browser, which found four more bugs a green suite could not see.

| | | |
|---|---|---|
| **K** | demo instance + real-browser pass | found the admin/planner 403 dead end, missing `color-scheme`, unstyled 404/405; measured the availability screen at 3,750px / 153 controls |
| **L** | availability bulk actions | all dates, per weekday, scopes derived from the data; plus the volunteer-facing privacy notice |
| **M** | error pages + CSRF audit | every status through the layout with a way out; the audit walks the app's OWN route table rather than a list somebody maintains |
| **N** | retention, erasure, export | reported not silent; erasure offers anonymise or remove and makes the board choose; per-person JSON and season CSV |
| **O** | profile + operational status | rectification and own-data download; the status page leads with whether the season is current, because a past season looks identical to a broken app |
| **P** | rollover + release engineering | next season pre-filled and validated; LICENSE, CONTRIBUTING, CI, a real version |

## Round three: Q–X

P declared itself finished. Everything below was found afterwards, and the pattern is worth more than the list:
**each increment's defect was in the path adjacent to the one just fixed.** Fix the planner's page size, miss the
admin's. Refuse a `Host`-derived URL for the calendar link, leave the invite link building one. Explain an empty
shift exchange, leave the planner's empty candidate list asserting the wrong cause. By the fourth time it was
cheaper to enumerate siblings deliberately than to keep discovering them.

| | | |
|---|---|---|
| **Q** | edit the weekly pattern from Administration | add and remove timeslots; one validator for load and for save |
| **R** | version control | first commit, `.gitattributes`, CI |
| **S** | OIDC endpoint discovery | replaces three hardcoded NextCloud paths; every discovered endpoint must be same-origin and https, because the token endpoint receives the client secret |
| **T** | the Node floor, target sizes, the outbox | `>= 22.5` was wrong in three places — `node:sqlite` was behind a flag until 22.13; the planner's assign dropdown measured 117×19px; every composed message was written where nobody could read it |
| **U** | leader and follower per session | `needs` per activity; one slot per role; the eligibility rule gained the role gate so board, planner and auto-roster inherit it together |
| **V** | 4water's visual identity | black-and-white frame from their site, a water blue chosen because theirs measures 3.3:1 on white, droplet drawn inline because the CSP forbids remote images |
| **W** | subscribable calendar feed | UTC instants resolved through `Intl` rather than a hand-written VTIMEZONE; the link is a revocable credential stored only as a hash |
| **X** | what a green suite could not see | a fresh deployment opened **no slots at all**; the notifier and nudge timer were never wired in production; three UI strings asserted causes that were false; invitations were never deleted; the admin screen was 953 KB |
| **Y** | OIDC end to end, and the image's filesystem | `auth.mjs` said the callback "CANNOT be exercised without a provider", which was untrue and was itself the obstacle: a conforming provider in 90 lines proved PKCE, discovery, and three refusals. Then the same shape one layer down — `deploy.test.mjs` checked the Dockerfile's *inputs*, which cannot fail the way a build fails |
| **Z** | the distribution nobody could see | `workloadSpread` was computed for the tests and shown to no one, while a planner locked in 178 proposals blind. Measuring the roster from zero found it evens COUNTS as well as availability permits — and concentrates three of four broad volunteers onto one weekday. Reported, not silently "fixed": which of those is capture and which is continuity is 4water's judgement, not mine |
| **AA** | the nudge job accounts for itself on `/status` | The page reported seven facts and not the one whose absence hid the worst defect here: a job with nobody to nudge and a job that is dead both produce silence. `jobs` is optional on `buildApp`, the same shape that left `notifier` out of production, so the journey test asserts the line renders on a real boot — a monitor must not carry the defect it monitors |
| **AB** | the suite only ran where it was written | Three of the four tests that boot the real server — including the acceptance gate — read a file `.gitignore` excludes, so they failed with ENOENT on any clone. Invisible because there is no remote: CI has never executed once, so nobody had ever cloned it. Found by a negative control failing on its CONTROL case, which meant my harness was wrong rather than the code |
| **AC** | the export was unreadable for the people it is for | No BOM, so every Danish name arrived as mojibake in the one artefact the board opens; and a comma delimiter puts every row in one cell on a Danish locale. The first is a fix, the second is configuration — comma is RFC 4180, and which one is right depends on who opens the file |
| **AD** | the shift reminder | `src/calendar.mjs` opens by saying missed shifts are the failure this app exists to prevent, and the answer so far reached only volunteers who went and subscribed to a feed. Confirmed shifts only — telling somebody to show up for a proposal is worse than silence. Keyed on the assignment id, so the existing UNIQUE constraint means one reminder per person per shift, ever |
| **AE** | the documents, and the strings, checked both ways | Every mechanically checkable claim in six documents (84 of them) now verified by a test; translations checked in the unread direction too, which turned up seven strings nothing was showing |
| **AF** | lists that cannot notice their own gaps | Three hand-kept lists existed for tests to check against — notification kinds, board reasons, planner reasons — each with a comment promising that a missing entry would fail. None could: a list of what to check cannot notice something absent from itself. Now derived from the source, and a gate with no reason code refuses to load rather than telling a planner `undefined` |
| **AG** | name the volunteers who have not answered | A count is not actionable, and chasing cover is half of why this exists. Capped at eight with the rest counted; escaped, because this is the first user-supplied name on that screen. Written after four load-bearing correctness properties — ICS folding, DST, the hour-over-day availability override, the claim race — were checked and all found already right |
| **AH** | the upgrade path, the recovery drill, and one home per fact | `applyColumnAdditions` had never executed anywhere: on a fresh database the columns already exist, so every test ran it as a no-op while the branch that alters a table — the upgrade path for a live deployment — had never run. Coverage then found four more never-executed branches. Also: the app now boots against a *restored* backup rather than merely opening one, and three documents stating the test count (129, 330, 330, against 338) are down to one |

## Four places this app differs from the spec — three deliberately, one only noticed later

Every one of the tests verifies the implementation against itself. The spec is outside that loop, so a requirement
quietly dropped is invisible to all of them. Read back against `../4water-scheduling-spec.md` §2, three sentences
in the spec are not true of the software. All three were reasoned about at the time and two of them only in a code
comment, which is not where somebody holding the spec will look.

**1. An ineligible claim.** Increment D's criterion said *"an ineligible claim is a 403 with the right message."*
It is a **303 redirect with a flash message on the board** instead. A 403 hands the volunteer an error page and
loses the board they were looking at; the redirect puts *"You cannot take this slot"* on the page they are already
on, next to the slot in question. The guard is identical either way — `claimSlot` refuses before anything is
written, tested directly. **The criterion was wrong, not the code.**

**2. "Email stays the fallback for people who are not in Mattermost."** It does not. The fallback is an **outbox**
— a page listing what would have been sent, with a copy of each message. `src/notify.mjs` gives the reason and it
is a good one: a zero-dependency TLS-and-auth SMTP client is a project of its own, and the wrong thing to hand a
volunteer-run nonprofit to operate. What the outbox costs is that somebody has to look at it; `/status` reports the
backlog so it is not silent. **If 4water wants email, that is a real piece of work and not a setting** — say so
before promising it to a volunteer who is not in Mattermost.

**3. "Score … determines whether a volunteer counts as *active*."** In the spreadsheet it does — that is what
`Imported ActiveCph Names` reflects. In the app, `people.status` is an **authored** column an admin sets, and
nothing derives it from Score. That is not laziness: deriving "active" from Score would mean a volunteer with no
assignments yet is inactive, therefore excluded from eligibility, therefore never assigned a first shift. A
bootstrapping paradox that would make the app unusable for exactly the people it most needs to reach. Score is
still derived and never stored, as the spec requires, and it still drives fairness and the planner's overview —
only the *active* flag is separate. Worth confirming with 4water that "active volunteer" in their reports means
"not stood down" rather than "has done something this season", because those diverge for a newcomer.

**4. The spec's `Distribution Modifier` has no equivalent, and until now no record either.** §1 documents a rules
engine in the existing spreadsheet: `Add`, `Remove`, `Replace(old→new)`, `ClearSet`, scoped by `FromDate`/`ToDate`
and filtered by `EveryNth`, `Timeslot`, `DayName`. The phrase appears nowhere in this repository — not in code, not
in a document, not in the config. Judged operation by operation rather than as a whole:

- `Add` and `Remove` over a date range are effectively covered. The Administration screen edits the weekly pattern
  and reseeds from today onward, which is how you start or stop a slot.
- `Replace(old→new)` has no equivalent. Removing a weekly slot and adding another leaves the sessions already
  created for the old one, by the policy stated on that screen — so a mid-season swap of one activity for another
  is a hand edit per date.
- `ClearSet` has no equivalent beyond unassigning one slot at a time on the planner grid.
- **`EveryNth` is the one that matters, and it is a hard limit rather than a chore.** `timeslots` carries a
  `day_of_week` and a time, and `seedSeason` creates a session on *every* matching date. A fortnightly or monthly
  activity cannot be expressed at all. An admin wanting one would have to add it weekly and then cancel half the
  dates by hand, which the config would not show and nothing would explain to a volunteer looking at the plan.

Nobody has asked 4water whether anything in their rhythm is fortnightly. If the answer is no, this costs nothing
and the note can go. If the answer is yes, it is a schema change (a recurrence rule on `timeslots`) and much
cheaper to know now than after a season has been planned. **This is the one gap found in the read-back that is a
missing capability rather than a wording difference.**

**5. Score is now two numbers, and the spec describes one.** §2 defines Score as *"the number of activities a
person has had this season"* with two uses: balancing the load, and the contribution record. 4water asked for the
record to count activities **attended**, which is right — somebody who takes four shifts and turns up to one has
not contributed four. But attendance is backward-looking and the balancing number is forward-looking, so one
column cannot do both jobs:

> a volunteer holding four shifts next month has attended none of them. An auto-roster balancing on attendance
> reads that as under-loaded and hands them a fifth. **Every unstarted shift makes them look emptier.**

So `score()` stayed the count of confirmed assignments and now means **load** — what auto-roster balances, what
the planner's candidate list orders by, and what the børs redistributes, exactly as §5's ⚠ note requires.
`attendedCount()` is the new backward-looking figure. The spec's sentence is true of neither alone and both
together; a planner sees load on the grid and marks attendance from a backlog card. `isActive` deliberately still
reads load, for the same bootstrapping reason as item 3 — a newcomer who has signed up but not yet run anything
must not read as inactive. **Nothing is missing; one number in the spec is two in the app, on purpose.**

Checked and **held** in the same pass, so the list above is exhaustive rather than the part I happened to notice:
Score is derived and never a stored column; locked assignments are immune to later auto-roster runs
(`autoRoster` only claims rows with `person_id IS NULL`, and `discardProposals` only clears `state='proposed'`);
auto-roster reads Score *after* børs activity, because `confirmedTally` runs inside it against the live table; the
three roles are named as the spec names them; and the scale figures are measured at the size the spec states.

## Measured, not assumed — at the size the spec actually describes

Measured twice. First at 200 volunteers with six slots a week (257 sessions, 10k availability rows), and again
after roles doubled the assignment rows for every partner dance — 200 volunteers, a busier weekly rhythm than
Copenhagen's, 380 sessions, 586 slots, 22,080 availability rows, a 1.1 MB database.

**Speed is not the problem at this size, and saying so is the point of measuring.** Second run, real HTTP
responses: home 14ms, shift exchange 11ms, planner 2ms, status 13ms, CSV 15ms, auto-roster over four weeks
137ms. `node:sqlite` and a hand-rolled router are nowhere near being the bottleneck for a volunteer
organisation, and anyone optimising them here is guessing.

**Page size was the problem, twice, and the second time was the same mistake as the first:**

| | before | after |
|---|---|---|
| `/planner` HTML | **534 KB** | **84 KB** (four-week default) |
| `/planner` queries | 257 | 40 |
| `/admin` HTML | **953 KB** | **127 KB** (25 people, searchable) |
| `planForSeason` | 1 query, 4 ms | unchanged |
| a volunteer's board | 1 query, 1 ms | unchanged |
| `autoRoster`, whole season | 276 ms, 414 queries | unchanged |

`/admin` carried twelve small forms per person — three roles, six capabilities, status, export, two erase modes
— each with its own CSRF token, so 200 people was about 2,400 forms. Identical defect to the planner's, fixed
there first, written up there first, and not looked for one file away. The aggravating detail: `/planner?weeks=all`
is 647 KB and somebody chose it by clicking "the whole season"; `/admin` was what you got by tapping the tab.

Two measurements deliberately **not** acted on, with the reasoning rather than silence: `/availability` (194 KB)
and `/plan` (128 KB) scale with **season length, not headcount**, so they are identical for Copenhagen's forty.
Capping availability would stop a volunteer answering the season in one pass, which is how the nudge and the bulk
actions are meant to be used.

Two real defects came out of the first run, neither visible to a passing suite:

1. **The planner's candidate list was alphabetical while auto-roster ordered by fairness.** Same eligibility
   rule, two different answers to "who should take this" — so a planner filling gaps by hand kept picking
   whoever came first in the alphabet while the machine balanced. The practical effect is one volunteer quietly
   overloaded, which is the exact thing Score exists to prevent. Now both order by fewest activities first, and
   the dropdown shows each candidate's count.
2. **Half a megabyte of HTML on a phone.** The planner now defaults to four weeks with links to widen.

## Still not verified — flagged where it matters, not buried

### What a green suite could not see, twice

Read this first, because it is the part that should change how much anyone trusts the number at the top.

Two features were **completely dead in production** while their tests passed, and both for the same reason:
`tools/testkit.mjs` supplied something the real boot path did not, so every test ran against a world the
deployment never had.

1. **A fresh deployment opened no slots at all.** `seedStructure` creates sessions; `openEverySession` creates
   the open assignment rows a volunteer claims and a planner fills. Production called only the first. Booted on
   an empty database: **102 sessions, 0 assignments.** The shift exchange had nothing to claim, the planner
   nothing to assign, auto-roster nothing to propose, and `/status` reported "0 of 0 slots unfilled", which reads
   as healthy. The same hole was in the admin's config edit and in the season rollover. Worse: `rollover.test.mjs`
   **asserted the count was zero**, with a comment of mine explaining that `openEverySession` "is not part of a
   rollover" — a test holding the bug in place.
2. **The notifier and the nudge timer were never wired.** `makeNotifier` and `startJobs` were called only from
   tests. So no announcement ever fired, the availability nudge never ran once, and the outbox was permanently
   empty — while seventeen tests proved the machinery worked, all of them passing in a notifier production did
   not have.

The countermeasure is `test/journey.test.mjs`, which touches the harness nowhere: it boots `node src/server.mjs`
on an empty database under `NODE_ENV=production` and walks the whole product over HTTP. It is the slowest test in
the suite and the only one that would have caught either. **If you add something a real deployment has to wire
up, add it there too.**

### Still unproven

- **The Docker image has never been built.** No Docker, no Podman, and no WSL distribution on this machine —
  checked, not assumed. Said plainly at the top of `RUNBOOK.md`. What *is* verified went up a level once I
  noticed `deploy.test.mjs` was checking the Dockerfile's **inputs**: "every `COPY` path exists in the repo"
  cannot fail for the reason a real build fails, because the repo has every file. So `test/image.test.mjs`
  now materialises exactly the `COPY` set into an empty directory and runs `src/server.mjs` from there under
  the image's own `ENV` — proven able to fail by omitting each path in turn. It still cannot see a broken base
  tag (it runs the host's Node), so the base tag is checked statically against the floor `db.mjs` enforces.
  What remains genuinely unproven is the build itself: layer caching, the `apk` layer, and file ownership
  under `USER node`.
- **OIDC has never talked to a real NextCloud** — but it is no longer unexecuted, and the distinction matters.
  I repeated "never verified end to end" often enough that it started sounding like a fact about the world
  rather than about the tooling I had reached for. A conforming provider is a few hundred lines, so
  `test/oidc-endtoend.test.mjs` now runs the whole flow over real HTTP against one: discovery is fetched and its
  published paths used, the redirect carries PKCE and a state, the callback exchanges the code with a verifier
  the provider actually checks against the challenge, userinfo maps onto a pre-registered person, and the three
  refusals hold — an identity nobody put on the roster, a tampered state, a replayed callback.
  **What that does not prove is NextCloud.** Their endpoint paths, their claim names, whether they return
  `name` or `preferred_username`, whether they honour PKCE at all — every one of those is a property of their
  server, and a test written to the spec tests this app rather than theirs. The checklist in `docs/OIDC.md`
  still has to be run. Invite links are a fully working path meanwhile, and `/status` says which mode sign-in
  is in. The discovery FALLBACK is also verified live rather than only in unit tests: pointed at a provider with
  no well-known document, the app logs the failure, degrades to NextCloud's layout, and keeps working.
- **CI has never run.** The workflow is written and correct; there is no remote, so it has never executed, and
  "CI runs the suite on two Node versions" was stated as a fact in `RUNBOOK.md` when it was a plan. The
  difference was not academic: until the AB increment the first run would have been red, because three tests read
  a gitignored file. The suite is now verified against a real `git clone`, which is the closest thing to CI
  available without a remote. **Push, and confirm the first run is green, before trusting that line.**
- **Nothing has been observed with real volunteers.** Every usability judgement here is reasoned from the
  reported pain, not measured against somebody using it.
- **Whether volunteers should read Danish or English is a decision nobody has made out loud.** `locale` is `"en"`
  in `config/pattern.json`, and `strings/da.json` is complete — so one word in that file switches every
  volunteer-facing string and the `<html lang>` with it. What makes this worth asking rather than assuming is the
  tension a few lines apart in the same file: `export.csvDelimiter` is `";"` **because** the people opening the
  spreadsheet are on a Danish Windows, while the interface they read is English. Either can be right; the mismatch
  should be somebody's choice. Recorded in the config's own comment too.
- **No first-language Danish speaker has read the Danish.** `test/strings.test.mjs` checks that both locales carry
  the same keys and the same placeholders, and `test/claims.test.mjs` now checks that no string names a screen the
  app does not show — but nothing has an opinion about whether a sentence reads naturally, and no test can stand in
  for that. Terminology was checked against the app's own established words (`Planlægger` for the role, `Inaktiv`
  for the status, `vagt`/`vagtbørs` throughout, plain Danish over loanwords), and one inconsistency was found and
  fixed that way. Register and phrasing are still one person's judgement. Ask somebody at 4water to read
  `strings/da.json` end to end — 268 strings, and the fastest review in this handover.
- **The newest two screens have not been photographed, and one has not been pressed.** The invitation landing page
  was read in a real browser at 375×812 — its button measures 309×48 CSS px, the page does not scroll sideways, and
  a second GET of the link still offers it and sets no cookie, which is the whole point of it existing. What could
  not be done from here is interactive: screenshots fail with "the Browser pane is not displayed, so the page is not
  compositing frames", clicks aimed at the button's measured centre were never delivered (nothing appeared in the
  network log), and the Playwright surface shares that browser's profile so it refuses to start alongside it. So
  both screens were instead walked over real HTTP against a running demo instance with real cookies — accept
  returns 303 to `/availability`, which renders 70 date rows and 210 radios for the newcomer; deactivating a
  volunteer holding three shifts redirects to `?r=released&n=3` and the page reads "Marked inactive. 3 future
  shifts were released to the exchange for somebody else to take."; the planner then shows that person on zero
  rows and offers 90 selects. Structure and wording are verified. **Pixels are not**, and neither screen adds CSS,
  which is the reason that gap is small rather than a reason it is closed.
  One thing worth having measured on a live instance rather than only in a fixture: a brand-new volunteer's
  availability page has 70 radio groups, exactly one checked in each, and in every case it is "No answer yet" —
  so rule 4, silence is not consent, holds where it is load-bearing, and no group carries the two-checked defect
  that the same-hour grouping bug used to produce.
- **Whether the auto-roster's weekday concentration is a problem is not a technical question.** Measured on a
  full season from zero it evens out shift *counts* about as well as availability permits, and puts three of
  the four broadly-available volunteers on one weekday 78–91% of the time. Both facts are in `RUNBOOK.md` under
  "Is the auto-roster fair?", and the planning screen reports the concentration rather than acting on it —
  "I always get stuck with Sundays" and "the same teachers every Sunday" describe the same number. Ask 4water
  which one they want before changing the algorithm. Five apparent cases of the same effect turned out to be an
  artefact of my own test seeding, which is why the flag now only fires for volunteers who offered more than
  one weekday.
- **The licence is the board's choice, not the developer's.** AGPL-3.0 is a default with the reasoning written
  into `LICENSE` itself.
- **Placeholders remain in `config/pattern.json`,** and that file is the list — each is marked where it is set.
  The clock times (the Wed/Sun rhythm is from the real export; the times were never stated), `board.cutoffDays`
  (spec Q18), `calendar.eventMinutes` — no shift length was ever stated, so 90 minutes is invented — and `locale`.
  `calendar.timezone` is **not** a placeholder: it is what puts a 19:00 shift at 19:00 in a subscriber's calendar,
  and getting it wrong shifts every event silently.
  Not counted here on purpose. This said "three" in three documents while the config comment listed four, within
  one commit of a gate being added that checks the config comment's own count and not its readers'.
- **Retention runs only if the operator installed the cron line.** Deliberate — a container that deletes data on
  a schedule nobody configured is worse — but it means "deleted automatically" is true of the software and
  conditional on the deployment. `/status` shows backup age; if backups are not running, neither is retention.

## Standing rules for every increment

- **Zero dependencies.** `node:*` only. No `node_modules`, ever.
- **No Copenhagen vocabulary in code.** `test/seams.test.mjs` fails the build otherwise. New user-visible
  text means a new key in `strings/da.json` *and* `strings/en.json` — a test asserts the two files agree.
- **Eligibility is defined once.** Five named gates in `src/queries.mjs` — `GATE.open/capable/role/available/free`
  — composed into `eligiblePredicate`, which `ELIGIBLE_OPEN_IDS`, the claim guard, the planner's candidate list
  and auto-roster all build on. The gates are named individually so the two "why is this empty" explanations can
  relax them one at a time without a second copy of the rule. Never write a second version of it.
- **A string that explains WHY something is the case must be justified** in `test/claims.test.mjs`. Three shipped
  confidently wrong; a false explanation renders exactly as well as a true one, so no test catches it.
- **Silence is not consent** — absence of an availability answer means unavailable.
- **Every increment adds tests that would fail without it.** A test that passes before the change tests
  nothing.
- **Mobile is the target, not an afterthought.** Planners need it too: whoever fixes a Sunday-morning
  dropout is holding a phone.

---

## A. HTTP foundation and identity

`src/http.mjs` — a small router over `node:http`: method+path matching, form parsing with a body cap,
HTML escaping by default, static files with an extension allowlist.
`src/session.mjs` — sessions in a signed cookie (HMAC-SHA256 via `node:crypto`, `timingSafeEqual`),
`HttpOnly; SameSite=Lax; Secure` behind a proxy. No JWT, no library.
`src/auth.mjs` — one seam, three providers:
- `dev` — pick a person from a list. **Refuses to load unless `FOURWATER_AUTH=dev`, and refuses outright
  when `NODE_ENV=production`.** A dev backdoor that can ship is not a dev backdoor.
- `oidc` — NextCloud authorization-code flow with PKCE and `state`. Written to spec; see `docs/OIDC.md`
  for the checklist to run against the real server, because it cannot be verified from here.
- `invite` — single-use token redemption, the fallback for volunteers with no NextCloud identity.

Roles from `person_roles`; `requireRole()` wraps handlers.

**Done when:** cookie tamper is rejected; an expired session is rejected; CSRF token missing/wrong is
rejected on every POST; `requireRole` returns 403 not 404 for a logged-in user lacking the role; dev
provider throws under `NODE_ENV=production`; security headers present on every response.

## B. Volunteer availability entry — *the highest-value screen*

`GET /availability` — the season's dates for the logged-in volunteer, phone-first: big targets, one column,
no horizontal scroll. Day-level answer per date, optional hour-level override.
`POST /availability` — writes through `setAvailabilityDay` / `setAvailabilityHour`.

**Done when:** a round-trip persists; hour overrides day; another volunteer's dates cannot be written by
guessing an id; the page renders with JS disabled.

## C. The plan, read-only

`GET /` — my upcoming slots first, then the master plan. `GET /plan` — the whole season.

**Done when:** rendering is one query (no N+1); dates and weekdays come from `strings/`; a volunteer with
nothing assigned sees a useful empty state rather than a blank page.

## D. Vagtbørs — open slots, claim, hand back

`GET /board`, `POST /board/:id/claim`, `POST /slot/:id/hand-back`. Reuses `claimSlot` / `handBackSlot`
unchanged — this increment is HTTP and HTML only.

**Done when:** two simultaneous claims produce exactly one winner *through the HTTP layer*; an ineligible
claim is 403 with the right message; hand-back inside the cutoff still releases but surfaces the
notify-a-planner path; the board is empty-stated properly.

**This is the increment that removes the group-chat hassle.** After it, B–D are a real product.

## E. Notifications — one mechanism, two callers

`src/notify.mjs` — a single `send(event)` with a Mattermost incoming-webhook transport and an email
fallback, chosen by config. Callers: the availability nudge, and a slot appearing on the board.
Nudge runs as a scheduled job (`src/jobs.mjs`), not a cron dependency.

**Done when:** a stub transport records calls; a transport failure never fails the user's request (the slot
is still released); the webhook URL is never logged; the nudge is idempotent per person per period.

## F. Planner grid

`GET /planner` — the season grid, usable on a phone. `POST /planner/assign`, `/unassign`. Shows who is
eligible for an empty slot, so filling a gap is one tap rather than a WhatsApp thread.

**Done when:** planner-only; assigning over an existing person is explicit, not silent; the eligible-people
list uses the one shared eligibility definition.

## G. Auto-roster

Writes assignments in `proposed` state; planner discards or locks in. **Locked assignments are immune to a
re-run** — that is what makes re-running safe and is the difference between a toy and a tool. Balances on
Score, which it must read *after* board activity.

**Done when:** a re-run leaves every `confirmed` assignment untouched; proposals never count toward Score;
running it twice on the same input is stable; fairness (spread of Score) measurably improves.

## H. Admin

Invitations (create, revoke, single-use, expiring), season and activity configuration written back to
`config/pattern.json`, role assignment.

**Done when:** admin-only; a used invite cannot be reused; an expired invite is refused; editing config
cannot produce a file that `loadPattern()` rejects.

## I. Deployment

`Dockerfile` (pinned Node, non-root), `compose.yml` with `mem_limit`/`cpus` and a **named volume on local
disk** — SQLite on NFS/CIFS is a corruption risk. `tools/backup.mjs`: nightly `VACUUM INTO`, keep 14, upload
to 4water's own NextCloud. `RUNBOOK.md`: deploy, restore, add a planner, who to call.

**Done when:** the image builds; the container serves `/healthz`; a backup restores into a working database;
the runbook has been followed start to finish by reading it only.

## J. Hardening and handover

Auth rate limiting, a GDPR note (controller, lawful basis, retention — spec Q16), dependency-free audit of
what leaves the box, final read of every user-visible string in both locales.

**Done when:** the full suite is green, and `docs/` answers what Lyon's volunteers will ask.

---

## Known unknowns carried through the build — decided, not discovered

| | Placeholder in use | Confirm before |
|---|---|---|
| Clock times for the Wed/Sun pattern | `19:00` and `15:00` in `config/pattern.json` | B |
| `board.cutoffDays` (spec Q18) | `2` | D |
| "Active volunteer" = current season or longer? | current season | G |
| Whether swap (named two-party exchange) is wanted at all | not built — the open board likely absorbs it | after D lands; **still open** |
| NextCloud OIDC issuer, client id, redirect URI | dev provider | any real deployment |
| How long a shift runs | `calendar.eventMinutes: 90` — invented | before volunteers subscribe to the calendar |
| The department's time zone | `Europe/Copenhagen` — **not** invented, and load-bearing for the feed | before another department deploys |
| The address the instance answers on | `FOURWATER_BASE_URL` unset — invite and calendar links then render as paths | before an admin emails an invitation |
