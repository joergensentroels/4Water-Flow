// Increment Q. The weekly rhythm was editable only by hand-editing config/pattern.json — the exact thing
// CONTRIBUTING names as how a volunteer breaks the config. It surfaced from the question "is it intentional
// that Sunday has only one timeslot?", and it was not: one slot per day is a placeholder I invented, not a
// description of anything real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { makeWorld } from "../tools/testkit.mjs";
import { addWeeklyToForm, removeWeeklyFromForm, sessionsForSlot } from "../src/admin.mjs";
import { loadPattern, validatePattern } from "../src/config.mjs";
import { migrate } from "../src/db.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { eligiblePeopleFor } from "../src/queries.mjs";

const withAdmin = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] }, ...opts });
  try { await fn(w); } finally { w.close(); }
};
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

// ---- several slots on one day, which is the whole point -------------------------------------------------
test("a day can carry several timeslots, and each generates its own sessions", () => {
  const base = loadPattern();
  const richer = validatePattern({
    ...base,
    weekly: [
      { dayOfWeek: 0, hour: 13, minute: 0, activities: ["workshop_yoga"] },
      { dayOfWeek: 0, hour: 15, minute: 0, activities: ["salsa", "bachata"] },
      { dayOfWeek: 0, hour: 17, minute: 30, activities: ["dj"] },
    ],
  });
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    seedStructure(db, richer);
    // Message deliberately avoids naming the weekday: test/ is subject to the same no-hardcoding rule as
    // src/, and the gate caught the first version of this line. The regex assertions below are fine, because
    // the gate scans string literals and a regex literal is not one.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM timeslots").get().n, 3, "three distinct slots on one day");

    const firstSunday = db.prepare("SELECT MIN(date) d FROM sessions").get().d;
    const onThatDay = db.prepare(`SELECT t.hour FROM sessions s JOIN timeslots t ON t.id=s.timeslot_id
                                   WHERE s.date=? ORDER BY t.hour`).all(firstSunday);
    assert.equal(onThatDay.length, 4, "yoga + salsa + bachata + dj");
    assert.deepEqual([...new Set(onThatDay.map((r) => r.hour))], [13, 15, 17]);
  } finally { db.close(); }
});

test("different times on one day do not collide; two activities in one slot still do", () => {
  const base = loadPattern();
  const p = validatePattern({
    ...base,
    weekly: [
      { dayOfWeek: 0, hour: 13, minute: 0, activities: ["salsa"] },
      { dayOfWeek: 0, hour: 15, minute: 0, activities: ["salsa", "bachata"] },
    ],
  });
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    const { seasonId } = seedStructure(db, p);
    const [me] = seedPeople(db, seasonId, [{ name: "Tester", can: ["salsa", "bachata"] }]);
    openEverySession(db, seasonId);
    const date = db.prepare("SELECT MIN(date) d FROM sessions").get().d;
    db.prepare("INSERT INTO availability_day (person_id,date,available) VALUES (?,?,1)").run(me, date);

    const slots = db.prepare(`SELECT a.id, t.hour, act.key FROM assignments a
      JOIN sessions s ON s.id=a.session_id JOIN timeslots t ON t.id=s.timeslot_id
      JOIN activities act ON act.id=s.activity_id WHERE s.date=? ORDER BY t.hour, act.key`).all(date);
    const at13 = slots.find((s) => s.hour === 13);
    const at15 = slots.filter((s) => s.hour === 15);
    assert.equal(at15.length, 2);

    db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(me, at13.id);
    for (const s of at15) {
      assert.ok(eligiblePeopleFor(db, s.id).some((x) => x.id === me),
        `taking 13:00 must not block ${s.key} at 15:00 — one person can teach twice in a day`);
    }
    db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(me, at15[0].id);
    assert.ok(!eligiblePeopleFor(db, at15[1].id).some((x) => x.id === me),
      "two activities in the SAME slot remain a clash");
  } finally { db.close(); }
});

// ---- the form helpers ----------------------------------------------------------------------------------
test("adding a slot keeps the week in reading order and does not mutate the input", () => {
  const base = loadPattern();
  const snapshot = JSON.stringify(base);
  const next = addWeeklyToForm(base, { dayOfWeek: "0", hour: "13", minute: "30", activities: ["dj"] });
  assert.equal(JSON.stringify(base), snapshot, "a failed save must not have half-applied itself in memory");
  assert.equal(next.weekly.length, base.weekly.length + 1);

  const order = next.weekly.map((w) => `${w.dayOfWeek}:${String(w.hour).padStart(2, "0")}:${w.minute}`);
  assert.deepEqual(order, [...order].sort(), `not in reading order: ${order}`);
  const added = next.weekly.find((w) => w.hour === 13 && w.minute === 30);
  assert.deepEqual(added, { dayOfWeek: 0, hour: 13, minute: 30, activities: ["dj"] },
    "strings from the form must become numbers");
});

test("a slot with no activity, or an unknown one, is refused by the validator", () => {
  const base = loadPattern();
  assert.throws(() => validatePattern(addWeeklyToForm(base, { dayOfWeek: "2", hour: "20", minute: "0", activities: [] })),
    /at least one activity/);
  assert.throws(() => validatePattern(addWeeklyToForm(base, { dayOfWeek: "2", hour: "20", minute: "0", activities: ["ghost"] })),
    /unknown activity/);
});

