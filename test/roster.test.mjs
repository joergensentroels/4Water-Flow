// Increment G. The properties that make auto-roster usable rather than a toy: a re-run must not touch work
// the planner has locked, two runs on the same input must agree, and the balancing must actually balance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, makeAvailableEverywhere } from "../tools/testkit.mjs";
import { autoRoster, lockInProposals, discardProposals, countProposals, workloadSpread } from "../src/roster.mjs";
import { score, assignSlot, openSlotsFor, eligiblePeopleFor, setAvailabilityDay } from "../src/queries.mjs";

const withPlanner = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 4, roles: { 0: ["planner"] }, ...opts });
  try { await fn(w); } finally { w.close(); }
};
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");
const allAvailable = (w) => { for (const p of w.people) makeAvailableEverywhere(w.db, p, w.today); };
const proposals = (w) => w.db.prepare("SELECT id, person_id FROM assignments WHERE state='proposed' AND person_id IS NOT NULL ORDER BY id").all();

// ---- the core safety property -------------------------------------------------------------------------
test("a re-run leaves every CONFIRMED assignment untouched", withPlanner({}, async (w) => {
  allAvailable(w);
  const first = autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  assert.ok(first.filled > 0);

  lockInProposals(w.db, w.seasonId, w.today);
  const locked = w.db.prepare("SELECT id, person_id FROM assignments WHERE state='confirmed' AND person_id IS NOT NULL ORDER BY id").all();
  assert.ok(locked.length > 0);

  const second = autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  const after = w.db.prepare("SELECT id, person_id FROM assignments WHERE state='confirmed' AND person_id IS NOT NULL ORDER BY id").all();
  assert.deepEqual(after, locked, "locked work must survive a re-run — that is what makes re-running safe");
  assert.equal(second.filled, 0, "there was nothing left to fill");
}));

test("proposals never count toward Score; locking them in does", withPlanner({}, async (w) => {
  allAvailable(w);
  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  const p = proposals(w);
  assert.ok(p.length > 0);
  for (const person of w.people) {
    assert.equal(score(w.db, person, w.seasonId), 0, "an unlocked proposal is not something the volunteer has done");
  }
  lockInProposals(w.db, w.seasonId, w.today);
  const total = w.people.reduce((s, id) => s + score(w.db, id, w.seasonId), 0);
  assert.equal(total, p.length, "locking in turns every proposal into real work");
}));

test("two runs on the same input produce the same plan", withPlanner({}, async (w) => {
  allAvailable(w);
  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  const a = proposals(w);
  const second = autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  const b = proposals(w);
  assert.equal(second.cleared, a.length, "the previous proposals are cleared first — they were provisional");
  assert.deepEqual(b, a, "a roster that reshuffles between identical runs cannot be reviewed");
}));

test("discarding proposals returns the slots to open, changing nothing else", withPlanner({}, async (w) => {
  allAvailable(w);
  const before = w.db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NULL").get().n;
  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  assert.ok(countProposals(w.db, w.seasonId, w.today) > 0);

  const n = discardProposals(w.db, w.seasonId, w.today);
  assert.equal(countProposals(w.db, w.seasonId, w.today), 0);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NULL").get().n, before,
    "every discarded slot is open again");
  assert.ok(n > 0);
}));

