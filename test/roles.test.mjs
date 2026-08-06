// Increment U. Confirmed with Troels: most classes need a leader AND a follower, workshops can be run by one
// person, and some volunteers teach either role. The app previously allowed exactly one person per session and
// stored preferred_role without ever using it — it modelled neither fact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeWorld, csrfFromCookie, makeAvailableEverywhere, waitFor } from "../tools/testkit.mjs";
import { makeNotifier, notifyConfig, stubTransport } from "../src/notify.mjs";
import { migrate } from "../src/db.mjs";
import { loadPattern, validatePattern, roleSlotsFor } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { eligiblePeopleFor, openSlotsFor, claimSlot, assignSlot, setAvailabilityDay } from "../src/queries.mjs";
import { autoRoster } from "../src/roster.mjs";
import { saveProfile } from "../src/pages/profile.mjs";

// A world where one class needs both roles and one workshop needs anybody.
function world({ people = [], weekly = null } = {}) {
  const base = loadPattern();
  const pattern = validatePattern({
    ...base,
    activities: base.activities.map((a) =>
      a.key === "salsa" ? { ...a, needs: { l: 1, f: 1 } }
      : a.key === "workshop_yoga" ? { ...a, needs: { any: 1 } } : a),
    weekly: weekly ?? [
      { dayOfWeek: 0, hour: 13, minute: 0, activities: ["salsa"] },
      { dayOfWeek: 0, hour: 16, minute: 0, activities: ["workshop_yoga"] },
    ],
  });
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const { seasonId } = seedStructure(db, pattern);
  const ids = seedPeople(db, seasonId, people);
  openEverySession(db, seasonId, pattern);
  const dates = db.prepare("SELECT DISTINCT date FROM sessions").all();
  for (const id of ids) for (const { date } of dates) setAvailabilityDay(db, id, date, true);
  return { db, pattern, seasonId, ids };
}
const slotsAt = (db, hour) => db.prepare(`SELECT a.id, a.role FROM assignments a
  JOIN sessions s ON s.id=a.session_id JOIN timeslots t ON t.id=s.timeslot_id
  WHERE t.hour=? AND s.date=(SELECT MIN(date) FROM sessions) ORDER BY a.role`).all(hour);

// ---- what the config declares --------------------------------------------------------------------------
test("needs is validated, and absent means one person of any role", () => {
  const base = loadPattern();
  const swap = (needs) => validatePattern({ ...base, activities: base.activities.map((a, i) => i === 0 ? { ...a, needs } : a) });

  assert.deepEqual(roleSlotsFor({ needs: { l: 1, f: 1 } }), ["l", "f"]);
  assert.deepEqual(roleSlotsFor({ needs: { any: 1 } }), [null]);
  assert.deepEqual(roleSlotsFor({}), [null], "no declaration means one person, role irrelevant");
  assert.deepEqual(roleSlotsFor({ needs: { l: 2, f: 1 } }), ["l", "l", "f"]);

  assert.throws(() => swap({ x: 1 }), /unknown role "x"/);
  assert.throws(() => swap({ l: 0, f: 0 }), /at least one person/);
  assert.throws(() => swap({ l: 1.5 }), /whole number/);
  // Mixing "any" with a specific role has no predictable meaning — would a leader fill the any-slot or the
  // l-slot? Refusing beats inventing a rule nobody can guess.
  assert.throws(() => swap({ any: 1, l: 1 }), /not both/);
});

test("a class opens two slots, a workshop one", () => {
  const { db } = world();
  assert.deepEqual(slotsAt(db, 13).map((s) => s.role), ["f", "l"], "the class needs both roles");
  assert.deepEqual(slotsAt(db, 16).map((s) => s.role), [null], "the workshop needs one person, role irrelevant");
  db.close();
});

test("topping up is per role — a half-staffed session gets its missing role, not a duplicate", () => {
  const { db, pattern, seasonId } = world();
  // Delete just the follower row, as though the config had changed under an existing season.
  db.prepare("DELETE FROM assignments WHERE role='f'").run();
  const before = db.prepare("SELECT COUNT(*) n FROM assignments WHERE role='l'").get().n;

  const created = openEverySession(db, seasonId, pattern);
  assert.ok(created > 0, "the missing follower rows must be created");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assignments WHERE role='l'").get().n, before,
    "and no extra leader rows — the old check asked only whether a session had ANY assignment, which would " +
    "have left every session permanently half-staffed");
  assert.equal(openEverySession(db, seasonId, pattern), 0, "still idempotent");
  db.close();
});

