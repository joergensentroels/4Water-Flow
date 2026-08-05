// Somebody stops volunteering. There are three doors: an admin marks them inactive, or erases them by
// anonymising, or erases them entirely. All three must free the shifts they had not yet done.
//
// Because every consumer of the roster skips an inactive person — eligibility, the claim guard, auto-roster, and
// both notification jobs all filter on status='active' — a shift left on one of them is covered by nobody and
// reads as covered by somebody. Measured before the fix, on a season where they held 51: after deactivation they
// still held all 51, no slot opened, the reminder job found 0 of theirs due (checked against the same query with
// them active, which found one), and the planner grid printed their name beside every one. A gap that reads as
// filled is worse than a gap, because nobody chases it.
//
// ⚠ THE SENTENCE ABOVE WAS FALSE ABOUT TWO OF THOSE FIVE CONSUMERS for most of this file's life, and it is left
// standing because it is true NOW. Eligibility and the claim guard did not filter on status: `GATE` held `open`,
// `capable`, `role`, `available` and `free` and nothing about the roster, so `eligiblePredicate` — the single rule
// the board listing and `claimSlot` share — never looked at it. It appeared covered because the planner's side is:
// `eligiblePeopleFor`, `slotEmptyReason`, `rosterReview` and `workloadSpread` each filter status in their own WHERE
// clause, so a planner could not assign an inactive person and no review screen listed one.
//
// Measured: stand somebody down, then sign in as them. The shift exchange offered 172 open slots and the claim
// SUCCEEDED. The deactivation released their future shifts and then let them take new ones straight back — and the
// only path that allowed it was the one path the volunteer drives themselves. Fixed by adding `GATE.onRoster`, which
// every caller composes rather than repeats, and the last test in this file is the regression.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie, makeAvailableEverywhere } from "../tools/testkit.mjs";
import { autoRoster } from "../src/roster.mjs";
import { boardEmptyReason, assignSlot } from "../src/queries.mjs";

// A world where one volunteer really is holding future shifts, so there is something to release. Without this the
// assertions below all pass over an empty set — the shape of check that cannot fail.
//
// `today` defaults to the season's first day, which is what makeWorld does. That leaves NO sessions in the past,
// and the test below about keeping history quietly asserted nothing until it was checked: 0 sessions before today,
// 102 from today. So that test passes a mid-season clock instead. testkit's own comment warns about the mirror
// image of this — a real clock making every upcoming list empty and every such test vacuously green.
const withLeaver = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"] }, ...opts });
  try {
    for (const p of w.people) {
      makeAvailableEverywhere(w.db, p);
      w.db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) SELECT ?, id FROM activities").run(p);
    }
    autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
    w.db.prepare("UPDATE assignments SET state='confirmed' WHERE person_id IS NOT NULL").run();

    const leaver = w.people[2];
    const future = (pid) => w.db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN sessions s ON s.id=a.session_id
                                          WHERE a.person_id = ? AND s.date >= ?`).get(pid, w.today).n;
    assert.ok(future(leaver) > 0, "the fixture must leave them holding future shifts, or nothing here is tested");
    await fn({ ...w, leaver, future, admin: await w.signIn(w.people[0]) });
  } finally { w.close(); }
};

// The invariant, stated once. After any of the three doors, nobody the app treats as gone may still be holding a
// shift in the future — and that is checked over the WHOLE table rather than the one person, so a door added later
// that forgets is caught by the same assertion.
const noGoneHolders = (w) => {
  const rows = w.db.prepare(`SELECT p.name, COUNT(*) AS n
                               FROM assignments a
                               JOIN sessions s ON s.id = a.session_id
                               JOIN people   p ON p.id = a.person_id
                              WHERE p.status <> 'active' AND s.date >= ?
                              GROUP BY p.id`).all(w.today);
  assert.deepEqual(rows, [], `somebody the app treats as gone still holds future shifts: ${JSON.stringify(rows)}`);
};

test("marking a volunteer inactive releases their future shifts and says how many", withLeaver({}, async (w) => {
  const held = w.future(w.leaver);
  const openBefore = w.db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN sessions s ON s.id=a.session_id
                                   WHERE a.person_id IS NULL AND s.date >= ?`).get(w.today).n;

  const res = await w.post("/admin/status", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), personId: String(w.leaver), status: "inactive" }));
  const url = new URL(res.headers.get("location"), "http://x");
  assert.equal(url.searchParams.get("r"), "released", "a bare 'saved' over fifty released shifts is the silence this closes");
  assert.equal(url.searchParams.get("n"), String(held), "and it must say how many, because the planner has to fill them");

  assert.equal(w.future(w.leaver), 0);
  assert.equal(w.db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN sessions s ON s.id=a.session_id
                             WHERE a.person_id IS NULL AND s.date >= ?`).get(w.today).n, openBefore + held,
    "every released shift must become an open slot, not vanish");
  noGoneHolders(w);
}));

// The clock sits inside the season here — the shipped season runs 2026-01-01 to 2026-06-30 — so there really are
// sessions on both sides of today. No early return: if the fixture stops providing a past shift, this fails.
test("their past shifts stay, because they did run those", withLeaver({ today: "2026-03-01" }, async (w) => {
  const past = w.db.prepare("SELECT id FROM sessions WHERE date < ? ORDER BY date DESC LIMIT 1").get(w.today);
  assert.ok(past, "the clock must sit inside the season, or there is no history to keep and this asserts nothing");
  w.db.prepare("UPDATE assignments SET person_id=? WHERE session_id=? AND person_id IS NULL").run(w.leaver, past.id);
  const before = w.db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE a.person_id=? AND s.date < ?`).get(w.leaver, w.today).n;
  assert.ok(before > 0, "the fixture must give them a past shift, or this asserts nothing");

  await w.post("/admin/status", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), personId: String(w.leaver), status: "inactive" }));
  assert.equal(w.db.prepare(`SELECT COUNT(*) AS n FROM assignments a JOIN sessions s ON s.id=a.session_id
                             WHERE a.person_id=? AND s.date < ?`).get(w.leaver, w.today).n, before,
    "deactivation must not rewrite history");
}));