// ---- fairness -----------------------------------------------------------------------------------------
test("balancing measurably evens out the workload", withPlanner({}, async (w) => {
  allAvailable(w);
  // Start lopsided: person 1 already has a pile of confirmed work. Restricted to the activity they are
  // actually capable of — the first version of this test grabbed any six open slots, three of which were
  // rightly refused (wrong activity, or an overlapping timeslot), so the "lopsided" start never happened.
  //
  // ONE SLOT PER TIMESLOT, and only roles this person can teach. A partner-dance class now has two slots at
  // the same date and time, so "the first six by date" asked one person to be both halves of the same class —
  // which assignSlot rightly refuses. The setup was wrong, not the rule.
  const prefers = w.db.prepare("SELECT preferred_role FROM people WHERE id=?").get(w.people[1]).preferred_role;
  const open = w.db.prepare(`SELECT MIN(a.id) AS id FROM assignments a
                             JOIN sessions   s ON s.id = a.session_id
                             JOIN timeslots  t ON t.id = s.timeslot_id
                             JOIN activities act ON act.id = s.activity_id
                             WHERE a.person_id IS NULL AND s.date >= ? AND act.key = ?
                               AND (a.role IS NULL OR ? = 'b' OR a.role = ?)
                             GROUP BY s.date, t.hour, t.minute
                             ORDER BY s.date LIMIT 6`)
    .all(w.today, w.pattern.activities[0].key, prefers, prefers);
  assert.equal(open.length, 6, "the fixture needs six distinct timeslots to make a lopsided start");
  for (const { id } of open) {
    const r = assignSlot(w.db, id, w.people[1], { expectPersonId: null });
    assert.equal(r.ok, true, `setup assignment refused: ${r.reason}`);
  }
  const before = workloadSpread(w.db, w.seasonId);
  assert.ok(before.spread >= 6, `expected a lopsided start, got spread ${before.spread}`);

  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  const after = workloadSpread(w.db, w.seasonId);
  assert.ok(after.spread < before.spread, `spread should shrink: ${before.spread} -> ${after.spread}`);

  // And the person who was already loaded should not have been given the next slots.
  const gotMore = proposals(w).filter((p) => p.person_id === w.people[1]).length;
  const gotOthers = proposals(w).filter((p) => p.person_id !== w.people[1]).length;
  assert.ok(gotOthers > gotMore, "the busiest volunteer should be picked last, not first");
}));

