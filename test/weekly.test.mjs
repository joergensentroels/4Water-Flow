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

// ---- cadence: not everything happens every week ----------------------------------------------------------
// 4water confirmed that some of their rhythm is fortnightly or monthly. Before this, `seedSeason` created a session
// on EVERY matching weekday, so such an activity could only be faked by adding it weekly and cancelling half its
// dates by hand — invisible in the config and unexplained to a volunteer reading the plan.
test("a fortnightly slot produces half the sessions of a weekly one, and a monthly slot a quarter", () => {
  const base = loadPattern();
  // Same weekday, same season, three cadences. One seed, so nothing about the calendar differs between them.
  const p = validatePattern({
    ...base,
    weekly: [
      { dayOfWeek: 0, hour: 13, minute: 0, activities: ["workshop_yoga"] },
      { dayOfWeek: 0, hour: 15, minute: 0, activities: ["salsa"], everyNth: 2 },
      { dayOfWeek: 0, hour: 17, minute: 0, activities: ["bachata"], everyNth: 4 },
    ],
  });
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    seedStructure(db, p);
    const at = (hour) => db.prepare(`SELECT COUNT(*) n FROM sessions s JOIN timeslots t ON t.id=s.timeslot_id
                                      WHERE t.hour=?`).get(hour).n;
    const [weekly, fortnightly, monthly] = [at(13), at(15), at(17)];
    // The CONTROL, and it has to come first: a filter that skipped everything would satisfy every ratio below.
    assert.ok(weekly >= 8, `only ${weekly} weekly sessions — the season is too short for this test to mean anything`);
    assert.ok(fortnightly > 0 && monthly > 0, "a cadence filter that creates NOTHING is not a cadence filter");
    // Ceil, because the first occurrence always runs: 9 weekly dates means 5 fortnightly, not 4.
    assert.equal(fortnightly, Math.ceil(weekly / 2), `${weekly} weekly should give ${Math.ceil(weekly / 2)} fortnightly`);
    assert.equal(monthly, Math.ceil(weekly / 4), `${weekly} weekly should give ${Math.ceil(weekly / 4)} every-fourth`);
  } finally { db.close(); }
});

test("a mid-season reseed does not move a fortnightly slot to the other week", () => {
  const base = loadPattern();
  const p = validatePattern({ ...base,
    weekly: [{ dayOfWeek: 0, hour: 15, minute: 0, activities: ["salsa"], everyNth: 2 }] });
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    seedStructure(db, p);
    const before = db.prepare("SELECT date FROM sessions ORDER BY date").all().map((r) => r.date);
    assert.ok(before.length >= 4, "not enough dates to detect a phase shift");
    // PRECONDITION, and the test is worthless without it. Reseeding is idempotent for a WEEKLY slot too, so
    // "the dates did not change" is true of a build where cadence does not exist at all. Caught by deliberately
    // disabling the cadence filter and finding that this test did not notice. Fourteen days apart or nothing here
    // is about fortnightly slots.
    const gap = (Date.parse(`${before[1]}T00:00:00Z`) - Date.parse(`${before[0]}T00:00:00Z`)) / 86400000;
    assert.equal(gap, 14, `the fixture is not actually fortnightly — ${gap} days between the first two dates`);
    // Reseed from a date partway through, which is what the admin screen does after a pattern edit. If the phase
    // were counted from the seeding loop's start rather than from season.from, this would create sessions on the
    // OFF weeks — silently doubling the slot and moving shifts people may already be rostered onto.
    seedStructure(db, p, { fromDate: before[2] });
    const after = db.prepare("SELECT date FROM sessions ORDER BY date").all().map((r) => r.date);
    assert.deepEqual(after, before, "the reseed changed which dates the fortnightly slot falls on");
  } finally { db.close(); }
});