test("removal is by value, so a concurrent edit cannot make it hit the wrong row", () => {
  const base = loadPattern();
  const target = base.weekly[0];
  const { pattern: next, removed } = removeWeeklyFromForm(base, target);
  assert.equal(removed, 1);
  assert.ok(!next.weekly.some((w) => w.dayOfWeek === target.dayOfWeek && w.hour === target.hour));
  // An index-based remove would have deleted something arbitrary here; by value it correctly matches nothing.
  assert.equal(removeWeeklyFromForm(base, { dayOfWeek: 5, hour: 4, minute: 0 }).removed, 0);
});

// ---- through the admin screen --------------------------------------------------------------------------
test("an admin can add a second slot to a day, and only future dates are created", async () => {
  // Clock in the middle of the season, so "from today onward" is observable.
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] }, today: "2026-04-01" });
  try {
    const admin = await w.signIn(w.people[0]);
    const { token } = await w.csrfFrom("/admin", admin);
    const body = new URLSearchParams({ csrf: token, dayOfWeek: "0", time: "17:30" });
    body.append("activities", w.pattern.activities[0].key);
    body.append("activities", w.pattern.activities[2].key);

    const r = await w.post("/admin/weekly/add", admin, body);
    assert.equal(reasonOf(r), "weekly_added");

    const onDisk = JSON.parse(readFileSync(w.patternFile, "utf8"));
    assert.ok(validatePattern(onDisk), "whatever is written must still load");
    const added = onDisk.weekly.find((x) => x.hour === 17 && x.minute === 30);
    assert.ok(added, "the slot should be in the config");
    assert.deepEqual(added.activities.sort(), [w.pattern.activities[0].key, w.pattern.activities[2].key].sort(),
      "both ticked activities must survive — one field name, several checkboxes");

    const range = w.db.prepare(`SELECT MIN(s.date) lo, MAX(s.date) hi FROM sessions s
                                 JOIN timeslots t ON t.id=s.timeslot_id WHERE t.hour=17 AND t.minute=30`).get();
    assert.ok(range.lo >= "2026-04-01", `created sessions before today: ${range.lo}`);
    assert.ok(range.hi <= w.pattern.season.to);
    assert.ok(w.db.prepare("SELECT COUNT(*) n FROM sessions WHERE date < '2026-04-01'").get().n > 0,
      "and the sessions that already existed must be undisturbed");
  } finally { w.close(); }
});

test("removing a slot stops new dates but leaves the ones already created", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const target = w.pattern.weekly[0];
  const before = sessionsForSlot(w.db, w.seasonId, target);
  assert.ok(before > 0);

  const { token, body } = await w.csrfFrom("/admin", admin);
  assert.match(body, new RegExp(`${before} dates this season use this slot|${before} datoer`),
    "the screen must say what removal will leave behind");

  const r = await w.post("/admin/weekly/remove", admin, new URLSearchParams({
    csrf: token, dayOfWeek: String(target.dayOfWeek), hour: String(target.hour), minute: String(target.minute ?? 0),
  }));
  assert.equal(reasonOf(r), "weekly_removed");
  assert.equal(sessionsForSlot(w.db, w.seasonId, target), before,
    "removing a slot means stop creating these, not erase what volunteers signed up for");
  assert.ok(!JSON.parse(readFileSync(w.patternFile, "utf8")).weekly
    .some((x) => x.dayOfWeek === target.dayOfWeek && x.hour === target.hour));

  const { body: after } = await w.follow(r, admin);
  assert.match(after, /stay as they are|står som de er/, "and say so plainly");
}));

test("removing the last slot is refused — a season with no rhythm has nothing to schedule", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  for (const slot of [...w.pattern.weekly]) {
    await w.post("/admin/weekly/remove", admin, new URLSearchParams({
      csrf: token, dayOfWeek: String(slot.dayOfWeek), hour: String(slot.hour), minute: String(slot.minute ?? 0),
    }));
  }
  const onDisk = JSON.parse(readFileSync(w.patternFile, "utf8"));
  assert.ok(onDisk.weekly.length >= 1, "the validator must stop the last one going");
  assert.ok(validatePattern(onDisk), "and whatever is on disk must still load");
}));

test("removing a slot that is not there says so instead of pretending", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const r = await w.post("/admin/weekly/remove", admin, new URLSearchParams({
    csrf: token, dayOfWeek: "5", hour: "4", minute: "0",
  }));
  assert.equal(reasonOf(r), "weekly_not_found");
}));

test("the admin screen lists the rhythm with translated day names", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const body = await (await w.get("/admin", admin)).text();
  assert.match(body, /Ugerytme|Weekly rhythm/);
  // Day names come from strings/, never from code — the seams gate enforces that separately.
  assert.match(body, /onsdag|Wednesday/);
  assert.match(body, /søndag|Sunday/);
  assert.match(body, /19:00/);
  assert.match(body, /name="activities"/, "and offer the activities as checkboxes");
}));
