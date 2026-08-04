# Execution plan — 4water scheduling

Planned as ten increments; it ran to twenty-six. **Each one ends with `npm test` green and is independently
shippable**; the app is usable by volunteers from D onward even while planners are still on the spreadsheet.
Order follows `../4water-scheduling-spec.md` §5, which front-loads the pain that was actually reported (mobile,
and chasing cover) rather than the part that is most interesting to build — auto-roster is eighth on purpose.

Status: **✅ A–AG complete, 330 tests green** — and, as of the AB increment, green on an actual `git clone`
rather than only in the working copy where they were written.

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
| **AG** | name the volunteers who have not answered | A count is not actionable, and chasing cover is half of why this exists. Capped at eight with the rest counted; escaped, because this is the first user-supplied name on that screen. Written after four load-bearing correctness properties — ICS folding, DST, the hour-over-day availability override, the claim race — were checked and all found already right |
| **AF** | lists that cannot notice their own gaps | Three hand-kept lists existed for tests to check against — notification kinds, board reasons, planner reasons — each with a comment promising that a missing entry would fail. None could: a list of what to check cannot notice something absent from itself. Now derived from the source, and a gate with no reason code refuses to load rather than telling a planner `undefined` |
| **AE** | the documents, and the strings, checked both ways | Every mechanically checkable claim in six documents (84 of them) now verified by a test; translations checked in the unread direction too, which turned up seven strings nothing was showing |
| **AD** | the shift reminder | `src/calendar.mjs` opens by saying missed shifts are the failure this app exists to prevent, and the answer so far reached only volunteers who went and subscribed to a feed. Confirmed shifts only — telling somebody to show up for a proposal is worse than silence. Keyed on the assignment id, so the existing UNIQUE constraint means one reminder per person per shift, ever |
| **AC** | the export was unreadable for the people it is for | No BOM, so every Danish name arrived as mojibake in the one artefact the board opens; and a comma delimiter puts every row in one cell on a Danish locale. The first is a fix, the second is configuration — comma is RFC 4180, and which one is right depends on who opens the file |
| **AB** | the suite only ran where it was written | Three of the four tests that boot the real server — including the acceptance gate — read a file `.gitignore` excludes, so they failed with ENOENT on any clone. Invisible because there is no remote: CI has never executed once, so nobody had ever cloned it. Found by a negative control failing on its CONTROL case, which meant my harness was wrong rather than the code |
| **AA** | the nudge job accounts for itself on `/status` | The page reported seven facts and not the one whose absence hid the worst defect here: a job with nobody to nudge and a job that is dead both produce silence. `jobs` is optional on `buildApp`, the same shape that left `notifier` out of production, so the journey test asserts the line renders on a real boot — a monitor must not carry the defect it monitors |
| **Z** | the distribution nobody could see | `workloadSpread` was computed for the tests and shown to no one, while a planner locked in 178 proposals blind. Measuring the roster from zero found it evens COUNTS as well as availability permits — and concentrates three of four broad volunteers onto one weekday. Reported, not silently "fixed": which of those is capture and which is continuity is 4water's judgement, not mine |

## A definition of done I amended rather than met — deliberately, and here is why

Increment D's criterion said *"an ineligible claim is a 403 with the right message."* It is a **303 redirect
with a flash message on the board** instead. That was originally an unflagged drift; naming it properly:

A 403 hands the volunteer an error page and loses the board they were looking at. The redirect puts
*"You cannot take this slot"* on the page they are already on, next to the slot in question. That is better for
the person, and the guard is identical either way — `claimSlot` refuses before anything is written, tested
directly. **The criterion was wrong, not the code.** Recorded here rather than left as a mismatch someone else
has to rediscover.

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
- **Three placeholders remain in `config/pattern.json`:** the clock times (the Wed/Sun rhythm is from the real
  export; the times were never stated), `board.cutoffDays` (spec Q18), and `calendar.eventMinutes` — no shift
  length was ever stated, so 90 minutes is invented. `calendar.timezone` is **not** a placeholder: it is what
  puts a 19:00 shift at 19:00 in a subscriber's calendar, and getting it wrong shifts every event silently.
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
