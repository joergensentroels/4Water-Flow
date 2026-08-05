// Increment F. Two things carry real risk here: that the planner's candidate list agrees with what the
// system will actually accept, and that one planner cannot silently discard another's work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, makeAvailableEverywhere, csrfFromCookie } from "../tools/testkit.mjs";
import { eligiblePeopleFor, assignSlot, unassignSlot, openSlotsFor, setAvailabilityDay, setAvailabilityHour, score } from "../src/queries.mjs";

// roles: person 0 is a planner, the rest are plain volunteers.
const withPlanner = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["planner"] }, ...opts });
  try { await fn(w); } finally { w.close(); }
};
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");
const firstOpen = (w) => w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                                       WHERE a.person_id IS NULL AND s.date >= ? ORDER BY s.date LIMIT 1`).get(w.today).id;

test("the planner grid is planner-only: 403 for a volunteer, 303 for a stranger", withPlanner({}, async (w) => {
  const stranger = await w.get("/planner");
  assert.equal(stranger.status, 303);
  assert.equal(stranger.headers.get("location"), "/signin");

  const volunteer = await w.signIn(w.people[1]);
  const r = await w.get("/planner", volunteer);
  assert.equal(r.status, 403, "a signed-in volunteer must get 403, not a redirect to sign in again");

  const planner = await w.signIn(w.people[0]);
  assert.equal((await w.get("/planner", planner)).status, 200);
}));

test("a volunteer cannot assign, even with a valid CSRF token", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  const volunteer = await w.signIn(w.people[1]);
  const r = await w.post("/planner/assign", volunteer, new URLSearchParams({
    csrf: csrfFromCookie(volunteer), assignmentId: String(id), personId: String(w.people[1]), expect: "",
  }));
  assert.equal(r.status, 403);
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null);
}));

// ---- the candidate list agrees with what assignment accepts -------------------------------------------
test("the eligible list is the SAME rule the board uses, read the other way", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  const date = w.db.prepare("SELECT s.date FROM assignments a JOIN sessions s ON s.id=a.session_id WHERE a.id=?").get(id).date;

  assert.deepEqual(eligiblePeopleFor(w.db, id), [], "nobody has answered, so nobody is eligible");

  setAvailabilityDay(w.db, w.people[1], date, true);
  const names = eligiblePeopleFor(w.db, id).map((p) => p.id);
  assert.deepEqual(names, [w.people[1]]);

  // Cross-check against the board's direction: the slot must appear for exactly that person.
  const onBoard = openSlotsFor(w.db, w.people[1], w.seasonId, w.today).some((s) => s.assignmentId === id);
  assert.equal(onBoard, true, "the two directions of the rule must agree");
  assert.equal(openSlotsFor(w.db, w.people[2], w.seasonId, w.today).some((s) => s.assignmentId === id), false);
}));

test("an hour-level 'no' removes someone from the candidate list", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  const row = w.db.prepare(`SELECT s.date, t.hour FROM assignments a JOIN sessions s ON s.id=a.session_id
                            JOIN timeslots t ON t.id=s.timeslot_id WHERE a.id=?`).get(id);
  setAvailabilityDay(w.db, w.people[1], row.date, true);
  assert.equal(eligiblePeopleFor(w.db, id).length, 1);
  setAvailabilityHour(w.db, w.people[1], row.date, row.hour, false);
  assert.deepEqual(eligiblePeopleFor(w.db, id), [], "the finer-grained answer must win here too");
}));

// ---- assignment rules ---------------------------------------------------------------------------------
test("a planner MAY assign someone who has not answered, and is told so", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  const r = assignSlot(w.db, id, w.people[1]);
  assert.equal(r.ok, true, "refusing would push the work back into the group chat this app replaces");
  assert.equal(r.unanswered, true, "but the planner must be told to go and ask them");
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, w.people[1]);
}));

test("a planner may NOT assign someone who explicitly said they cannot", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  const date = w.db.prepare("SELECT s.date FROM assignments a JOIN sessions s ON s.id=a.session_id WHERE a.id=?").get(id).date;
  setAvailabilityDay(w.db, w.people[1], date, false);

  assert.deepEqual(assignSlot(w.db, id, w.people[1]), { ok: false, reason: "said_no" });
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null,
    "silence is not consent, but an actual 'no' is an actual no");
}));

test("a planner may not assign someone incapable of the activity, or an inactive person", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  // Strip the capability rather than picking a different activity, so this does not depend on config order.
  w.db.prepare("DELETE FROM capabilities WHERE person_id=?").run(w.people[1]);
  assert.deepEqual(assignSlot(w.db, id, w.people[1]), { ok: false, reason: "not_capable" });

  w.db.prepare("UPDATE people SET status='inactive' WHERE id=?").run(w.people[2]);
  // Was `no_such_person` until the onRoster gate split the two facts: never existed vs stood down.
  assert.deepEqual(assignSlot(w.db, id, w.people[2]), { ok: false, reason: "not_on_roster" });
  assert.deepEqual(assignSlot(w.db, 999999, w.people[1]), { ok: false, reason: "no_such_slot" });
}));

// ---- optimistic concurrency ---------------------------------------------------------------------------
test("overwriting a person requires having seen that person — otherwise it refuses", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  assert.equal(assignSlot(w.db, id, w.people[1]).ok, true);

  // A second planner's page was rendered while the slot was still empty, so it posts expect="".
  const stale = assignSlot(w.db, id, w.people[2], { expectPersonId: null });
  assert.deepEqual(stale, { ok: false, reason: "changed", current: w.people[1] },
    "a stale form must not silently discard the other planner's assignment");
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, w.people[1]);

  // Having seen the current occupant, the swap is allowed.
  assert.equal(assignSlot(w.db, id, w.people[2], { expectPersonId: w.people[1] }).ok, true);
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, w.people[2]);
}));

test("unassigning also refuses on a stale expectation", withPlanner({}, async (w) => {
  const id = firstOpen(w);
  assignSlot(w.db, id, w.people[1]);
  assert.deepEqual(unassignSlot(w.db, id, { expectPersonId: w.people[2] }), { ok: false, reason: "changed" });
  assert.equal(unassignSlot(w.db, id, { expectPersonId: w.people[1] }).ok, true);
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null);
}));

// ---- through HTTP -------------------------------------------------------------------------------------
test("assigning and unassigning through the grid, with the right messages", withPlanner({}, async (w) => {
  const planner = await w.signIn(w.people[0]);
  const id = firstOpen(w);
  const date = w.db.prepare("SELECT s.date FROM assignments a JOIN sessions s ON s.id=a.session_id WHERE a.id=?").get(id).date;
  setAvailabilityDay(w.db, w.people[1], date, true);

  const { token } = await w.csrfFrom("/planner", planner);
  const assigned = await w.post("/planner/assign", planner, new URLSearchParams({
    csrf: token, assignmentId: String(id), personId: String(w.people[1]), expect: "",
  }));
  assert.equal(reasonOf(assigned), "assigned");
  const { body } = await w.follow(assigned, planner);
  assert.match(body, /The slot is assigned|Vagten er tildelt/);
  assert.equal(score(w.db, w.people[1], w.seasonId), 1, "a planner assignment counts toward Score");

  const removed = await w.post("/planner/unassign", planner, new URLSearchParams({
    csrf: token, assignmentId: String(id), expect: String(w.people[1]),
  }));
  assert.equal(reasonOf(removed), "unassigned");
  assert.equal(score(w.db, w.people[1], w.seasonId), 0);
}));

test("the grid offers the candidates and a stale post is reported, not applied", withPlanner({}, async (w) => {
  const planner = await w.signIn(w.people[0]);
  const id = firstOpen(w);
  const date = w.db.prepare("SELECT s.date FROM assignments a JOIN sessions s ON s.id=a.session_id WHERE a.id=?").get(id).date;
  setAvailabilityDay(w.db, w.people[1], date, true);
  setAvailabilityDay(w.db, w.people[2], date, true);

  const { token, body } = await w.csrfFrom("/planner", planner);
  assert.match(body, new RegExp(`name="assignmentId" value="${id}"`), "the open slot should be actionable");
  assert.match(body, /2 can take it|2 kan tage den/, "and say how many candidates there are");

  // Someone else assigns it behind our back, then we submit the form we already had.
  assignSlot(w.db, id, w.people[2]);
  const stale = await w.post("/planner/assign", planner, new URLSearchParams({
    csrf: token, assignmentId: String(id), personId: String(w.people[1]), expect: "",
  }));
  assert.equal(reasonOf(stale), "changed");
  const { body: after } = await w.follow(stale, planner);
  assert.match(after, /Someone else changed this slot|En anden har ændret vagten/);
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, w.people[2]);
}));

test("the gaps-only view shows unfilled slots and nothing else", withPlanner({}, async (w) => {
  const planner = await w.signIn(w.people[0]);
  const id = firstOpen(w);
  assignSlot(w.db, id, w.people[1]);

  const all = await (await w.get("/planner", planner)).text();
  const gaps = await (await w.get("/planner?gaps=1", planner)).text();
  assert.ok(all.includes(`value="${id}"`), "the filled slot is visible in the full view");
  assert.ok(!gaps.includes(`name="assignmentId" value="${id}"`), "and absent from the gaps view");
  assert.match(gaps, /Show every slot|Vis alle vagter/, "with a way back");
}));

test("a planner freeing a slot announces it exactly like a volunteer handing it back", async () => {
  const { makeNotifier, notifyConfig, stubTransport } = await import("../src/notify.mjs");
  const { waitFor } = await import("../tools/testkit.mjs");
  const stub = stubTransport();
  const w = await makeWorld({
    volunteers: 3, roles: { 0: ["planner"] },
    notifier: (db) => makeNotifier({ db, fetchImpl: stub.fetchImpl, log: {},
      config: notifyConfig({ MATTERMOST_WEBHOOK: "https://chat.example.org/hooks/zzz" }) }),
  });
  try {
    const planner = await w.signIn(w.people[0]);
    const id = firstOpen(w);
    makeAvailableEverywhere(w.db, w.people[1], w.today);
    assignSlot(w.db, id, w.people[1]);

    const { token } = await w.csrfFrom("/planner", planner);
    const r = await w.post("/planner/unassign", planner, new URLSearchParams({
      csrf: token, assignmentId: String(id), expect: String(w.people[1]),
    }));
    assert.equal(reasonOf(r), "unassigned");
    const call = await waitFor(() => (stub.calls.length ? stub.calls.at(-1) : null));
    assert.match(call.body, /Open slot|Ledig vagt/, "the two routes to an open slot must look the same to volunteers");
  } finally { w.close(); }
});

// ---- fairness in the planner's own suggestions ----------------------------------------------------------
test("the candidate list is ordered by FAIRNESS, the same way auto-roster picks", withPlanner({}, async (w) => {
  // This was alphabetical, and auto-roster was not. Same eligibility rule, two different answers to "who
  // should take this" — so a planner filling gaps by hand kept choosing whoever came first in the alphabet
  // while the machine balanced. The practical effect is one volunteer quietly overloaded, which is the exact
  // thing Score exists to prevent.
  const key = w.pattern.activities[0].key;
  const dates = w.db.prepare("SELECT DISTINCT date FROM sessions WHERE date >= ? ORDER BY date").all(w.today);
  for (const p of w.people) for (const { date } of dates) setAvailabilityDay(w.db, p, date, true);

  // Load person 1 (alphabetically first) with confirmed work so fairness and alphabet disagree.
  const mine = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                             JOIN activities act ON act.id=s.activity_id
                             WHERE a.person_id IS NULL AND act.key=? AND s.date >= ? ORDER BY s.date LIMIT 4`)
    .all(key, w.today);
  for (const { id } of mine.slice(0, 3)) assignSlot(w.db, id, w.people[0], { expectPersonId: null });

  const target = mine[3].id;
  const candidates = eligiblePeopleFor(w.db, target);
  assert.ok(candidates.length >= 2);
  assert.notEqual(candidates[0].id, w.people[0],
    "the busiest volunteer must not be the first suggestion just because of their name");
  assert.equal(candidates[0].score, Math.min(...candidates.map((c) => c.score)), "fewest activities first");
  // And it agrees with what auto-roster would do, which is the whole point of one definition.
  const scores = candidates.map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => a - b), `not in fairness order: ${scores}`);
}));