// The other direction: an activity the config no longer defines. RUNBOOK says removing one "stops new sessions
// being created for it and LEAVES EXISTING ONES ALONE, because deleting sessions would destroy assignments
// volunteers have already agreed to". That was true of the sessions and false of their slots.
//
// `byKey.get()` returned undefined for the missing activity, and roleSlotsFor's "absent needs means one person,
// role irrelevant" default then invented a role-less slot for every session of it. Measured before the fix:
// removing a single activity produced 51 phantom open slots across a season, including a third row on classes
// whose leader and follower were both already filled and confirmed. The shift exchange offers a slot on a
// fully-staffed class, a volunteer can take it, and the planner sees a gap that is not one.
test("an activity the config no longer defines gains no phantom slots, even a fully staffed one", () => {
  // Two people, so a session can actually be filled — `world()` seeds nobody by default.
  const { db, pattern, seasonId, ids } = world({ people: [
    { name: "Lead", preferredRole: "l", can: ["salsa"] },
    { name: "Follow", preferredRole: "f", can: ["salsa"] },
  ] });
  const twoRole = pattern.activities.find((a) => a.needs && (a.needs.l || a.needs.f));
  assert.ok(twoRole, "precondition: the fixture needs a two-role activity for this to mean anything");

  const rowsOf = () => db.prepare(`
    SELECT a.id, a.role, a.person_id FROM assignments a
      JOIN sessions s ON s.id = a.session_id JOIN activities act ON act.id = s.activity_id
     WHERE act.key = ? ORDER BY a.id`).all(twoRole.key);

  // Fill one session completely, so "left alone" is distinguishable from "topped up".
  const first = rowsOf().slice(0, 2);
  assert.equal(first.length, 2, "a class opens two slots to begin with");
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(ids[0], first[0].id);
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(ids[1], first[1].id);
  const before = rowsOf();

  // The only way to remove an activity: edit the config. The admin screen can add one but not take one away.
  const without = { ...pattern, activities: pattern.activities.filter((a) => a.key !== twoRole.key) };
  const created = openEverySession(db, seasonId, without);

  assert.equal(created, 0, "an unknown activity must produce no slots at all, not one per session");
  assert.deepEqual(rowsOf(), before, "and the existing rows must be byte-for-byte what they were");
  // Specifically: no role-less row alongside the leader and follower.
  assert.equal(rowsOf().filter((r) => r.role === null).length, 0,
    "a role-less slot on a partner-dance class is a claimable gap that should not exist");

  // A second call must not accumulate either — the first version added exactly one per session and then stopped,
  // which is the kind of "idempotent" that has already done the damage.
  assert.equal(openEverySession(db, seasonId, without), 0);
  assert.deepEqual(rowsOf(), before);
  db.close();
});

// ---- eligibility --------------------------------------------------------------------------------------
test("a leader slot offers leaders and both-role people, never followers", () => {
  const { db, ids } = world({ people: [
    { name: "Lead Only", preferredRole: "l", can: ["salsa", "workshop_yoga"] },
    { name: "Follow Only", preferredRole: "f", can: ["salsa", "workshop_yoga"] },
    { name: "Either Way", preferredRole: "b", can: ["salsa", "workshop_yoga"] },
  ] });
  const [leadOnly, followOnly, either] = ids;
  const [followerSlot, leaderSlot] = slotsAt(db, 13);   // ordered by role: f, l

  const forLeader = eligiblePeopleFor(db, leaderSlot.id).map((p) => p.id).sort();
  assert.deepEqual(forLeader, [leadOnly, either].sort(), "leaders and both, not the follower");

  const forFollower = eligiblePeopleFor(db, followerSlot.id).map((p) => p.id).sort();
  assert.deepEqual(forFollower, [followOnly, either].sort());

  // The workshop takes anyone at all.
  const anySlot = slotsAt(db, 16)[0];
  assert.deepEqual(eligiblePeopleFor(db, anySlot.id).map((p) => p.id).sort(), ids.slice().sort(),
    "a role-less slot must not filter on role");
  db.close();
});

test("the board only shows a volunteer the role slots they can actually fill", () => {
  const { db, seasonId, ids } = world({ people: [
    { name: "Follow Only", preferredRole: "f", can: ["salsa"] },
  ] });
  const [me] = ids;
  const offered = openSlotsFor(db, me, seasonId, "0000-00-00");
  assert.ok(offered.length > 0);
  for (const s of offered) assert.notEqual(s.role, "l", "a follower must never be offered a leader slot");
  assert.ok(offered.every((s) => s.role === "f"), "and every offer carries its role so the page can say which");
  db.close();
});

