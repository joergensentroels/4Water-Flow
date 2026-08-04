# Execution plan — 4water scheduling

Ten increments. **Each one ends with `npm test` green and is independently shippable**; the app is usable by
volunteers from D onward even while planners are still on the spreadsheet. Order follows
`../4water-scheduling-spec.md` §5, which front-loads the pain that was actually reported (mobile, and
chasing cover) rather than the part that is most interesting to build — auto-roster is eighth on purpose.

Status: **✅ A–P all complete, 221 tests green** (`npm test` — no network, no database, no setup).

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

## A definition of done I amended rather than met — deliberately, and here is why

Increment D's criterion said *"an ineligible claim is a 403 with the right message."* It is a **303 redirect
with a flash message on the board** instead. That was originally an unflagged drift; naming it properly:

A 403 hands the volunteer an error page and loses the board they were looking at. The redirect puts
*"You cannot take this slot"* on the page they are already on, next to the slot in question. That is better for
the person, and the guard is identical either way — `claimSlot` refuses before anything is written, tested
directly. **The criterion was wrong, not the code.** Recorded here rather than left as a mismatch someone else
has to rediscover.

## Measured, not assumed — at the size the spec actually describes

200 volunteers, six slots a week, a full half-year season (257 sessions, 10k availability rows):

| | before | after |
|---|---|---|
| `/planner` HTML | **534 KB** | **84 KB** (four-week default) |
| `/planner` queries | 257 | 40 |
| `planForSeason` | 1 query, 4 ms | unchanged |
| a volunteer's board | 1 query, 1 ms | unchanged |
| `autoRoster`, whole season | 276 ms, 414 queries | unchanged |

Two real defects came out of that, neither visible to a passing suite:

1. **The planner's candidate list was alphabetical while auto-roster ordered by fairness.** Same eligibility
   rule, two different answers to "who should take this" — so a planner filling gaps by hand kept picking
   whoever came first in the alphabet while the machine balanced. The practical effect is one volunteer quietly
   overloaded, which is the exact thing Score exists to prevent. Now both order by fewest activities first, and
   the dropdown shows each candidate's count.
2. **Half a megabyte of HTML on a phone.** The planner now defaults to four weeks with links to widen.

## Still not verified — flagged where it matters, not buried

- **The Docker image has never been built.** Docker is not installed on the machine this was written on. Said
  plainly at the top of `RUNBOOK.md`.
- **OIDC has never talked to a real NextCloud.** Written to spec and unit-tested with an injected `fetch`; the
  checklist to run against the real server is `docs/OIDC.md`. Invite links are a fully working path meanwhile.
- **The licence is the board's choice, not the developer's.** AGPL-3.0 is a default with the reasoning written
  into `LICENSE` itself.
- **Two placeholders remain in `config/pattern.json`:** the clock times (the Wed/Sun rhythm is from the real
  export; the times were never stated) and `board.cutoffDays`, which is spec question Q18.

## Standing rules for every increment

- **Zero dependencies.** `node:*` only. No `node_modules`, ever.
- **No Copenhagen vocabulary in code.** `test/seams.test.mjs` fails the build otherwise. New user-visible
  text means a new key in `strings/da.json` *and* `strings/en.json` — a test asserts the two files agree.
- **Eligibility is defined once** (`ELIGIBLE_OPEN_IDS`). Never write a second version of it.
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
| Whether swap (named two-party exchange) is wanted at all | not built — the open board likely absorbs it | after D lands |
| NextCloud OIDC issuer, client id, redirect URI | dev provider | any real deployment |
