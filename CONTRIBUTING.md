# Working on this

`npm test` runs everything. No network, no database, no services, no `npm install`. If any of that changes,
that is the news — not a detail.

```bash
npm test
```

It parses every module first (`npm run precheck`, about half a second) and refuses to start the suite if one cannot
be parsed. That is not tidiness. A single unterminated template literal — a backtick inside a comment inside a
template literal, which `src/db.mjs` warns about over the schema — left a quarter of the test files **unrun** and the
process not terminating. The suite did not go red, it went unreliable, and working out why cost most of a session.
`node --check` naming the file takes a moment.

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

## If you add a route, five audits will have an opinion

They all walk `app.routes()` or `src/server.mjs` rather than a list somebody maintains, so a new route is covered
the moment it is registered — which also means you cannot add one and discover later that nothing checked it.

| | what it insists on |
|---|---|
| `test/csrf-audit.test.mjs` | a POST refuses a missing, empty and wrong CSRF token, **and** accepts a good one — the last part is what stops a route that refuses everything from passing. The exception list is derived: exactly the POSTs with no session to carry a token, no more and no fewer |
| `test/authz-audit.test.mjs` | the route's `gate()`/`postGate()` rule is one this app has, an ungated route is on a short list with a reason each, `/admin/*` gates on `admin` and `/planner/*` on `planner`, and the running server agrees |
| `test/ownership-audit.test.mjs` | a route with an `:id` either has a probe that tries to act on **another volunteer's** row through it, or a stated reason why its id names nothing one person owns |
| `test/getwrites.test.mjs` | a GET does not write. One exception, `/auth/callback`, because the protocol makes the sign-in return a GET |
| `test/names.test.mjs` | every control the route renders has a name of its own (see below) |

**Why the ownership one exists, since the role audit looks like it should cover it.** It cannot, structurally. Every
route it examines is one a plain volunteer is *entitled* to call, so the role gate says yes and is right to; what
stops them reaching somebody else's shift is a guard inside the handler. The role audit fills `:id` with `1` and
asserts the allowed role does not get a 403 — a volunteer successfully deleting the administrator's note satisfies
it exactly as well as correct behaviour does. Nothing was wrong when this was written; it exists for **shift swaps**,
where one volunteer reaching for another's shift is the entire feature.

Each probe ends by having the *owner* perform the same action successfully. Without that, a route broken so badly
that it refuses everybody would pass the whole file.

**Why the GET one exists, in one paragraph, because it is the least obvious.** The CSRF audit proves every POST is
guarded, which says nothing about GETs — and a GET that writes is the way *round* a CSRF guard rather than through
it, since nothing issues a token for an `<img src>`, a prefetcher, or a mail gateway scanning a link. `GET
/invite/:token` used to redeem the invitation: one fetch by a scanner created the person, spent the invitation and
handed the session cookie to the scanner, and the volunteer's own click got *"We could not find you"*. Accepting
is a POST now. If you need a GET to write, you are probably about to build the same defect.

The authz audit's fourth check exists because of a hole in the first three: weakening `gate(x, "admin")` to
`gate(x)` changes what the source declares *and* what the server does, together, so every consistency check stays
green. Only an expectation taken from somewhere other than the handler notices — here, the path. Two routes
needing a role from outside those prefixes (`/outbox`, `/status`) are named explicitly, and a stale entry fails
rather than lingering as apparent coverage.

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

## Escaping — where the surface is, and the one shape to avoid

`h()` escapes `&`, `<`, `>`, `"` and `'`. That is the correct set for element text and for a **quoted** attribute
value, which is every interpolation in this codebase. Audited rather than assumed, and the result is recorded here
so nobody has to redo it:

- **All four `raw()` call sites are static literals** — three `aria-current` attributes and the SVG droplet.
  `test/seams.test.mjs` now enforces that the argument is a literal with nothing interpolated, because
  `raw(person.name)` renders exactly as well as the safe version until the first volunteer with a bracket in
  their name.