test("claiming the wrong role is refused, and it cannot be bypassed by knowing the id", () => {
  const { db, ids } = world({ people: [
    { name: "Follow Only", preferredRole: "f", can: ["salsa"] },
  ] });
  const [me] = ids;
  const [, leaderSlot] = slotsAt(db, 13);
  assert.deepEqual(claimSlot(db, leaderSlot.id, me), { ok: false, reason: "not_eligible" });
  assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(leaderSlot.id).person_id, null);
  db.close();
});

test("a planner assigning directly is refused with a role-specific reason", () => {
  const { db, ids } = world({ people: [
    { name: "Follow Only", preferredRole: "f", can: ["salsa"] },
  ] });
  const [me] = ids;
  const [, leaderSlot] = slotsAt(db, 13);
  // Distinct from not_capable: the person CAN teach salsa, just not as a leader. A planner needs to know
  // which, or they will keep retrying the same person.
  assert.deepEqual(assignSlot(db, leaderSlot.id, me), { ok: false, reason: "wrong_role" });
  db.close();
});

test("one person cannot fill both halves of the same class", () => {
  const { db, ids } = world({ people: [
    { name: "Either Way", preferredRole: "b", can: ["salsa"] },
  ] });
  const [me] = ids;
  const [followerSlot, leaderSlot] = slotsAt(db, 13);
  assert.equal(claimSlot(db, leaderSlot.id, me).ok, true);
  // Falls out of the double-booking rule for free: both rows share a date and time.
  assert.deepEqual(claimSlot(db, followerSlot.id, me), { ok: false, reason: "not_eligible" },
    "taking the leader half must remove them from the follower half");
  db.close();
});

// ---- auto-roster inherits it ---------------------------------------------------------------------------
test("auto-roster staffs both halves of a class with different, correctly-roled people", () => {
  const { db, seasonId, ids } = world({ people: [
    { name: "Lead Only", preferredRole: "l", can: ["salsa"] },
    { name: "Follow Only", preferredRole: "f", can: ["salsa"] },
  ] });
  const [leadOnly, followOnly] = ids;
  const r = autoRoster(db, { seasonId, fromDate: "0000-00-00" });
  assert.ok(r.filled > 0);

  // Every proposal must sit in a slot whose role the person actually teaches.
  const wrong = db.prepare(`SELECT a.id, a.role, p.preferred_role AS pref FROM assignments a
    JOIN people p ON p.id = a.person_id WHERE a.person_id IS NOT NULL AND a.role IS NOT NULL
      AND p.preferred_role <> 'b' AND p.preferred_role <> a.role`).all();
  assert.deepEqual(wrong, [], `auto-roster put somebody in the wrong role: ${JSON.stringify(wrong)}`);

  // And the two halves of one class went to two different people.
  const pair = db.prepare(`SELECT a.role, a.person_id FROM assignments a
    JOIN sessions s ON s.id=a.session_id JOIN timeslots t ON t.id=s.timeslot_id
    WHERE t.hour=13 AND s.date=(SELECT MIN(date) FROM sessions)`).all();
  const filled = pair.filter((p) => p.person_id != null);
  if (filled.length === 2) assert.notEqual(filled[0].person_id, filled[1].person_id);
  db.close();
});

test("a class with nobody for one role is reported as a gap, not silently half-staffed", () => {
  const { db, seasonId } = world({ people: [
    { name: "Lead Only", preferredRole: "l", can: ["salsa"] },
  ] });
  const r = autoRoster(db, { seasonId, fromDate: "0000-00-00" });
  assert.ok(r.gaps > 0, "the follower halves have no candidate and must be counted");
  const openFollowers = db.prepare("SELECT COUNT(*) n FROM assignments WHERE role='f' AND person_id IS NULL").get().n;
  assert.ok(openFollowers > 0, "and left open rather than given to the leader");
  db.close();
});

