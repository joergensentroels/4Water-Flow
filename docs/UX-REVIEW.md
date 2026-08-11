# UX runthrough, 2026-08-06

A real browser (Playwright) against the demo database, walking **journeys** rather than visiting pages — because
the defects below live between screens, and a page-by-page review cannot see them. Volunteer screens at 390px,
planner and admin at 1280px. Signed in as **Demo Twelve** (answered nothing) and **Demo One** (admin + planner).

Nothing here is a rendering bug. The app is solid: every page renders, the 404 is styled and returns 404, CSRF
tokens are on the forms that matter, saving works and confirms. These are judgement issues, ranked by how much
they cost a real user.

---

## OUTCOME, verified 2026-08-11 — three of these seven were WRONG

Every finding was re-checked against the running app before anything was changed. **Four were real and are now
fixed. Three were false**, and all three failed the same way: *a page was read in one state and the absence of
something in that state was taken for the absence of the capability.*

| | verdict | |
|---|---|---|
| 1 | **real — fixed** | the home screen now asks, first thing, with a button to the form |
| 2 | **FALSE** | the app already distinguishes the two cases; the quoted sentence is not what an unanswered volunteer is shown |
| 3 | **FALSE** | 74 of 74 radios are checked *before* any save, and saving one date writes **one** row, not 74 |
| 4 | **real — fixed** | the form now counts what is answered and what is left |
| 5 | **real — fixed** | the button now says what it does, where it is |
| 6 | **FALSE** | proposed state and the lock-in button both render — the review looked at a board with nothing proposed |
| 7 | **real — fixed** | an error page keeps the viewer's own nav |

That is a 3-in-7 false rate in a review whose own closing section warned about exactly this failure — the
Playwright a11y snapshot that "looks alarming and is a snapshot artefact". The lesson did not transfer from the
one place it was noticed to the rest of the document.

**And the verification nearly added a fourth false verdict.** Checking #4 for a progress indicator, a regex for
*N of M* matched `3/6`, `7/6`, `10/6` — the **dates**. Printing what matched, rather than trusting the boolean,
is what caught it.

Findings below are left as originally written, with the verdict against each. A review that quietly edits away its
own errors teaches nobody anything.

---

## 1. A volunteer who has answered nothing is never asked to  — **REAL, FIXED**

Signed in as Demo Twelve — the volunteer whose whole point is that they have answered nothing — the home screen
shows *"Your upcoming slots"*, an assigned shift, `4 — Activities this season`, and the badge **"Active
volunteer"**. There is no prompt anywhere to fill in availability. The only route to it is the nav link, which
looks identical to every other nav link.

The most important call to action for the highest-need user is invisible, and the screen actively reassures them
that everything is fine.

**Also worth a decision:** that volunteer is *assigned to a shift* despite never saying they were available.
That may be intended (a planner can assign anyone) but from the volunteer's side it reads as being rostered
without being asked.

## 2. "Dates you have said you cannot help" — which they never said  — **FALSE**

> Verified against the running app with a volunteer holding zero availability rows, and with a control that the
> board really was empty (0 claimable slots, so the empty state genuinely rendered): the page says *"you have not
> told us when you can help"*. `slotEmptyReason` in `src/queries.mjs` already branches on `answered === 0`, giving
> `no_availability` rather than `not_free_then`. The distinction this asked for was there all along.

The shift exchange has a genuinely good empty state, and it is wrong for this user:

> There are openings, but only on dates you have said you cannot help. Change your availability if that is out
> of date.

Demo Twelve never said they cannot help. They said **nothing**. The model is tri-state — available /
unavailable / no answer — and this sentence collapses the third into the second, then shows it to precisely the
population most likely to be confused by it.

The fix is wording, not logic: distinguish "you marked yourself unavailable" from "you have not answered yet",
because the second one has a different and much more useful call to action.

