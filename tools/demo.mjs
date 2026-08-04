// A populated database you can actually look at.
//
//   node tools/demo.mjs                       # build demo.db
//   FOURWATER_AUTH=dev FOURWATER_DB=demo.db FOURWATER_SECRET=$(openssl rand -hex 32) node src/server.mjs
//
// Everything here is invented ON PURPOSE and obviously so — "Demo One", "demo1@example.invalid". Nothing
// resembles a real 4water volunteer, because a demo database that looks like production is a demo database
// somebody eventually mistakes for production.
import { openDb, migrate } from "../src/db.mjs";
import { loadPattern } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { setAvailabilityDay, setAvailabilityHour, assignSlot } from "../src/queries.mjs";
import { bootstrapAdmin } from "./bootstrap.mjs";

const NAMES = ["Demo One", "Demo Two", "Demo Three", "Demo Four", "Demo Five", "Demo Six",
               "Demo Seven", "Demo Eight", "Demo Nine", "Demo Ten", "Demo Eleven", "Demo Twelve"];

// A season that SPANS TODAY. The real config describes 4water's actual export, whose season ended in June —
// and a demo whose season is over demonstrates the empty state rather than the product. Signing in as a
// planner showed "there is nothing to plan yet", which is correct behaviour and a useless demo.
//
// Six weeks behind for history that has been filled, four months ahead so there is real work to plan.
export function demoSeason(today = new Date()) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 42 * 86400000);
  const to = new Date(today.getTime() + 120 * 86400000);
  return { key: `demo-${iso(from)}`, from: iso(from), to: iso(to) };
}

export function demoPattern(base = loadPattern(), today = new Date()) {
  // Two slots on the Sunday, because a single slot per day was a placeholder and the demo should not repeat it.
  const keys = base.activities.map((a) => a.key);
  return {
    ...base,
    season: demoSeason(today),
    weekly: [
      { dayOfWeek: 3, hour: 19, minute: 0, activities: [keys[0], keys[1]] },
      { dayOfWeek: 0, hour: 13, minute: 0, activities: [keys[3]] },
      { dayOfWeek: 0, hour: 15, minute: 0, activities: [keys[0], keys[2]] },
    ],
  };
}