// ---- the volunteer owns their own role -----------------------------------------------------------------
test("a volunteer sets their own dance role, and a malformed value leaves it alone", async () => {
  const w = await makeWorld({ volunteers: 2 });
  try {
    const before = w.db.prepare("SELECT preferred_role FROM people WHERE id=?").get(w.people[0]).preferred_role;
    assert.equal(saveProfile(w.db, w.people[0], { name: "V", contact: "", preferredRole: "l" }).ok, true);
    assert.equal(w.db.prepare("SELECT preferred_role FROM people WHERE id=?").get(w.people[0]).preferred_role, "l");

    // Nonsense must not null it: that would quietly make them ineligible for every class.
    saveProfile(w.db, w.people[0], { name: "V", contact: "", preferredRole: "wizard" });
    assert.equal(w.db.prepare("SELECT preferred_role FROM people WHERE id=?").get(w.people[0]).preferred_role, "l");
    saveProfile(w.db, w.people[0], { name: "V", contact: "" });
    assert.equal(w.db.prepare("SELECT preferred_role FROM people WHERE id=?").get(w.people[0]).preferred_role, "l",
      "an absent field is not an instruction to erase");
    assert.ok(before);

    // And it is offered on the page — unlike capabilities, which stay with an admin.
    const cookie = await w.signIn(w.people[0]);
    const body = await (await w.get("/me", cookie)).text();
    assert.match(body, /name="preferredRole"/, "a volunteer owns this fact about themselves");
    assert.match(body, /Leader|Fører/);
  } finally { w.close(); }
});

test("the role appears on the slot wherever a slot is shown", async () => {
  const w = await makeWorld({ volunteers: 2 });
  try {
    const cookie = await w.signIn(w.people[0]);
    // Give them a slot with a role so the plan has something roled to render.
    const roled = w.db.prepare("SELECT id FROM assignments WHERE role IS NOT NULL LIMIT 1").get();
    if (roled) {
      w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(w.people[0], roled.id);
      const plan = await (await w.get("/plan", cookie)).text();
      assert.match(plan, /leader|follower|fører|følger/, "a roled slot must say which role it is");
    }
  } finally { w.close(); }
});

// ---- nobody is in two places at once -------------------------------------------------------------------
// Found by looking at the demo planner and noticing one volunteer down for two 19:00 classes on the same date.
// The rule lived only in eligiblePredicate, which gates the CANDIDATE LIST — so the board and the auto-roster
// were safe and a direct planner assignment was not. tools/demo.mjs writes through assignSlot and produced
// nine of them, one of which had the same person as both the leader and the follower of a single class.
test("assignSlot refuses to book someone who is already busy at that time", () => {
  // TWO activities at 13:00, which is what the real rhythm looks like — Wed 19:00 runs salsa and bachata at the same
  // moment. The default fixture had one activity per time, so the "different activity, same time" case below could not
  // exist in it: the assertion sat behind `if (clash)`, the query found nothing, and tools/deadassert.mjs reported it
  // as never executed. The clash rule keys on date AND hour AND minute, so nothing but a same-minute pair can test it.
  const { db, ids } = world({
    people: [{ name: "Both", preferredRole: "b", can: ["salsa", "workshop_yoga"] },
             { name: "Other", preferredRole: "b", can: ["salsa", "workshop_yoga"] }],
    weekly: [
      { dayOfWeek: 0, hour: 13, minute: 0, activities: ["salsa", "workshop_yoga"] },
      { dayOfWeek: 0, hour: 16, minute: 0, activities: ["workshop_yoga"] },
    ],
  });
  const [both] = ids;
  // Selected by ACTIVITY rather than by slotsAt's role ordering, which now returns three rows at 13:00 and puts the
  // workshop's NULL role first.
  const at13 = (key) => db.prepare(`SELECT a.id, a.role FROM assignments a
      JOIN sessions s ON s.id=a.session_id JOIN timeslots t ON t.id=s.timeslot_id
      JOIN activities act ON act.id=s.activity_id
     WHERE t.hour=13 AND act.key=? AND s.date=(SELECT MIN(date) FROM sessions) ORDER BY a.role`).all(key);
  const [first, second] = at13("salsa");            // the salsa class: one leader slot, one follower slot
  assert.ok(first && second, "the salsa class must open both role slots");

  assert.equal(assignSlot(db, first.id, both, { expectPersonId: null }).ok, true);

  // The same person cannot also be the other half of the SAME class. They are one person.
  const again = assignSlot(db, second.id, both, { expectPersonId: null });
  assert.equal(again.ok, false, "one person cannot be both the leader and the follower of one class");
  assert.equal(again.reason, "already_booked");
  assert.ok(again.clashesWith, "the refusal should name what they are already doing");

  // Somebody else can, so the slot is not simply broken.
  assert.equal(assignSlot(db, second.id, ids[1], { expectPersonId: null }).ok, true);

  // Nor a DIFFERENT activity starting at the same moment — the workshop that also runs at 13:00. No longer behind an
  // `if`: the fixture above guarantees the slot exists, and if it ever stops existing this fails instead of skipping.
  const [otherActivity] = at13("workshop_yoga");
  assert.ok(otherActivity, "the fixture must open a second activity at 13:00 for this to be askable");
  const across = assignSlot(db, otherActivity.id, both, { expectPersonId: null });
  assert.equal(across.ok, false, "one person cannot teach salsa and run a workshop at the same moment");
  assert.equal(across.reason, "already_booked");
  assert.ok(across.clashesWith, "and the refusal must name the class they are already down for");

  // A DIFFERENT hour is fine — this must reject collisions, not the person.
  const later = slotsAt(db, 16)[0];
  assert.equal(assignSlot(db, later.id, both, { expectPersonId: null }).ok, true,
    "16:00 does not collide with 13:00");
  db.close();
});