- **No `href`, `src`, `action` or `formaction` carries user data.** The five interpolated ones take either a
  static path from `navFor`'s literal list or a constant passed within the same file, so no value can supply a
  `javascript:` scheme — which `h()` would not catch, since it does not touch the colon.
- **Non-HTML responses are safe by Content-Type, not by escaping.** `send()` does not escape a plain string, and
  `/healthz`, the ICS feed, the JSON exports and the season CSV each pass one — with their own Content-Type and
  `X-Content-Type-Options: nosniff`, so none can be sniffed as HTML. Every HTML response goes through `` html`` ``.

**The shape to avoid, which has no automated check: an unquoted attribute.** `<div class=${cls}>` lets a value
add attributes of its own, because `h()` escapes quotes and not spaces — `x onmouseover=…` would become a second
attribute. There are none today. A scan for it was written and deliberately NOT committed: both of its two hits
were false positives (a `console.error` string and a cookie header, neither of them HTML), and distinguishing
markup from ordinary strings needs template-boundary tracking. A check that mostly cries wolf gets rubber-stamped,
which is the same reasoning that keeps the translation gate narrow. Quote your attributes and this stays moot.

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

## Accessible names — a control has to say which one it is

The contrast check above measures colour and hit area. It says nothing about whether a control's *name*
distinguishes it from the one below, and this app renders hundreds of near-identical controls: one per slot, one
per date, twelve per person. `test/names.test.mjs` is the check for that, over every page an authenticated person
can reach. It fails when two controls on a page share an accessible name while doing different things, and when a
control resolves no name at all. Buttons, selects, radios **and links** — a links list is how a screen reader user
navigates a long page, and it strips the card or row that explained the link, so a link is in exactly the position
a button is. Leaving links out is what let four "Download data" links to four volunteers' personal records
survive an audit of the very screen they sit on.

**Four things worth knowing before you change it or a page it covers:**

1. **`aria-label` is not the only name, and adding one is not always the fix.** A wrapping `<label>`, or a
   `<label for>` pointing at the control's id, names it just as well — the audit resolves all three because an
   earlier version knew only `aria-label` and reported a properly labelled `<select>` as nameless. Acting on that
   report would have added an `aria-label` duplicating the visible text, which is worse than nothing: it
   overrides that text, so the two can drift until voice control no longer matches what is on screen.
2. **The visible row is not the name.** Every instance found here looked fine on screen, because the date and
   activity sat beside the button. A screen reader arriving at the button does not get the row.
3. **A check is only looking where the fixture gives it two of the thing.** This is the one to remember. The
   audit was green over four screens' worth of real defects at various points purely because its world had one
   pending invite, or nothing assigned, or everything assigned — a single control cannot collide with anything,
   so removing the fix left the check green. It has a second test asserting the *fixture's* shape for that
   reason. If you add a page to the audit, add an assertion that the page renders more than one of whatever
   repeats on it, or you have added a check that cannot fail.
4. **Both faults are reported from one pass, and that is deliberate.** They used to be two assertions, ambiguity
   first — which shadowed the other permanently, because a control with no name also shares the empty name with
   every other nameless control, so wherever there were two the first assertion threw and the second never ran.
   Do not split them back apart to make the failure messages tidier.

Probed by removing each fix in turn and confirming the audit names it — 8/8. Two of those mutations had to be
rewritten: one left the control a name and so proved nothing, and one was reported by the wrong half of the
check, which is how the shadowing in point 4 came to light.

## Before opening a pull request

- `npm test` green.
- If you touched a screen, **measure it in a browser** at 375px in both colour schemes — see the next section.
  **Eleven** real bugs here were invisible to a passing suite: a 403 dead end, unstyled 404s, light-mode form
  controls on a dark page, an administrator who could not reach the planner screen, two adjacent links to the same
  session, the current-page nav tab scrolled off a 375px viewport, 117 session links that asked for a 40px chip and
  rendered as 26px text, a note box 157px wide beside a 309px button, three attendance buttons stacked into a
  186px-tall row 47 rows deep, and nineteen targets on `/admin` at 22–23px against a 24px floor.
  `test/css-audit.test.mjs` catches the ones decidable from the source. It cannot catch geometry: nothing in
  `node:test` lays out a box, so **the browser is the only instrument for it.**