export function buildDemo(db, { pattern = demoPattern(), people = 12, reset = true } = {}) {
  migrate(db);

  // Running this twice used to seed everyone again — 12 names became 25 people, because seedPeople always
  // INSERTs and nothing checked. A demo builder that silently duplicates its own data is worse than one that
  // refuses, so by default it clears the people it created and starts clean.
  const existing = db.prepare("SELECT COUNT(*) n FROM people").get().n;
  if (existing > 0) {
    if (!reset) return { ok: false, reason: "already_populated", people: existing };
    // Order matters only in that assignments must lose their person before the person goes; the schema's
    // ON DELETE rules handle the rest.
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE assignments SET person_id = NULL").run();
      db.prepare("DELETE FROM notifications").run();
      db.prepare("DELETE FROM invitations").run();
      db.prepare("DELETE FROM people").run();
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  const { seasonId } = seedStructure(db, pattern);
  const keys = pattern.activities.map((a) => a.key);

  // Deterministic spread of capabilities — no randomness, so the demo looks the same every time and a
  // screenshot from one run matches the next.
  const ids = seedPeople(db, seasonId, NAMES.slice(0, people).map((name, i) => ({
    name,
    contact: `demo${i + 1}@example.invalid`,
    preferredRole: ["l", "f", "b"][i % 3],
    can: [keys[i % keys.length], keys[(i + 1) % keys.length]],
  })));
  const opened = openEverySession(db, seasonId);

  const dates = db.prepare("SELECT DISTINCT date FROM sessions WHERE season_id=? ORDER BY date").all(seasonId).map((r) => r.date);
  // Three deliberate shapes, because they are the states the screens must handle:
  //   - most people answer most dates
  //   - one person answers nothing at all (the nudge target, and an empty board)
  //   - one person is free all day but blocks a single hour (the override case)
  ids.forEach((id, i) => {
    if (i === people - 1) return;
    dates.forEach((date, d) => {
      if ((d + i) % 4 === 0) return;                       // some gaps, so the board is not uniformly full
      setAvailabilityDay(db, id, date, (d + i) % 7 !== 0); // and a few explicit "cannot"
    });
  });
  const blockedHour = db.prepare(`SELECT s.date, t.hour FROM sessions s JOIN timeslots t ON t.id=s.timeslot_id
                                  WHERE s.season_id=? ORDER BY s.date LIMIT 1`).get(seasonId);
  setAvailabilityDay(db, ids[0], blockedHour.date, true);
  setAvailabilityHour(db, ids[0], blockedHour.date, blockedHour.hour, false);

  // Fill roughly the first third of the season so the plan has history AND visible gaps.
  const open = db.prepare(`SELECT a.id, s.activity_id FROM assignments a JOIN sessions s ON s.id=a.session_id
                            WHERE a.person_id IS NULL AND s.season_id=? ORDER BY s.date`).all(seasonId);
  let filled = 0;
  for (const slot of open.slice(0, Math.floor(open.length / 3))) {
    for (const id of ids) {
      if (assignSlot(db, slot.id, id, { expectPersonId: null }).ok) { filled++; break; }
    }
  }

  // An admin who can actually sign in, plus a planner who is not an admin — the distinction the screens make.
  const admin = bootstrapAdmin(db, { email: "demo1@example.invalid", name: NAMES[0] });
  const plannerRole = db.prepare("SELECT id FROM roles WHERE name='planner'").get().id;
  const volunteerRole = db.prepare("SELECT id FROM roles WHERE name='volunteer'").get().id;
  db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(ids[1], plannerRole);
  for (const id of ids) db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(id, volunteerRole);

  return { seasonId, people: ids, opened, filled, adminPersonId: admin.personId, inviteToken: admin.inviteToken };
}

if (process.argv[1] && (await import("node:url")).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { writeFileSync } = await import("node:fs");
  const dbFile = process.env.FOURWATER_DB || "demo.db";
  const patternFile = process.env.FOURWATER_PATTERN || "demo-pattern.json";

  // The demo needs its own config file, not 4water's. The app reads the season KEY from config to find the
  // season in the database, so seeding one season while the server looks for another would leave every screen
  // empty — which is exactly the failure this replaces.
  const pattern = demoPattern();
  writeFileSync(patternFile, JSON.stringify(pattern, null, 2) + "\n", "utf8");

  const db = openDb(dbFile);
  const r = buildDemo(db, { pattern });
  const counts = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const today = new Date().toISOString().slice(0, 10);
  const ahead = db.prepare("SELECT COUNT(*) n FROM sessions WHERE date >= ?").get(today).n;

  // Counted from the data, not from how many rows an insert happened to create. Deriving "open" from the
  // insert delta printed "-38 open" on a second run, which is the sort of number that makes a reader distrust
  // everything else on the line.
  const openNow = db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NULL").get().n;
  const filledNow = db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id IS NOT NULL").get().n;
  console.log(`demo database ready: ${counts("people")} people, ${counts("sessions")} sessions, ${filledNow} filled, ${openNow} open`);
  console.log(`season ${pattern.season.key}: ${pattern.season.from} to ${pattern.season.to} — ${ahead} sessions from today onward`);
  console.log(`admin + planner: ${NAMES[0]} · planner only: ${NAMES[1]} · answered nothing: ${NAMES[11]}`);
  console.log(`\nStart it with the developer sign-in enabled:`);
  console.log(`  FOURWATER_AUTH=dev FOURWATER_DB=${dbFile} FOURWATER_PATTERN=${patternFile} FOURWATER_SECRET=<32+ chars> node src/server.mjs`);
  db.close();
}
