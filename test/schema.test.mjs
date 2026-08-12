// DoD 1, 2, 3: migration idempotency, seeding, and Score being computed rather than stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db.mjs";
import { loadPattern, roleSlotsFor } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { score } from "../src/queries.mjs";

const fresh = () => new DatabaseSync(":memory:");
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
const columns = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();

test("DoD 1 — migration is idempotent", () => {
  const db = fresh();
  migrate(db);
  const first = tables(db);
  assert.ok(first.length >= 10, `expected at least 10 tables, got ${first.length}`);
  migrate(db);
  assert.deepEqual(tables(db), first, "second migrate changed the schema");
});

test("DoD 3 — no score column exists anywhere", () => {
  const db = fresh();
  migrate(db);
  for (const t of tables(db)) {
    for (const c of columns(db, t)) {
      assert.ok(!/score/i.test(c.name), `found a score column: ${t}.${c.name}`);
    }
  }
});

test("assignments.person_id is nullable — an open slot is a row with no person", () => {
  const db = fresh();
  migrate(db);
  const pid = columns(db, "assignments").find((c) => c.name === "person_id");
  assert.equal(pid.notnull, 0, "person_id must be nullable or the vagtbørs cannot exist");
  // And the session it hangs off must NOT be nullable — an assignment with no session is meaningless.
  assert.equal(columns(db, "assignments").find((c) => c.name === "session_id").notnull, 1);
});

test("DoD 2 — seeding creates a season, activities, timeslots, sessions, 10 people and a capability matrix", () => {
  const db = fresh();
  const pattern = loadPattern();
  const { seasonId, sessions } = seedStructure(db, pattern);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM seasons").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activities").get().n, pattern.activities.length);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM timeslots").get().n, new Set(pattern.weekly.map((w) => w.dayOfWeek + ":" + w.hour + ":" + (w.minute ?? 0))).size);
  assert.ok(sessions > 0, "no sessions were generated");

  // Every generated session must fall on a configured weekday — catches an off-by-one in the date walk,
  // which is the single most likely bug in this file.
  const allowed = new Set(pattern.weekly.map((w) => w.dayOfWeek));
  for (const r of db.prepare("SELECT DISTINCT t.day_of_week d FROM sessions s JOIN timeslots t ON t.id=s.timeslot_id").all()) {
    assert.ok(allowed.has(r.d), `session generated on unconfigured weekday index ${r.d}`);
  }

  // 10 people, each capable of the first configured activity; names are supplied, never invented by src/.
  const firstKey = pattern.activities[0].key;
  const ids = seedPeople(db, seasonId, Array.from({ length: 10 }, (_, i) => ({
    name: `Volunteer ${i + 1}`, contact: `v${i + 1}@example.org`, can: [firstKey],
  })));
  assert.equal(ids.length, 10);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, 10);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM capabilities").get().n, 10);

  // A session now opens one row PER ROLE its activity needs: a partner-dance class two, a workshop one. So
  // this is no longer one-per-session, and the expected total comes from the config rather than a guess.
  const opened = openEverySession(db, seasonId, pattern);
  const byKey = new Map(pattern.activities.map((a) => [a.key, a]));
  const expected = db.prepare(`SELECT act.key FROM sessions s JOIN activities act ON act.id=s.activity_id
                                WHERE s.season_id=?`).all(seasonId)
    .reduce((n, r) => n + roleSlotsFor(byKey.get(r.key)).length, 0);
  assert.equal(opened, expected, "every session should open one slot per role it needs");
  assert.ok(opened > sessions, "classes need two people, so there are more slots than sessions");
});

test("DoD 3 — Score is derived: it moves when an assignment is confirmed and back when it is released", () => {
  const db = fresh();
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const [me] = seedPeople(db, seasonId, [{ name: "Volunteer 1", can: [pattern.activities[0].key] }]);
  openEverySession(db, seasonId);

  assert.equal(score(db, me, seasonId), 0);
  const slot = db.prepare("SELECT id FROM assignments LIMIT 1").get().id;
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(me, slot);
  assert.equal(score(db, me, seasonId), 1);
  db.prepare("UPDATE assignments SET person_id=NULL WHERE id=?").run(slot);
  assert.equal(score(db, me, seasonId), 0);

  // A 'proposed' assignment (auto-roster output the planner has not locked in) must NOT count.
  db.prepare("UPDATE assignments SET person_id=?, state='proposed' WHERE id=?").run(me, slot);
  assert.equal(score(db, me, seasonId), 0, "an unlocked auto-roster proposal must not count toward Score");
});
