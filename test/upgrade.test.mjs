// Upgrading an existing deployment, which is the one operation nothing exercised.
//
// src/db.mjs carries ADDED_COLUMNS + applyColumnAdditions so a database created by an earlier version gains the
// columns later versions need. On a FRESH database those columns are already in the CREATE TABLE, so the check
// finds them and does nothing — which means all 330 other tests run that function as a no-op, and the branch that
// actually alters a table had never executed anywhere.
//
// That branch is the upgrade path for a live deployment. If it throws, `docker compose pull && up -d` leaves
// 4water with an app that will not start; if it silently loses rows, it takes a season's roster with it. Neither
// is a thing to discover mid-season.
//
// The old shape is built by migrating the REAL schema and then dropping the columns, rather than by hand-writing
// an old CREATE TABLE. A hand-written one would drift from the real schema and end up testing a shape no version
// ever produced. SQLite 3.53 (bundled with node:sqlite here) supports ALTER TABLE ... DROP COLUMN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { migrate } from "../src/db.mjs";
import { ROOT, loadPattern } from "../src/config.mjs";
import { seedSeason, seedPeople } from "../src/seed.mjs";
import { makeBackup, verifyBackup } from "../tools/backup.mjs";
import { writeSeasonSpanningToday } from "../tools/season-fixture.mjs";
import { assignSlot, setAvailabilityDay } from "../src/queries.mjs";
import { calendarTokenFor, personByCalendarToken } from "../src/calendar.mjs";

// The columns ADDED_COLUMNS is responsible for, named here so this test states what it is covering rather than
// silently covering whatever happens to be in the list.
const LATER_COLUMNS = [
  ["assignments", "role"],
  ["people", "calendar_token_hash"],
];

const columnsOf = (db, table) =>
  db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((r) => r.name);