## 3. Saving one date marks all 51 as answered (in the form, at least)  — **FALSE**

> Measured: 74 groups, **74 radios checked before any save** — the "no answer" radio carries the empty value and
> `shown()` returns the same when there is no stored row, so it is checked from the very first render. After
> saving one date: still 74 checked, and **one** row in `availability_hour`, not 74. `saveAvailability` deletes on
> the empty value and writes only on "0"/"1", so silence stores nothing at all. The half this finding explicitly
> left unchecked — whether 50 explicit rows were written, and whether the nudge job would then treat the volunteer
> as done — was the half that mattered, and it was unfounded.

The availability screen is **51 rows, 153 radios** (available / unavailable / no answer). Before saving, the
untouched rows have nothing checked. After saving a single date, **every one of the 51 rows comes back with a
radio checked** — 50 of them on "No answer yet".

So after one interaction the form can no longer distinguish "I deliberately left this blank" from "I never got
to it". Whether that also writes 50 explicit rows, and whether the nudge job then treats the volunteer as done,
was **not checked** — it needs a look at `queries.mjs` and `notify.mjs`, not the browser.

## 4. No progress indicator on a 51-row form  — **REAL, FIXED**

Searched the whole page for anything of the form *N of M*, *answered*, *remaining* — nothing. On a phone,
answering 51 dates is a long scroll with a single Save at the very bottom and no sense of how far along you are
or how much is left. `Set many dates at once` exists to help, and is a collapsed `<details>` so it is easy to
miss entirely.

## 5. The planner's most consequential button has no context at all  — **REAL, FIXED**

`Propose a plan automatically` rewrites assignments across the season (124 open slots in the demo). Its entire
surrounding text is its own label. Nothing says whether it overwrites existing assignments, how many slots it
will fill, or whether it can be undone.

## 6. Proposed vs locked is invisible on the screen that uses it  — **FALSE**

> With nothing proposed, "proposed" appears 0 times. With 98 proposals it appears **18** times, and the lock-in
> and discard buttons render beside them — the whole block is conditional on proposals existing. Three checks were
> run "because absence from innerText alone would not have proved it", and all three were run against the one
> state where the feature is deliberately hidden.

The state model is proposed/locked. On the planner:

- the words "proposed" and "locked" appear **0 times** in the page text;
- **no** class, `data-*` or `aria-*` attribute carries the state;
- **no** `title` attributes at all.

Checked three ways because absence from `innerText` alone would not have proved it. So a planner cannot tell
which assignments are provisional, and there is no visible way to promote one to locked.

## 7. Minor

- The 404 drops the whole nav bar, so a signed-in user who mistypes a URL is left with a single "Home" link.
- Handing a shift back has no confirmation step. Defensible if it is reversible, worth a second look if not.
- `/signin` correctly redirects a signed-in user to `/`, so switching users in the dev harness needs a sign-out
  first — friction in testing only, not in production.

---

## What went right, specifically

- **The availability radios are properly accessible**: real `aria-label`s carrying choice *and* date *and* time
  (`"Available — Sunday 9/8 13:00"`), `for=`-bound labels, and the decorative ✓/✕ glyphs marked
  `aria-hidden="true"`. Playwright's accessibility snapshot collapses them into anonymous nodes, which looks
  alarming and is a snapshot artefact — reading the DOM was necessary before believing it, and it would
  otherwise have been reported as a serious a11y defect that does not exist.
- **The privacy line is on the screen that collects the data**, in plain words, with a link — not buried in a
  footer.
- **Zero console errors** across seven pages at two viewports. The only one is a favicon 404.
- The empty state in #2 explains *why* it is empty and offers the fix. The wording is wrong for one case; the
  instinct is right and rarer than it should be.

## Not checked

Admin flows beyond loading the page; the audit log; keyboard-only navigation; measured colour contrast; the
calendar feed; season rollover; anything requiring a second signed-in user simultaneously.