test("the board's redistribution is reflected: Score is read at the start of the run", withPlanner({}, async (w) => {
  allAvailable(w);
  // Give person 1 real work, then hand it back — Score returns to zero, so they should be a top candidate.
  const [first] = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                                WHERE a.person_id IS NULL AND s.date >= ? ORDER BY s.date LIMIT 1`).all(w.today);
  assignSlot(w.db, first.id, w.people[1], { expectPersonId: null });
  assert.equal(score(w.db, w.people[1], w.seasonId), 1);
  w.db.prepare("UPDATE assignments SET person_id=NULL WHERE id=?").run(first.id);
  assert.equal(score(w.db, w.people[1], w.seasonId), 0, "handing back really does move Score");

  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  const got = proposals(w).filter((p) => p.person_id === w.people[1]).length;
  assert.ok(got > 0, "after releasing their slot they should be balanced back up, not still penalised");
}));

// ---- what it refuses to do ----------------------------------------------------------------------------
test("it proposes nobody for a slot nobody is eligible for, and reports the gap", withPlanner({}, async (w) => {
  // Nobody has entered availability, so nothing is fillable.
  const r = autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  assert.equal(r.filled, 0);
  assert.ok(r.gaps > 0, "unfillable slots must be reported, not silently skipped");
  assert.equal(countProposals(w.db, w.seasonId, w.today), 0);
}));

test("it never proposes someone who said they cannot", withPlanner({}, async (w) => {
  const dates = w.db.prepare("SELECT DISTINCT date FROM sessions WHERE date >= ? ORDER BY date").all(w.today);
  for (const { date } of dates) {
    setAvailabilityDay(w.db, w.people[1], date, true);
    setAvailabilityDay(w.db, w.people[2], date, false);
  }
  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  assert.equal(proposals(w).filter((p) => p.person_id === w.people[2]).length, 0,
    "an explicit 'cannot' must be honoured by the machine too, not just by planners");
  assert.ok(proposals(w).filter((p) => p.person_id === w.people[1]).length > 0);
}));

test("nobody is double-booked into two activities in the same timeslot", withPlanner({}, async (w) => {
  allAvailable(w);
  // Only one person is capable, and config puts more than one activity in a slot — so the second must go
  // unfilled rather than to the same person twice.
  w.db.prepare("DELETE FROM capabilities WHERE person_id <> ?").run(w.people[1]);
  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });

  const clashes = w.db.prepare(`
    SELECT a.person_id, s.date, t.hour, COUNT(*) AS n
      FROM assignments a JOIN sessions s ON s.id=a.session_id JOIN timeslots t ON t.id=s.timeslot_id
     WHERE a.person_id IS NOT NULL
     GROUP BY a.person_id, s.date, t.hour, t.minute HAVING n > 1`).all();
  assert.deepEqual(clashes, [], `somebody was booked twice at once: ${JSON.stringify(clashes)}`);
}));

test("the double-booking rule also stops a volunteer claiming two overlapping slots from the board", withPlanner({}, async (w) => {
  allAvailable(w);
  const me = w.people[1];
  // The overlap can only bite someone capable of BOTH activities in a shared timeslot — with one capability
  // the capability check already excludes the other slot. So grant every capability first; without this the
  // test proves nothing and passes for the wrong reason.
  for (const a of w.pattern.activities) {
    w.db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) VALUES (?, (SELECT id FROM activities WHERE key=?))").run(me, a.key);
  }

  const slots = openSlotsFor(w.db, me, w.seasonId, w.today);
  const byTime = new Map();
  for (const s of slots) {
    const k = `${s.date}T${s.hour}:${s.minute}`;
    byTime.set(k, [...(byTime.get(k) ?? []), s]);
  }
  const sameTime = [...byTime.values()].find((v) => v.length >= 2);
  assert.ok(sameTime, "this test needs two activities sharing one timeslot in config");

  w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(me, sameTime[0].assignmentId);
  const stillOffered = openSlotsFor(w.db, me, w.seasonId, w.today).some((s) => s.assignmentId === sameTime[1].assignmentId);
  assert.equal(stillOffered, false, "the overlapping slot must disappear from their board");
  assert.deepEqual(eligiblePeopleFor(w.db, sameTime[1].assignmentId).map((p) => p.id).filter((id) => id === me), [],
    "and they must not be offered to a planner for it either");
}));

// ---- through HTTP -------------------------------------------------------------------------------------
test("the planner can propose, review, and lock in from the grid", withPlanner({}, async (w) => {
  allAvailable(w);
  const planner = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/planner", planner);

  const ran = await w.post("/planner/auto-roster", planner, new URLSearchParams({ csrf: token }));
  assert.equal(reasonOf(ran), "roster_done");
  const { body } = await w.follow(ran, planner);
  assert.match(body, /proposals made|forslag lavet/, "the message should say what happened, not just 'done'");
  assert.match(body, /waiting for your decision|afventer din beslutning/);
  assert.match(body, /Proposed|Forslag/, "and the grid should mark them as provisional");

  const locked = await w.post("/planner/proposals/lock", planner, new URLSearchParams({ csrf: token }));
  assert.equal(reasonOf(locked), "locked");
  assert.equal(countProposals(w.db, w.seasonId, w.today), 0);
  assert.ok(w.people.some((id) => score(w.db, id, w.seasonId) > 0));
}));

test("discarding from the grid throws the proposals away", withPlanner({}, async (w) => {
  allAvailable(w);
  const planner = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/planner", planner);
  await w.post("/planner/auto-roster", planner, new URLSearchParams({ csrf: token }));
  assert.ok(countProposals(w.db, w.seasonId, w.today) > 0);

  const r = await w.post("/planner/proposals/discard", planner, new URLSearchParams({ csrf: token }));
  assert.equal(reasonOf(r), "discarded");
  assert.equal(countProposals(w.db, w.seasonId, w.today), 0);
  assert.equal(w.people.reduce((s, id) => s + score(w.db, id, w.seasonId), 0), 0);
}));

test("only a planner can run it", withPlanner({}, async (w) => {
  const volunteer = await w.signIn(w.people[1]);
  const { csrfFromCookie } = await import("../tools/testkit.mjs");
  for (const path of ["/planner/auto-roster", "/planner/proposals/lock", "/planner/proposals/discard"]) {
    const r = await w.post(path, volunteer, new URLSearchParams({ csrf: csrfFromCookie(volunteer) }));
    assert.equal(r.status, 403, `${path} must be planner-only`);
  }
  assert.equal(countProposals(w.db, w.seasonId, w.today), 0);
}));

test("the lock and discard controls only appear when there is something to decide", withPlanner({}, async (w) => {
  allAvailable(w);
  const planner = await w.signIn(w.people[0]);
  const before = await (await w.get("/planner", planner)).text();
  assert.ok(!before.includes("/planner/proposals/lock"),
    "a permanently visible discard button invites throwing away real work by accident");

  const { token } = await w.csrfFrom("/planner", planner);
  await w.post("/planner/auto-roster", planner, new URLSearchParams({ csrf: token }));
  const after = await (await w.get("/planner", planner)).text();
  assert.ok(after.includes("/planner/proposals/lock"));
  assert.ok(after.includes("/planner/proposals/discard"));
}));