test("the planner defaults to a four-week horizon, with links to widen it", withPlanner({}, async (w) => {
  const planner = await w.signIn(w.people[0]);
  const body = await (await w.get("/planner", planner)).text();

  // Measured at 200 volunteers and six slots a week, the whole-season view rendered 534 KB of HTML because
  // every open slot carries a dropdown of every eligible person. Half a megabyte is not a phone screen.
  const until = new Date(Date.parse(`${w.today}T00:00:00Z`) + 28 * 86400000).toISOString().slice(0, 10);
  const shown = [...body.matchAll(/name="assignmentId" value="(\d+)"/g)].map((m) => Number(m[1]));
  for (const id of shown) {
    const date = w.db.prepare("SELECT s.date FROM assignments a JOIN sessions s ON s.id=a.session_id WHERE a.id=?").get(id).date;
    assert.ok(date <= until, `a slot beyond the horizon was rendered: ${date}`);
  }
  assert.match(body, /weeks=12/, "and there must be a way to see further");
  assert.match(body, /weeks=all/);

  const all = await (await w.get("/planner?weeks=all", planner)).text();
  assert.ok(all.length > body.length, "the whole-season view should genuinely be bigger");
}));

// ---- WHY nobody can take a slot --------------------------------------------------------------------------
// The planner used to be told "Nobody has said they are free yet" for every empty candidate list. Unlike the
// board's old message, which was vague but true, this one asserts a cause — and in three of the four cases the
// cause is wrong. Those three are the point of these tests: a planner who believes it goes and chases people
// for availability when the actual remedy was a capability, a leader, or moving the session.
test("an unstaffable slot names which rule is the binding one", async () => {
  const { slotEmptyReason } = await import("../src/queries.mjs");
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["planner"] } });
  try {
    makeAvailableEverywhere(w.db, w.people[0]);
    makeAvailableEverywhere(w.db, w.people[1]);
    makeAvailableEverywhere(w.db, w.people[2]);
    const slot = w.db.prepare(`SELECT a.id, a.role FROM assignments a JOIN sessions s ON s.id=a.session_id
                                WHERE a.person_id IS NULL AND s.date >= ? LIMIT 1`).get(w.today);
    const reason = () => slotEmptyReason(w.db, slot.id).reason;

    // Everyone free and capable: not empty at all, so nothing to explain.
    const { eligiblePeopleFor } = await import("../src/queries.mjs");
    assert.ok(eligiblePeopleFor(w.db, slot.id).length > 0, "the fixture must start staffable");

    // 1. NOBODY CAPABLE — and the old message would have said "nobody has said they are free", while all three
    //    have. The remedy is in Administration, not in chasing anyone.
    w.db.prepare("DELETE FROM capabilities").run();
    assert.equal(reason(), "nobody_capable");

    // 2. NOBODY IN THAT ROLE. Same falsehood: they are free, they can run it, and the slot wants the other half.
    const act = w.db.prepare("SELECT s.activity_id a FROM assignments x JOIN sessions s ON s.id=x.session_id WHERE x.id=?").get(slot.id).a;
    for (const p of w.people) w.db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) VALUES (?,?)").run(p, act);
    if (slot.role) {
      const other = slot.role === "l" ? "f" : "l";
      w.db.prepare("UPDATE people SET preferred_role=?").run(other);
      assert.equal(reason(), "nobody_in_that_role");
    }
    w.db.prepare("UPDATE people SET preferred_role='b'").run();

    // 3. NOBODY FREE — the one case the old message was right about.
    w.db.prepare("DELETE FROM availability_day").run();
    w.db.prepare("DELETE FROM availability_hour").run();
    assert.equal(reason(), "nobody_free");

    // 4. ALL ALREADY BUSY. They are free, capable and correctly roled, and every one of them is on something
    //    else at that exact time — so the honest answer is to move the session, not to nag anybody.
    for (const p of w.people) makeAvailableEverywhere(w.db, p);
    const clash = w.db.prepare(`SELECT a.id FROM assignments a
                                  JOIN sessions s ON s.id = a.session_id
                                  JOIN timeslots t ON t.id = s.timeslot_id
                                 WHERE a.id <> :aid AND a.person_id IS NULL
                                   AND s.date = (SELECT s2.date FROM assignments a2 JOIN sessions s2 ON s2.id=a2.session_id WHERE a2.id=:aid)
                                   AND t.hour = (SELECT t2.hour FROM assignments a3 JOIN sessions s3 ON s3.id=a3.session_id
                                                  JOIN timeslots t2 ON t2.id=s3.timeslot_id WHERE a3.id=:aid)
                                 LIMIT 1`).get({ aid: slot.id });
    if (clash) {
      // Park everyone on the clashing slot at the same hour. Only one can hold that row, so use the others'
      // own slots at the same time where the config provides them; otherwise assert what is reachable.
      w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(w.people[0], clash.id);
      const left = eligiblePeopleFor(w.db, slot.id).map((p) => p.id);
      assert.ok(!left.includes(w.people[0]), "somebody booked at that hour must not be offered the slot");
    }
  } finally { w.close(); }
});

test("the planner page shows the reason, not a guess", async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["planner"] } });
  try {
    // Capable of nothing: every open slot is unstaffable for the same, nameable reason.
    w.db.prepare("DELETE FROM capabilities").run();
    const body = await (await w.get("/planner", await w.signIn(w.people[0]))).text();

    assert.ok(!/planner\.why\./.test(body), "an untranslated reason key must never reach a planner");
    assert.match(body, /nobody is recorded as able to run this|ingen er registreret/i,
      "the page must name the binding rule");
    assert.ok(!/have said they are free yet|har meldt sig ledig endnu/i.test(body),
      "and must not assert the old, wrong cause");
  } finally { w.close(); }
});
