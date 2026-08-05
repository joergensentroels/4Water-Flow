// Attendance, and the two numbers it forced apart.
//
// Score was one number counting shifts HELD. 4water asked to count shifts ATTENDED, which is right for the record
// — somebody who takes four and turns up to one has not contributed four. But attendance is BACKWARD-looking and
// auto-roster needs a FORWARD-looking load, so one number cannot do both jobs:
//
//   a volunteer holding four future shifts has attended none of them, so an auto-roster balancing on attendance
//   sees somebody under-loaded and hands them a fifth. Every unstarted shift makes them look emptier.
//
// So the tests below pin the SPLIT rather than either number: marking attendance must not move load, and load must
// stay what auto-roster and the planner's candidate list order by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie, makeAvailableEverywhere } from "../tools/testkit.mjs";
import { score, attendedCount, markAttendance, unmarkedShifts } from "../src/queries.mjs";
import { listAudit } from "../src/audit.mjs";

// A world with a past shift somebody holds. The clock sits inside the season so there IS a past — the default is
// the season's first day, which would leave nothing to mark and every assertion here vacuous.
const withPastShift = (fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["planner"] }, today: "2026-03-01" });
  try {
    for (const p of w.people) makeAvailableEverywhere(w.db, p);
    const past = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.date < ? ORDER BY s.date DESC LIMIT 1`).get(w.today);
    assert.ok(past, "the fixture must have a session before today, or nothing here is tested");
    w.db.prepare("UPDATE assignments SET person_id=?, state='confirmed' WHERE id=?").run(w.people[1], past.id);
    await fn({ ...w, slot: past.id, holder: w.people[1], planner: await w.signIn(w.people[0]) });
  } finally { w.close(); }
};

test("marking attendance moves the record and leaves the load alone", withPastShift(async (w) => {
  const loadBefore = score(w.db, w.holder, w.seasonId);
  assert.ok(loadBefore >= 1, "the holder must hold at least the shift we just gave them");
  assert.equal(attendedCount(w.db, w.holder, w.seasonId), 0, "nothing is attended until somebody says so");

  const r = markAttendance(w.db, w.slot, 1, { today: w.today });
  assert.ok(r.ok, `marking failed: ${r.reason}`);

  assert.equal(attendedCount(w.db, w.holder, w.seasonId), 1, "the record must move");
  assert.equal(score(w.db, w.holder, w.seasonId), loadBefore,
    "LOAD MUST NOT MOVE. If attendance changed the number auto-roster balances on, an unattended future shift " +
    "would make somebody look under-loaded and earn them another one.");
}));

test("a no-show is recorded as a fact, and is not the same as nobody having said", withPastShift(async (w) => {
  assert.equal(unmarkedShifts(w.db, w.seasonId, w.today).length, 1, "the shift starts unmarked");

  assert.ok(markAttendance(w.db, w.slot, 0, { today: w.today }).ok);
  assert.equal(attendedCount(w.db, w.holder, w.seasonId), 0, "a no-show does not count as attended");
  assert.equal(unmarkedShifts(w.db, w.seasonId, w.today).length, 0,
    "and it is no longer UNMARKED — 'did not attend' and 'nobody has said' are different states, which is the " +
    "whole reason the column is nullable rather than defaulting to 0");

  // And back, because a planner who marks the wrong row must be able to undo it without a database edit.
  assert.ok(markAttendance(w.db, w.slot, null, { today: w.today }).ok);
  assert.equal(unmarkedShifts(w.db, w.seasonId, w.today).length, 1, "clearing must return it to the to-do list");
}));

test("attendance cannot be recorded for a shift that has not happened", withPastShift(async (w) => {
  const future = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.date > ? ORDER BY s.date LIMIT 1`).get(w.today);
  assert.ok(future, "the fixture must have a session after today too");
  w.db.prepare("UPDATE assignments SET person_id=?, state='confirmed' WHERE id=?").run(w.holder, future.id);

  const r = markAttendance(w.db, future.id, 1, { today: w.today });
  assert.deepEqual(r, { ok: false, reason: "not_yet" }, "recording that somebody turned up next week is not a fact");
  assert.equal(attendedCount(w.db, w.holder, w.seasonId), 0, "and nothing was written");
}));