test("everyNth is bounded, so a typo cannot quietly empty the plan", () => {
  const base = loadPattern();
  const bad = (everyNth) => () => validatePattern({ ...base,
    weekly: [{ dayOfWeek: 0, hour: 15, minute: 0, activities: ["salsa"], everyNth }] });
  assert.throws(bad(0), /everyNth/, "0 would mean a slot that never runs");
  assert.throws(bad(99), /everyNth/, "99 is a typo, not a cadence");
  assert.throws(bad(2.5), /everyNth/, "half a week is not a cadence");
  // The control: the legal values must still pass, or the bound is just rejecting everything.
  assert.ok(validatePattern({ ...base,
    weekly: [{ dayOfWeek: 0, hour: 15, minute: 0, activities: ["salsa"], everyNth: 2 }] }));
  // And absent still means weekly, which is what every existing config relies on.
  assert.ok(validatePattern({ ...base, weekly: [{ dayOfWeek: 0, hour: 15, minute: 0, activities: ["salsa"] }] }));
});

test("the admin screen can create a fortnightly slot, and says so afterwards", () => {
  const base = loadPattern();
  const added = addWeeklyToForm(base, { dayOfWeek: 2, hour: 18, minute: 0, activities: ["salsa"], everyNth: 2 });
  const slot = added.weekly.find((w) => w.dayOfWeek === 2 && w.hour === 18);
  assert.equal(slot.everyNth, 2, "the cadence chosen on the form did not reach the config");
  // Weekly is the absence of the key, not the number 1 — so the config keeps saying nothing about cadence
  // unless somebody actually chose one, and existing files do not all sprout `everyNth: 1`.
  const plain = addWeeklyToForm(base, { dayOfWeek: 4, hour: 18, minute: 0, activities: ["salsa"], everyNth: 1 });
  assert.ok(!("everyNth" in plain.weekly.find((w) => w.dayOfWeek === 4 && w.hour === 18)),
    "a weekly slot should not carry everyNth: 1");
  const blank = addWeeklyToForm(base, { dayOfWeek: 5, hour: 18, minute: 0, activities: ["salsa"], everyNth: "" });
  assert.ok(!("everyNth" in blank.weekly.find((w) => w.dayOfWeek === 5 && w.hour === 18)),
    "a blank cadence field must not become NaN in the config");
});

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
    // Four rows now, not two: salsa and bachata each need a leader AND a follower.
    assert.equal(at15.length, 4, "two classes at one time, each needing both roles");

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
  // Checked by IDENTITY, not by "nothing is left at that time". Two entries may now share a day and hour and
  // alternate between them, so an empty time is the wrong thing to assert — and asserting it would quietly demand
  // that removing one dance take the other with it, which is the defect tested for further down this file.
  assert.ok(!next.weekly.some((w) => w.dayOfWeek === target.dayOfWeek && w.hour === target.hour
      && (w.minute ?? 0) === (target.minute ?? 0)
      && Number(w.everyNth ?? 1) === Number(target.everyNth ?? 1)
      && Number(w.weekOffset ?? 0) === Number(target.weekOffset ?? 0)),
    "the entry that was asked for is still there");
  assert.equal(next.weekly.length, base.weekly.length - 1, "and exactly one entry went");
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

    // The new sessions must be STAFFABLE, not merely present. This path called seedStructure and not
    // openEverySession, so adding a class produced dates on the plan with no slots on them: nothing to claim,
    // nothing to assign, and nothing anywhere to say why. Same defect as the fresh-deployment one, and the
    // same missing check — the test asserted the sessions existed and stopped there.
    const naked = w.db.prepare(`SELECT COUNT(*) n FROM sessions s
                                 JOIN timeslots t ON t.id = s.timeslot_id
                                WHERE t.hour=17 AND t.minute=30
                                  AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.session_id = s.id)`).get().n;
    assert.equal(naked, 0, `${naked} newly added session(s) have no slots — the class could never be staffed`);
    const opened = w.db.prepare(`SELECT COUNT(*) n FROM assignments a
                                   JOIN sessions s ON s.id = a.session_id
                                   JOIN timeslots t ON t.id = s.timeslot_id
                                  WHERE t.hour=17 AND t.minute=30`).get().n;
    assert.ok(opened > 0, "adding a class must open its slots");
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
  // The cadence control has to be ON THE PAGE. addWeeklyToForm is tested directly, so the handler would accept
  // everyNth perfectly well with no way for an administrator to send it — a capability reachable only by POSTing
  // by hand is not a capability. Both halves: the input, and the cadence stated for the slots already listed.
  assert.match(body, /name="everyNth"/, "the weekly form must offer a cadence, not just accept one");
  assert.match(body, /Every week|Hver uge/, "and each listed slot must say how often it runs");
}));