function oldDeployment(file) {
  const db = new DatabaseSync(file);
  migrate(db);
  const pattern = loadPattern();
  const { seasonId } = seedSeason(db, pattern);
  const people = seedPeople(db, seasonId, [
    { name: "Søren Nørgård", contact: "soren@4water.invalid", can: [pattern.activities[0].key] },
    { name: "Bjørn Kjær", contact: "bjorn@4water.invalid", can: [pattern.activities[0].key] },
  ]);

  // Real work in it, for two reasons. The obvious one is that "the upgrade kept the data" is only a claim if
  // there is data. The load-bearing one is that the ALTER must run against a POPULATED table: measured on
  // SQLite 3.53, `ADD COLUMN x TEXT NOT NULL` without a default is accepted on an empty table and rejected on
  // one with rows. Since every other test database is empty at migrate() time, a future NOT NULL column would
  // sail through the whole suite and refuse to apply to 4water's real database. These rows are what stops that.
  const dates = db.prepare("SELECT DISTINCT date FROM sessions WHERE season_id=? ORDER BY date LIMIT 3")
    .all(seasonId).map((r) => r.date);
  for (const d of dates) for (const p of people) setAvailabilityDay(db, p, d, true);
  const slot = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                            WHERE a.person_id IS NULL AND s.season_id=? ORDER BY s.date LIMIT 1`).get(seasonId).id;
  assert.equal(assignSlot(db, slot, people[0], { expectPersonId: null }).ok, true, "fixture needs one real shift");

  const before = {
    people: db.prepare("SELECT COUNT(*) n FROM people").get().n,
    sessions: db.prepare("SELECT COUNT(*) n FROM sessions").get().n,
    assignments: db.prepare("SELECT COUNT(*) n FROM assignments").get().n,
    filled: db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NOT NULL").get().n,
    availability: db.prepare("SELECT COUNT(*) n FROM availability_day").get().n,
    names: db.prepare("SELECT name FROM people ORDER BY id").all().map((r) => r.name),
  };

  // Now make it OLD: remove the columns later versions add.
  for (const [table, column] of LATER_COLUMNS) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.close();
  return { before, people, seasonId, slot };
}

test("a database from an earlier version upgrades in place, and keeps its data", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-upgrade-"));
  const file = path.join(dir, "old.db");
  try {
    const { before, people, slot } = oldDeployment(file);

    // Confirm the fixture really is old — otherwise this test passes by never exercising the branch at all, which
    // is exactly the failure mode it exists to fix.
    {
      const db = new DatabaseSync(file, { readOnly: true });
      for (const [table, column] of LATER_COLUMNS) {
        assert.ok(!columnsOf(db, table).includes(column),
          `the fixture must NOT have ${table}.${column}, or the upgrade branch never runs`);
      }
      db.close();
    }

    // The upgrade: exactly what a redeployed container does on boot.
    const db = new DatabaseSync(file);
    migrate(db);

    for (const [table, column] of LATER_COLUMNS) {
      assert.ok(columnsOf(db, table).includes(column), `${table}.${column} was not added by the upgrade`);
    }

    const after = {
      people: db.prepare("SELECT COUNT(*) n FROM people").get().n,
      sessions: db.prepare("SELECT COUNT(*) n FROM sessions").get().n,
      assignments: db.prepare("SELECT COUNT(*) n FROM assignments").get().n,
      filled: db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NOT NULL").get().n,
      availability: db.prepare("SELECT COUNT(*) n FROM availability_day").get().n,
      names: db.prepare("SELECT name FROM people ORDER BY id").all().map((r) => r.name),
    };
    assert.deepEqual(after, before, "an upgrade must not lose or alter a single row");
    // Danish letters specifically: an upgrade that mangled the encoding would be a silent disaster on a roster.
    assert.ok(after.names.includes("Søren Nørgård"));

    // The new columns are usable, not merely present — the two features they exist for must work on the upgraded
    // database, because "the column is there" is not the claim anybody cares about.
    db.prepare("UPDATE assignments SET role = 'l' WHERE id = ?").run(slot);
    assert.equal(db.prepare("SELECT role FROM assignments WHERE id = ?").get(slot).role, "l",
      "the role column must be writable after the upgrade");

    // calendarTokenFor returns { token, existing } and personByCalendarToken returns { personId, name }. The
    // first draft of this treated both as bare values, and `assert.ok(token)` happily passed on a truthy OBJECT
    // while the lookup correctly refused it — a check that passed without looking at anything, which is the
    // failure mode this project keeps producing. Hence the shape assertion before the behaviour one.
    const minted = calendarTokenFor(db, people[1]);
    assert.equal(typeof minted?.token, "string", "a volunteer must get a real token after the upgrade");
    assert.match(minted.token, /^[A-Za-z0-9_-]{16,64}$/, "and it must be the shape the lookup accepts");
    assert.deepEqual(personByCalendarToken(db, minted.token), { personId: people[1], name: "Bjørn Kjær" },
      "the token must resolve back to that volunteer on the upgraded database");
    assert.notEqual(db.prepare("SELECT calendar_token_hash FROM people WHERE id=?").get(people[1]).calendar_token_hash,
      minted.token, "stored as a hash, never the token itself — same rule as before the upgrade");

    db.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("upgrading twice is a no-op the second time, so a restart cannot corrupt anything", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-upgrade2-"));
  const file = path.join(dir, "old.db");
  try {
    oldDeployment(file);
    const db = new DatabaseSync(file);
    migrate(db);                                   // the upgrade
    const shape = LATER_COLUMNS.map(([t]) => `${t}:${columnsOf(db, t).join(",")}`);
    const rows = db.prepare("SELECT COUNT(*) n FROM assignments").get().n;

    migrate(db);                                   // a restart, or a second container coming up
    migrate(db);
    assert.deepEqual(LATER_COLUMNS.map(([t]) => `${t}:${columnsOf(db, t).join(",")}`), shape,
      "re-running migrate must not add a column twice — the ALTER would throw and take the boot down");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM assignments").get().n, rows);
    db.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// The RUNBOOK's own recovery procedure, executed. It says: stop the app, copy a backup over the live database,
// start it again. test/backup.test.mjs already proves the restored FILE is a working database — it opens it, runs
// a real query, writes to it, and re-migrates. What nothing did was point the real entry point at one and see the
// app come up, which is the actual procedure and the one that matters at 23:00 on a Saturday.
//
// The specific thing worth checking: `VACUUM INTO` produces a fresh database, and journal_mode is a persistent
// per-database setting that a fresh file does NOT inherit — so a restored backup arrives in rollback mode, not
// WAL. The app sets WAL at boot, which is easy to believe and worth confirming rather than believing.
test("the app boots against a restored backup and serves the data that was in it", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-restore-"));
  const live = path.join(dir, "live.db");
  const patternFile = path.join(dir, "pattern.json");
  writeSeasonSpanningToday(patternFile, { key: "restore" });
  const pattern = loadPattern(patternFile);

  try {
    // A deployment with real work in it.
    let expected;
    {
      const db = new DatabaseSync(live);
      migrate(db);
      const { seasonId } = seedSeason(db, pattern);
      const people = seedPeople(db, seasonId, [
        { name: "Søren Nørgård", contact: "soren@4water.invalid", can: [pattern.activities[0].key] },
      ]);
      const dates = db.prepare("SELECT DISTINCT date FROM sessions WHERE season_id=? ORDER BY date LIMIT 2")
        .all(seasonId).map((r) => r.date);
      for (const d of dates) setAvailabilityDay(db, people[0], d, true);
      const slot = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                                WHERE a.person_id IS NULL AND s.season_id=? ORDER BY s.date LIMIT 1`).get(seasonId).id;
      assert.equal(assignSlot(db, slot, people[0], { expectPersonId: null }).ok, true);
      expected = {
        people: db.prepare("SELECT COUNT(*) n FROM people").get().n,
        filled: db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NOT NULL").get().n,
      };
      db.close();
    }

    // Back it up the way the nightly job does, then restore it the way the RUNBOOK says.
    const made = makeBackup({ db: live, dir: path.join(dir, "backups") });
    assert.equal(verifyBackup(made.file).ok, true, "the backup must be sound before restoring it");
    const restored = path.join(dir, "restored.db");
    writeFileSync(restored, readFileSync(made.file));

    // A restored file is NOT in WAL mode, because VACUUM INTO writes a fresh database.
    {
      const db = new DatabaseSync(restored, { readOnly: true });
      const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
      db.close();
      assert.notEqual(mode, "wal", "if this is already wal, the premise below is wrong and worth re-reading");
    }

    // Now boot the real entry point against it.
    const PORT = 8361;
    const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
      cwd: ROOT,
      env: { ...process.env, FOURWATER_DB: restored, FOURWATER_PATTERN: patternFile,
             FOURWATER_SECRET: "r".repeat(48), PORT: String(PORT), HOST: "127.0.0.1", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    try {
      let healthy = false;
      for (let i = 0; i < 80 && !healthy; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (child.exitCode !== null) break;
        try { healthy = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch {}
      }
      assert.ok(healthy, `the app must come up on a restored backup.\nexit=${child.exitCode}\n${out}`);
      assert.equal((await fetch(`http://127.0.0.1:${PORT}/signin`)).status, 200, "and serve pages");

      const db = new DatabaseSync(restored, { readOnly: true });
      const after = {
        people: db.prepare("SELECT COUNT(*) n FROM people").get().n,
        filled: db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NOT NULL").get().n,
      };
      const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
      const name = db.prepare("SELECT name FROM people LIMIT 1").get().name;
      db.close();

      assert.deepEqual(after, expected, "booting must not lose the restored season's work");
      assert.equal(name, "Søren Nørgård", "including the letters in it");
      assert.equal(mode, "wal", "and boot must put the restored database back into WAL mode");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise((r) => child.once("exit", r));
      }
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// The hazard stated in db.mjs, asserted rather than trusted to a comment: no added column may be NOT NULL without
// a default. Such a column applies cleanly to every empty test database and is refused by the only database that
// matters. Checking the DDL text is the cheap way to catch it at authoring time, before anybody deploys.
test("no added column can be NOT NULL without a default, because live tables have rows", () => {
  const ddls = readFileSync(path.join(ROOT, "src", "db.mjs"), "utf8")
    .split("\n").filter((l) => /ddl:\s*"ALTER TABLE/.test(l));
  assert.ok(ddls.length >= 2, `expected the ADDED_COLUMNS ddl lines, found ${ddls.length}`);
  for (const line of ddls) {
    const notNull = /NOT\s+NULL/i.test(line);
    const hasDefault = /DEFAULT\s+\S/i.test(line);
    assert.ok(!notNull || hasDefault,
      `this ALTER is NOT NULL with no DEFAULT, so it works on an empty test database and fails on a populated ` +
      `production one:\n  ${line.trim()}`);
    assert.ok(!/\bUNIQUE\b/i.test(line), `SQLite refuses ADD COLUMN ... UNIQUE outright:\n  ${line.trim()}`);
  }
});

// The other half of the same risk: an upgrade must not silently skip a column somebody added to ADDED_COLUMNS but
// forgot to also put in the CREATE TABLE. Then a fresh install lacks it while an upgraded one has it, and the two
// deployments diverge — the kind of difference that produces a bug reproducible on one instance only.
test("every later-added column is also in the schema a fresh install creates", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  for (const [table, column] of LATER_COLUMNS) {
    assert.ok(columnsOf(db, table).includes(column),
      `${table}.${column} is added by migration but missing from the fresh CREATE TABLE — a fresh install and an ` +
      `upgraded one would have different schemas`);
  }
  db.close();
});
