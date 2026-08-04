// DoD 4 and 5: the vagtbørs eligibility filter including both negative cases, and the claim race.
// No activity or weekday literals — everything comes from config, which is also what the seams gate checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { loadPattern } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { openSlotsFor, claimSlot, handBackSlot, score, setAvailabilityDay, setAvailabilityHour,
         boardEmptyReason, BOARD_EMPTY_REASONS } from "../src/queries.mjs";

const pattern = loadPattern();
const CAN_KEY = pattern.activities[0].key;          // the activity our capable people can run
const OTHER_KEY = pattern.activities[1].key;        // a different one, for the not-capable case

// Build a world with one target slot and four people who differ in exactly one dimension each.
function world() {
  const db = new DatabaseSync(":memory:");
  const { seasonId } = seedStructure(db, pattern);
  openEverySession(db, seasonId);

  const target = db.prepare(`
    SELECT a.id AS assignmentId, s.date, t.hour
      FROM assignments a JOIN sessions s ON s.id=a.session_id
      JOIN timeslots t ON t.id=s.timeslot_id
      JOIN activities act ON act.id=s.activity_id
     WHERE act.key = ? ORDER BY s.date LIMIT 1
  `).get(CAN_KEY);

  const [able, unavailable, notCapable, silent] = seedPeople(db, seasonId, [
    { name: "Able",        can: [CAN_KEY] },
    { name: "Unavailable", can: [CAN_KEY] },
    { name: "NotCapable",  can: [OTHER_KEY] },
    { name: "Silent",      can: [CAN_KEY] },
  ]);

  setAvailabilityDay(db, able, target.date, true);
  setAvailabilityDay(db, unavailable, target.date, false);   // capable but NOT available
  setAvailabilityDay(db, notCapable, target.date, true);     // available but NOT capable
  // `silent` gets no availability row at all — silence must not be read as consent.

  return { db, seasonId, target, able, unavailable, notCapable, silent };
}

const boardHas = (db, pid, seasonId, assignmentId) =>
  openSlotsFor(db, pid, seasonId).some((s) => s.assignmentId === assignmentId);

test("DoD 4 — the board shows a slot only to someone both capable and available", () => {
  const { db, seasonId, target, able, unavailable, notCapable, silent } = world();
  assert.ok(boardHas(db, able, seasonId, target.assignmentId), "capable + available should see the slot");
  assert.ok(!boardHas(db, unavailable, seasonId, target.assignmentId), "capable but UNAVAILABLE must not see it");
  assert.ok(!boardHas(db, notCapable, seasonId, target.assignmentId), "available but NOT CAPABLE must not see it");
  assert.ok(!boardHas(db, silent, seasonId, target.assignmentId), "no availability answer must not count as available");
});

test("DoD 4 — an hour-level answer overrides the day-level answer", () => {
  const { db, seasonId, target, able } = world();
  assert.ok(boardHas(db, able, seasonId, target.assignmentId));
  setAvailabilityHour(db, able, target.date, target.hour, false);   // free all day EXCEPT this hour
  assert.ok(!boardHas(db, able, seasonId, target.assignmentId), "the hour-level 'no' must win");
  setAvailabilityHour(db, able, target.date, target.hour, true);
  assert.ok(boardHas(db, able, seasonId, target.assignmentId), "and flipping it back must restore the slot");
});