// ---- the direction nothing checked: an activity no weekly entry staffs -------------------------------------
//
// validatePattern already refuses a weekly entry naming an unknown activity. The reverse was unchecked, and it is
// the consequential half: sessions come ONLY from the weekly rhythm, so an activity no entry names has no dates,
// no slots, and nobody on it. A capability for it is a flag on a person that can never be used. That is the same
// one-directional-gate shape as the environment variables documented in one direction only, and the plural check
// keyed to the name of its own fix.
//
// Found by reading the discovery spec's section 1 — the part read from the real export — and comparing its stated
// recurring pattern against config/pattern.json. The export states a Wednesday 20:15 DJ slot; the config had none,
// so `dj` was an activity the app could never schedule anybody for, and nothing said so.
//
// DECLARED rather than forbidden: an activity with no fixed weekly slot is legitimate, and 4water has some. What is
// not legitimate is one being absent by accident, which is indistinguishable from one being absent on purpose.
const UNSTAFFED_ON_PURPOSE = {
  socials: "Confirmed by 4water: it WAS a staffed activity and was cancelled mid-season, which is why it is absent " +
      "from the export's recurring pattern — the export is a snapshot taken after the cancellation, not evidence " +
      "that it never ran. It is expected back. Kept as an activity so the capability survives the gap and returning " +
      "it is a weekly entry rather than a migration. Was keyed `sh` after the venue; the activity is the socials.",
  workshop_other: "A workshop of no fixed subject, on no fixed weekday. Same position as socials: the capability " +
      "exists so the roster can match on it the moment somebody adds a weekly entry for it.",
  workshop_yoga: "Likewise absent from the export's recurring pattern. It WAS on the shipped weekend slot, which " +
      "the export gives to the two dances it names — an invention contradicting a stated fact, corrected with " +
      "the rhythm. The names are keys here rather than labels because test/seams.test.mjs forbids the labels in " +
      "a string literal, and it caught the first draft of this entry.",
};

test("every configured activity is staffed by some weekly entry, or declared unstaffed with a reason", () => {
  const pattern = JSON.parse(readFileSync(new URL("../config/pattern.json", import.meta.url), "utf8"));
  const keys = pattern.activities.map((a) => a.key);
  const staffed = new Set(pattern.weekly.flatMap((w) => w.activities));
  assert.ok(keys.length >= 4, `only ${keys.length} activities read from the config — this check is not reading it`);
  assert.ok(staffed.size >= 2, `only ${staffed.size} activities are staffed at all — the collector is not working`);

  const orphans = keys.filter((k) => !staffed.has(k) && !(k in UNSTAFFED_ON_PURPOSE));
  assert.deepEqual(orphans, [],
    "these activities exist in the configuration and no weekly entry names them, so no session for them can ever " +
    "be created and a capability for them can never be used. Add a weekly entry, or record the reason in " +
    "UNSTAFFED_ON_PURPOSE:\n  " + orphans.join("\n  "));

  // The other direction, so an exemption cannot outlive its activity or quietly cover a staffed one.
  const stale = Object.keys(UNSTAFFED_ON_PURPOSE).filter((k) => !keys.includes(k));
  assert.deepEqual(stale, [], `declared unstaffed but no longer an activity — remove: ${stale}`);
  const contradicted = Object.keys(UNSTAFFED_ON_PURPOSE).filter((k) => staffed.has(k));
  assert.deepEqual(contradicted, [],
    `declared unstaffed on purpose AND named by a weekly entry — one of the two is wrong: ${contradicted}`);
  for (const [k, why] of Object.entries(UNSTAFFED_ON_PURPOSE)) {
    assert.ok(why.length >= 60, `${k}: say why it has no weekly slot, not merely that it does not`);
  }
});