test("both erasure modes release future shifts, and report the count", withLeaver({}, async (w) => {
  const held = w.future(w.leaver);
  const res = await w.post("/admin/erase", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), personId: String(w.leaver), mode: "anonymise" }));
  const url = new URL(res.headers.get("location"), "http://x");
  assert.equal(url.searchParams.get("r"), "erased");
  assert.equal(url.searchParams.get("n"), String(held), "anonymising must report the shifts it freed");
  assert.equal(w.future(w.leaver), 0, "anonymise keeps history, and a shift next month is not history");
  noGoneHolders(w);
}));

test("erasing entirely leaves nothing holding a future shift either", withLeaver({}, async (w) => {
  await w.post("/admin/erase", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), personId: String(w.leaver), mode: "remove" }));
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM people WHERE id=?").get(w.leaver).n, 0);
  assert.equal(w.future(w.leaver), 0);
  // No assignment may point at a person who no longer exists, which is the other way this could go wrong.
  assert.equal(w.db.prepare(`SELECT COUNT(*) AS n FROM assignments a WHERE a.person_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id = a.person_id)`).get().n, 0);
  noGoneHolders(w);
}));

test("reactivating does not take the shifts back — they belong to whoever claimed them", withLeaver({}, async (w) => {
  const held = w.future(w.leaver);
  await w.post("/admin/status", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), personId: String(w.leaver), status: "inactive" }));
  const res = await w.post("/admin/status", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), personId: String(w.leaver), status: "active" }));
  assert.equal(new URL(res.headers.get("location"), "http://x").searchParams.get("r"), "saved",
    "coming back is not a release, so it must not claim to have freed anything");
  assert.equal(w.future(w.leaver), 0, `the ${held} shifts went to the exchange and stay there`);
}));

// THE REGRESSION for the gap named at the top of this file: a stood-down volunteer could take work straight back.
//
// The stand-down releases their future shifts, and their availability answers survive it — only assignments are
// released. So with no roster gate in the shared predicate, every one of those freed slots was immediately offered
// back to the person it had just been taken from, and claiming worked. Measured at 172 slots offered before the fix.
//
// Both directions are asserted, because "the board is empty" is also what a broken board looks like: an ACTIVE
// volunteer in the same fixture must still be offered slots and must still be able to claim one. Without that half,
// deleting the whole eligibility predicate would pass this test.
test("a stood-down volunteer is offered nothing and can claim nothing, while an active one still can",
  withLeaver({}, async (w) => {
    const stand = (id, status) => w.post("/admin/status", w.admin,
      new URLSearchParams({ csrf: csrfFromCookie(w.admin), personId: String(id), status }));

    await stand(w.leaver, "inactive");
    const gone = await w.signIn(w.leaver);
    const theirBoard = await (await w.get("/board", gone)).text();
    const offered = (theirBoard.match(/\/claim"/g) ?? []).length;
    assert.equal(offered, 0, `an inactive volunteer was offered ${offered} slots to take back`);

    // And told why, rather than shown a bare empty page — the reason comes from the same gate that emptied it.
    assert.equal(boardEmptyReason(w.db, w.leaver, w.seasonId, w.today).reason, "not_on_roster");

    // The claim guard, not just the listing. A volunteer who kept an old slot id must still be refused, because the
    // listing and the guard are two different consumers of the predicate and only one of them renders.
    const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get()?.id;
    assert.ok(slot, "the fixture must leave an open slot, or the claim below tests nothing");
    const refused = await w.post(`/board/${slot}/claim`, gone,
      new URLSearchParams({ csrf: csrfFromCookie(gone) }));
    assert.equal(new URL(refused.headers.get("location"), "http://x").searchParams.get("r"), "not_eligible");
    assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(slot).person_id, null,
      "the slot must still be open — an inactive volunteer took it");

    // A planner cannot do it on their behalf either, and is told which fact stopped them.
    assert.deepEqual(assignSlot(w.db, slot, w.leaver), { ok: false, reason: "not_on_roster" });

    // THE CONTROL, isolating exactly one variable: put the SAME person back on the roster and the SAME slot becomes
    // claimable. Their capabilities, their availability, the slot and the clock are all untouched, so a pass here
    // cannot be explained by anything except the status.
    //
    // The first version used a different, still-active volunteer and FAILED — the fixture auto-rosters the whole
    // season, so every other volunteer is already booked at that hour and the `free` gate excludes them from the
    // slots this one just released. That control was measuring the fixture rather than the rule, and it said so by
    // failing rather than by passing, which is the only reason it was noticed.
    await stand(w.leaver, "active");
    const back = await w.signIn(w.leaver);
    const backBoard = await (await w.get("/board", back)).text();
    assert.ok((backBoard.match(/\/claim"/g) ?? []).length > 0,
      "back on the roster, the same volunteer must be offered slots again — or the emptiness above proves nothing");
    const took = await w.post(`/board/${slot}/claim`, back, new URLSearchParams({ csrf: csrfFromCookie(back) }));
    assert.equal(new URL(took.headers.get("location"), "http://x").searchParams.get("r"), "claimed",
      "the same claim on the same slot must now succeed, or the refusal above was the guard refusing everyone");
    assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(slot).person_id, w.leaver);
  }));