- If you added a `POST` route, `test/csrf-audit.test.mjs` will check it automatically. If you added an outcome
  code, add its message to both locales — a test checks that too.
- If the route takes an `:id`, `test/ownership-audit.test.mjs` will fail until you say whether that id names one
  volunteer's row. Writing the probe is the work: have the other volunteer try it, and finish by having the owner
  succeed.
- If you changed something a runbook step depends on, update `RUNBOOK.md`. It is the succession plan, and it is
  wrong the moment it stops matching.
- **If you landed a feature, re-read README's "What is NOT here" section.** `test/docs.test.mjs` verifies that
  everything these documents *name* exists — a path, a route, an environment variable, a config key, a function.
  It cannot notice a sentence asserting something **does not** exist, because there is nothing to look up. That
  section once listed auto-roster, notifications, OIDC, invite redemption and the planner grid as missing, long
  after all five shipped, and claimed nothing consumed `invitations` — in the file a reader opens first. No check
  will catch the next one; reading it will.

## The phone measurement, which is a procedure and not a glance

Six of the eleven browser-only defects above were found in two sweeps with the snippet below, and none of them was
visible to reading the page. Numbers, not impressions: "it seems fine" is how they all survived review.

Start a demo instance, open it at 375px, sign in, and run this in the console on **every** page — `/`,
`/availability`, `/board`, `/plan`, `/session/:id`, `/me`, `/planner`, `/outbox`, `/status`, `/admin`, `/privacy`,
and a URL that 404s:

```js
(() => {
  const vw = document.documentElement.clientWidth;
  // The EFFECTIVE target is what a finger hits. A control wrapped in a label, or paired with one by for=, is
  // activated by that label, so the label's box is the target — measuring the 13x13 checkbox over-reports.
  const byId = new Map([...document.querySelectorAll('label[for]')].map(l => [l.getAttribute('for'), l]));
  const seen = new Set(), targets = [];
  for (const c of document.querySelectorAll('a, button, input:not([type=hidden]), select, textarea')) {
    const hit = c.closest('label') ?? (c.id ? byId.get(c.id) : null) ?? c;
    if (seen.has(hit)) continue;
    seen.add(hit);
    const r = hit.getBoundingClientRect(), cs = getComputedStyle(hit);
    if (cs.opacity === '0' || cs.visibility === 'hidden' || (r.width <= 1 && r.height <= 1)) continue;
    targets.push({ text: (hit.textContent || '').trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const active = document.querySelector('nav.tabs a[aria-current]');
  return {
    sideways: document.documentElement.scrollWidth > vw + 1,
    pastViewport: [...document.querySelectorAll('body *')]
      .filter((e) => { const r = e.getBoundingClientRect(); return (r.width || r.height) && r.right > vw + 1; }).length,
    targets: targets.length,
    belowWcag24: targets.filter((t) => t.w < 24 || t.h < 24),
    activeTabVisible: active ? active.getBoundingClientRect().right <= vw + 1 : null,
  };
})()
```

`sideways: false`, `pastViewport: 0`, `belowWcag24: []` and `activeTabVisible: true` on every page. `targets` must be
non-zero — a page reporting nothing wrong having examined nothing is the failure mode this repository keeps
rediscovering, so read that number before believing the rest.

**Negative-control it once per session**, because a probe that finds nothing looks identical to a probe that looks at
nothing. Append a `10px` link and a `900px` div to `document.body`, confirm `belowWcag24`, `pastViewport` and
`sideways` all light up, then remove them and confirm they go quiet.

Two things that will waste your time otherwise. The stylesheet is cached for an hour, so **restart the server** after
editing CSS — the `?v=` hash is computed once per process, and a forced reload will not fetch a new file on its own.
And `boot.test.mjs` spawns on port 8123, so run the demo on a different one.