// The eighth board reason, which a coverage run showed had never executed. It is reached only when a volunteer
// passes every other gate — capable, right role, available that day — and the only openings left collide with
// shifts they already hold. Eight strings exist for eight reasons; seven had been produced by a test and this one
// was written from reasoning alone, which is precisely the kind of explanation this project has already caught
// being wrong three times.
test("a board emptied only by double-booking says so, rather than blaming availability", () => {
  const { db, seasonId, able, target } = world();

  // Take everything they could otherwise claim, so the only openings left are at times they are already on.
  const mine = openSlotsFor(db, able, seasonId);
  assert.ok(mine.length > 0, "the fixture needs at least one claimable slot");
  for (const s of mine) claimSlot(db, s.assignmentId, able);
  assert.equal(openSlotsFor(db, able, seasonId).length, 0, "nothing left for them to take");

  // Re-open a slot at a time they are now busy: same date and hour as one they hold, different activity — which
  // the config supports, since more than one activity shares a timeslot.
  const clash = db.prepare(`SELECT a.id FROM assignments a
                             JOIN sessions  s ON s.id = a.session_id
                             JOIN timeslots t ON t.id = s.timeslot_id
                            WHERE a.person_id IS NULL AND s.date = ? AND t.hour = ?
                              AND s.season_id = ? LIMIT 1`).get(target.date, target.hour, seasonId);
  // Asserted, not skipped. A silent `return` here would let this test pass without reaching the branch it exists
  // to cover, which is the vacuous pass this project keeps producing. Verified with the shipped config: the clash
  // is the FOLLOWER half of the same class, so Able is genuinely capable and available for it and only the
  // double-booking gate empties the board. If a future config has one activity per timeslot, this fails loudly
  // and whoever changed it can decide what the reason should be, rather than losing the coverage quietly.
  assert.ok(clash, "the fixture must leave a slot at a time Able is already busy, or this covers nothing");

  const why = boardEmptyReason(db, able, seasonId);
  assert.equal(why.reason, BOARD_EMPTY_REASONS.ALREADY_BUSY,
    `expected the double-booking reason, got "${why.reason}" — a volunteer would be told to fix the wrong thing`);
});

test("DoD 5 — claiming the same slot twice: one row, then zero", () => {
  const { db, seasonId, target, able } = world();
  const second = seedPeople(db, seasonId, [{ name: "Rival", can: [CAN_KEY] }])[0];
  setAvailabilityDay(db, second, target.date, true);

  assert.deepEqual(claimSlot(db, target.assignmentId, able), { ok: true });
  assert.deepEqual(claimSlot(db, target.assignmentId, second), { ok: false, reason: "already_taken" });
  assert.equal(score(db, able, seasonId), 1);
  assert.equal(score(db, second, seasonId), 0);
});

test("an ineligible claim is refused, and refused for the right reason", () => {
  const { db, seasonId, target, unavailable, notCapable } = world();
  assert.deepEqual(claimSlot(db, target.assignmentId, unavailable), { ok: false, reason: "not_eligible" });
  assert.deepEqual(claimSlot(db, target.assignmentId, notCapable), { ok: false, reason: "not_eligible" });
  assert.deepEqual(claimSlot(db, 999999, unavailable), { ok: false, reason: "no_such_slot" });
});

test("handing a slot back returns it to the board, and only its owner may do so", () => {
  const { db, seasonId, target, able } = world();
  const other = seedPeople(db, seasonId, [{ name: "Nosy", can: [CAN_KEY] }])[0];
  setAvailabilityDay(db, other, target.date, true);

  claimSlot(db, target.assignmentId, able);
  assert.ok(!boardHas(db, other, seasonId, target.assignmentId), "a taken slot leaves the board");

  assert.deepEqual(handBackSlot(db, target.assignmentId, other), { ok: false, reason: "not_yours" });
  assert.equal(score(db, able, seasonId), 1, "a failed hand-back must not change anything");

  assert.deepEqual(handBackSlot(db, target.assignmentId, able), { ok: true, pastCutoff: false });
  assert.equal(score(db, able, seasonId), 0);
  assert.ok(boardHas(db, other, seasonId, target.assignmentId), "and it is open to everyone eligible again");
});

test("a hand-back inside the cutoff still releases the slot but flags that a planner must be told", () => {
  const { db, target, able } = world();
  claimSlot(db, target.assignmentId, able);
  // One day before the session, with a two-day cutoff.
  const dayBefore = new Date(Date.parse(`${target.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const r = handBackSlot(db, target.assignmentId, able, { today: dayBefore, cutoffDays: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.pastCutoff, true, "inside the cutoff the caller must be told to notify a planner");
  assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(target.assignmentId).person_id, null);
});