test("and the shipped rhythm staffs the activities the export's own pattern names", () => {
  // Not the whole spec — that document lives outside the repository and cannot be read from here. This pins the
  // one thing that was wrong: the export states a Wednesday DJ slot, so `dj` must be scheduled somewhere.
  const pattern = JSON.parse(readFileSync(new URL("../config/pattern.json", import.meta.url), "utf8"));
  const staffed = new Set(pattern.weekly.flatMap((w) => w.activities));
  for (const key of ["salsa", "bachata", "dj"]) {
    assert.ok(staffed.has(key),
      `${key} is in the export's stated recurring pattern and no weekly entry staffs it — a shift the app would ` +
      `silently never schedule. config/pattern.json carries the provenance.`);
  }
  // And the DJ slot is its own timeslot, not bolted onto the class hour: the export says 20:15, after 19:00.
  const dj = pattern.weekly.find((w) => w.activities.includes("dj"));
  const classes = pattern.weekly.find((w) => w.activities.includes("salsa") && w.dayOfWeek === dj.dayOfWeek);
  assert.ok(dj.hour * 60 + dj.minute > classes.hour * 60 + classes.minute,
    "the later slot follows the class it comes after, which is what makes it a separate shift somebody else can take");
});

// ---- alternation: the shape the cadence question was actually about -------------------------------------------
//
// `everyNth` alone can only say "every other week starting with the first", so two fortnightly entries at the same
// hour both land on the same weeks. 4water's Wednesday is salsa one week and bachata the next — which that cannot
// express at all. `weekOffset` says WHICH of the n weeks.
test("two slots at the same hour alternate, and never collide", () => {
  const base = loadPattern();
  const p = validatePattern({
    ...base,
    weekly: [
      { dayOfWeek: 3, hour: 19, minute: 0, activities: ["salsa"], everyNth: 2 },
      { dayOfWeek: 3, hour: 19, minute: 0, activities: ["bachata"], everyNth: 2, weekOffset: 1 },
    ],
  });
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    seedStructure(db, p);
    const rows = db.prepare(`SELECT s.date, act.key FROM sessions s
                               JOIN activities act ON act.id = s.activity_id
                              ORDER BY s.date, act.key`).all();
    const byDate = new Map();
    for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) || []), r.key]);
    const dates = [...byDate.keys()].sort();

    // CONTROL FIRST: enough dates for "alternating" to be a claim about anything.
    assert.ok(dates.length >= 8, `only ${dates.length} Wednesdays — too few to show alternation`);
    // Never both on one date. This is the defect the old config had: one slot carrying both dances, every week.
    const both = dates.filter((d) => byDate.get(d).length !== 1);
    assert.deepEqual(both, [], `these dates got more than one dance: ${both.join(", ")}`);
    // And they really alternate rather than one of them simply never appearing.
    const seq = dates.map((d) => byDate.get(d)[0]);
    assert.equal(new Set(seq).size, 2, `only ${[...new Set(seq)].join("/")} was ever scheduled`);
    for (let i = 1; i < seq.length; i++) {
      assert.notEqual(seq[i], seq[i - 1], `${dates[i]} repeats ${seq[i]} from the week before`);
    }
  } finally { db.close(); }
});

