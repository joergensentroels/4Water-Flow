// Increment U. Confirmed with Troels: most classes need a leader AND a follower, workshops can be run by one
// person, and some volunteers teach either role. The app previously allowed exactly one person per session and
// stored preferred_role without ever using it — it modelled neither fact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { migrate } from "../src/db.mjs";
import { loadPattern, validatePattern, roleSlotsFor } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { eligiblePeopleFor, openSlotsFor, claimSlot, assignSlot, setAvailabilityDay } from "../src/queries.mjs";
import { autoRoster } from "../src/roster.mjs";
import { saveProfile } from "../src/pages/profile.mjs";

// A world where one class needs both roles and one workshop needs anybody.
function world({ people = [] } = {}) {
  const base = loadPattern();
  const pattern = validatePattern({
    ...base,
    activities: base.activities.map((a) =>
      a.key === "salsa" ? { ...a, needs: { l: 1, f: 1 } }
      : a.key === "workshop_yoga" ? { ...a, needs: { any: 1 } } : a),
    weekly: [
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
  const { db, ids } = world({
    people: [{ name: "Both", preferredRole: "b", can: ["salsa", "workshop_yoga"] },
             { name: "Other", preferredRole: "b", can: ["salsa", "workshop_yoga"] }],
  });
  const [both] = ids;
  const [first, second] = slotsAt(db, 13);          // the salsa class: one leader slot, one follower slot

  assert.equal(assignSlot(db, first.id, both, { expectPersonId: null }).ok, true);

  // The same person cannot also be the other half of the SAME class. They are one person.
  const again = assignSlot(db, second.id, both, { expectPersonId: null });
  assert.equal(again.ok, false, "one person cannot be both the leader and the follower of one class");
  assert.equal(again.reason, "already_booked");
  assert.ok(again.clashesWith, "the refusal should name what they are already doing");

  // Somebody else can, so the slot is not simply broken.
  assert.equal(assignSlot(db, second.id, ids[1], { expectPersonId: null }).ok, true);

  // Nor a different activity at the same hour on the same date.
  const clash = db.prepare(`SELECT a.id FROM assignments a
      JOIN sessions s ON s.id=a.session_id JOIN timeslots t ON t.id=s.timeslot_id
     WHERE a.person_id IS NULL AND t.hour=13 AND s.date=(SELECT MIN(date) FROM sessions) LIMIT 1`).get();
  if (clash) assert.equal(assignSlot(db, clash.id, both, { expectPersonId: null }).reason, "already_booked");

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