test("an empty slot has no attendance to record", withPastShift(async (w) => {
  const empty = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                              WHERE s.date < ? AND a.person_id IS NULL LIMIT 1`).get(w.today);
  if (!empty) return;   // a fully staffed past is legitimate; nothing to assert
  assert.deepEqual(markAttendance(w.db, empty.id, 1, { today: w.today }),
    { ok: false, reason: "nobody_on_it" });
}));

test("the planner route records it, refuses a future shift, and is attributable", withPastShift(async (w) => {
  const post = (body) => w.post("/planner/attendance", w.planner,
    new URLSearchParams({ csrf: csrfFromCookie(w.planner), ...body }));
  const reason = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

  assert.equal(reason(await post({ assignmentId: String(w.slot), attended: "1" })), "attendance_saved");
  assert.equal(attendedCount(w.db, w.holder, w.seasonId), 1);

  // Who said so. This is a statement ABOUT a volunteer that feeds their record, so the actor matters.
  const row = listAudit(w.db)[0];
  assert.equal(row.action, "planner.attendance");
  assert.equal(row.actorId, w.people[0]);
  assert.match(row.detail ?? "", /attended/, `the audit detail should say what was recorded, got ${row.detail}`);

  // A value that is neither attended, not-attended nor cleared is refused rather than coerced.
  assert.equal(reason(await post({ assignmentId: String(w.slot), attended: "maybe" })), "bad_attendance");
}));

test("a volunteer cannot record their own attendance", withPastShift(async (w) => {
  const holder = await w.signIn(w.holder);
  const res = await w.post("/planner/attendance", holder,
    new URLSearchParams({ csrf: csrfFromCookie(holder), assignmentId: String(w.slot), attended: "1" }));
  assert.equal(res.status, 403, "attendance is a planner's statement, not a self-report");
  assert.equal(attendedCount(w.db, w.holder, w.seasonId), 0);
}));

// The control has to be REACHABLE, because a route with no way to get at it is a defect this project has shipped
// twice. The first version put it on the grid, where it rendered nothing: the grid filters to `date >= today`
// because planning is about the future, so a per-row control could never appear for a shift that had happened.
// It lives in a backlog card instead, which is also the shape a planner marking last month actually wants.
test("the planner page offers the control for past unmarked shifts, and only those", withPastShift(async (w) => {
  const body = await (await w.get("/planner?weeks=all", w.planner)).text();
  // Non-greedy to the first close tag and NOT length-bounded. The first version of this capped the window at 400
  // characters; a real form is ~980, because three buttons each carry a full accessible name. It matched nothing
  // and reported "no attendance control rendered at all" over a page that was rendering it correctly — a probe
  // asserting about its own blind spot, which is the failure this project has to keep checking for.
  const forms = [...body.matchAll(/<form[^>]*action="\/planner\/attendance"[\s\S]*?<\/form>/g)].map((m) => m[0]);
  assert.ok(forms.length >= 1, "no attendance control rendered at all");

  const marked = forms.filter((f) => f.includes(`value="${w.slot}"`));
  assert.equal(marked.length, 1, "exactly one control for the past shift somebody holds");
  assert.match(marked[0], /aria-pressed="/, "the current state must be announced, not implied by what is missing");

  // Every rendered control must belong to a shift that has already happened.
  const ids = forms.map((f) => Number(/name="assignmentId" value="(\d+)"/.exec(f)?.[1]));
  for (const id of ids) {
    const d = w.db.prepare(`SELECT s.date FROM assignments a JOIN sessions s ON s.id=a.session_id
                            WHERE a.id=?`).get(id)?.date;
    assert.ok(d < w.today, `a control was offered for ${d}, which is not in the past`);
  }
}));