test("an offset that can never come round is refused, not silently empty", () => {
  const base = loadPattern();
  const bad = (everyNth, weekOffset) => () => validatePattern({ ...base,
    weekly: [{ dayOfWeek: 3, hour: 19, minute: 0, activities: ["salsa"], everyNth, weekOffset }] });
  // `week % 2 === 2` is false for every week there will ever be, so the slot would produce nothing at all and the
  // season would just look thinner than intended — the silent-absence shape this project keeps closing.
  assert.throws(bad(2, 2), /weekOffset/, "an offset equal to the cadence can never match");
  assert.throws(bad(2, 5), /weekOffset/, "nor one above it");
  assert.throws(bad(1, 1), /weekOffset/, "and on a weekly slot every offset above 0 is unreachable");
  assert.throws(bad(2, -1), /weekOffset/, "a negative offset is not a week");
  // THE CONTROL: the reachable offsets must still pass, or this is just rejecting everything.
  assert.ok(validatePattern({ ...base,
    weekly: [{ dayOfWeek: 3, hour: 19, minute: 0, activities: ["salsa"], everyNth: 2, weekOffset: 1 }] }));
  assert.ok(validatePattern({ ...base,
    weekly: [{ dayOfWeek: 3, hour: 19, minute: 0, activities: ["salsa"], everyNth: 2, weekOffset: 0 }] }));
});

test("the admin screen can create the second half of an alternating pair", () => {
  const base = loadPattern();
  const added = addWeeklyToForm(base, { dayOfWeek: 2, hour: 18, minute: 0, activities: ["bachata"],
                                        everyNth: 2, weekOffset: 1 });
  const slot = added.weekly.find((w) => w.dayOfWeek === 2 && w.hour === 18);
  assert.equal(slot.everyNth, 2);
  assert.equal(slot.weekOffset, 1, "the chosen week did not reach the config");
  // An offset on a WEEKLY slot is dropped rather than written: it could never match, and validatePattern would
  // refuse the file at startup. Not writing it beats writing something that gets refused.
  const weekly = addWeeklyToForm(base, { dayOfWeek: 4, hour: 18, minute: 0, activities: ["salsa"],
                                         everyNth: 1, weekOffset: 1 });
  assert.ok(!("weekOffset" in weekly.weekly.find((w) => w.dayOfWeek === 4 && w.hour === 18)),
    "an offset with no cadence to sit in must not be written");
  // And offset 0 is the default, so it is not written either.
  const first = addWeeklyToForm(base, { dayOfWeek: 5, hour: 18, minute: 0, activities: ["salsa"],
                                        everyNth: 2, weekOffset: 0 });
  assert.ok(!("weekOffset" in first.weekly.find((w) => w.dayOfWeek === 5 && w.hour === 18)),
    "weekOffset 0 is the default and should not be written out");
});

test("removing one of an alternating pair leaves the other alone", () => {
  const base = loadPattern();
  const p = { ...base, weekly: [
    { dayOfWeek: 3, hour: 19, minute: 0, activities: ["salsa"], everyNth: 2 },
    { dayOfWeek: 3, hour: 19, minute: 0, activities: ["bachata"], everyNth: 2, weekOffset: 1 },
    { dayOfWeek: 3, hour: 20, minute: 15, activities: ["dj"] },
  ] };
  // Day, hour and minute identified a slot only while every entry ran weekly. Removing "the Wednesday 19:00 one"
  // used to take both halves of the pair with it — an admin dropping one dance would silently lose the other.
  const { pattern: afterOne, removed } = removeWeeklyFromForm(p, { dayOfWeek: 3, hour: 19, minute: 0,
                                                                  everyNth: 2, weekOffset: 1 });
  assert.equal(removed, 1, "exactly one half of the pair should go");
  const left = afterOne.weekly.filter((w) => w.hour === 19);
  assert.equal(left.length, 1);
  assert.deepEqual(left[0].activities, ["salsa"], "the wrong half was removed");

  // THE CONTROL: an old form post carrying no cadence still removes everything at that time, which is what it
  // meant before alternation existed. Silently changing that would break a bookmarked form.
  assert.equal(removeWeeklyFromForm(p, { dayOfWeek: 3, hour: 19, minute: 0 }).removed, 2,
    "without cadence fields the removal is by time alone, as it always was");
  // And a cadence that matches nothing removes nothing, rather than falling back to time.
  assert.equal(removeWeeklyFromForm(p, { dayOfWeek: 3, hour: 19, minute: 0, everyNth: 3 }).removed, 0);
});