test("no path in the app produces a double booking", () => {
  const { db, ids, seasonId } = world({
    people: Array.from({ length: 6 }, (_, i) => ({
      name: `P${i}`, preferredRole: ["l", "f", "b"][i % 3], can: ["salsa", "workshop_yoga"],
    })),
  });
  // Let the auto-roster fill everything it can, then assert the invariant over the whole result.
  autoRoster(db, { seasonId });
  db.prepare("UPDATE assignments SET state='confirmed' WHERE state='proposed'").run();

  const doubled = db.prepare(`
    SELECT a.person_id, s.date, t.hour, t.minute, COUNT(*) n
      FROM assignments a
      JOIN sessions  s ON s.id = a.session_id
      JOIN timeslots t ON t.id = s.timeslot_id
     WHERE a.person_id IS NOT NULL
     GROUP BY a.person_id, s.date, t.hour, t.minute
    HAVING n > 1`).all();
  assert.deepEqual(doubled, [], "someone is booked twice in one timeslot");
  assert.ok(ids.length === 6);
  db.close();
});

// The announcement is the one place the text has to stand alone — read in a chat channel, away from the app.
// Increment U put the role on the board, the plan and the planner and left this saying only the activity, so
// the message that most needed to say "leader" was the only one that did not.
test("a shift-became-free announcement names the role", async () => {
  // A real notifier, passed as a factory because it needs the database makeWorld creates. Without one,
  // announceOpenSlot returns early and this test would pass by never announcing anything.
  const w = await makeWorld({
    volunteers: 3, roles: { 0: ["planner"] },
    notifier: (db) => makeNotifier({ db, config: notifyConfig({}), fetchImpl: stubTransport(), log: { warn() {} } }),
  });
  try {
    for (const p of w.people) makeAvailableEverywhere(w.db, p);
    const roled = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                                 WHERE a.role IS NOT NULL AND s.date >= ? ORDER BY s.date LIMIT 1`).get(w.today);
    // ASSERTED, not skipped — and this test of all of them, because eight lines below is a comment recording that
    // it "passed for the wrong reason once already" when a silent redirect made a missing announcement look like a
    // broken feature. An early return here is a second way to pass for the wrong reason, sitting directly above the
    // note about the first. The configured pattern has role slots; if it stops having them this must say so.
    assert.ok(roled, "the configured pattern must open role-specific slots, or this test cannot exercise the " +
                     "announcement path it exists for");
    // Give it to someone, then have a planner free it — that is the path that announces.
    const who = w.db.prepare(`SELECT p.id FROM people p WHERE p.preferred_role IN ('l','f','b') LIMIT 1`).get().id;
    w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(who, roled.id);

    const cookie = await w.signIn(w.people[0]);
    const csrf = csrfFromCookie(cookie);
    const res = await w.post("/planner/unassign", cookie,
      new URLSearchParams({ assignmentId: String(roled.id), expect: String(who), csrf }));
    // Assert the action actually happened. Without this the test passed for the wrong reason once already: the
    // POST was silently redirected to /signin and "no announcement" looked like the feature being broken.
    assert.equal(res.headers.get("location"), "/planner?r=unassigned", "the planner must have freed the slot");

    // announceOpenSlot is fired and not awaited — deliberately, so a broken webhook cannot make a volunteer's
    // hand-back hang — which means the row can land after the response. Polling, not sleeping.
    const sent = await waitFor(() =>
      w.db.prepare("SELECT body FROM notifications WHERE kind='slot_open' ORDER BY id DESC LIMIT 1").get());
    assert.ok(sent, "freeing a slot must announce it");
    assert.match(sent.body, /leader|follower|fører|følger/,
      `the announcement must say which role is open, got: ${sent.body}`);
  } finally { w.close(); }
});
