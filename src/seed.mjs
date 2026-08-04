// Turning config/pattern.json into rows. Note what is NOT here: any activity name, any weekday name, any
// clock time. All of it arrives via `pattern`, so seeding another department means handing in another file.
import { migrate } from "./db.mjs";
import { loadPattern, roleSlotsFor } from "./config.mjs";

// Walk the season day by day in UTC. getUTCDay() rather than getDay() on purpose — an ISO date string parses
// as UTC midnight, so the local-time accessor can report the previous day west of Greenwich and silently
// shift every Sunday session to Saturday.
function* datesIn(from, to) {
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const d = new Date(t);
    yield { iso: d.toISOString().slice(0, 10), dow: d.getUTCDay() };
  }
}

// Just the permission roles, and nothing else.
//
// This exists because bootstrapAdmin called seedStructure to "guarantee the roles exist" — and seedStructure
// also creates a season, its activities, its timeslots and every session in it, from whichever pattern file
// loadPattern() happens to find. The visible symptom was a demo database holding 4water's real 2026-Q1Q2 season
// beside the demo one, 99 of whose sessions had no slots because openEverySession was scoped to the demo season.
// The latent one is worse: tools/bootstrap.mjs is the documented way to create the first admin on a LIVE
// system, so a stale or wrong pattern file would have written a phantom season into production.
export function seedRoles(db, roles) {
  const ins = db.prepare("INSERT OR IGNORE INTO roles (name) VALUES (?)");
  let created = 0;
  for (const r of roles) created += ins.run(r).changes;
  return created;
}

// `fromDate` limits session creation to that date onward. Boot and rollover want the whole season; an admin
// adding a timeslot in August does NOT want sessions manufactured back to January, which would fill the plan
// with unfilled historical slots nobody can do anything about.
export function seedStructure(db, pattern, { fromDate = null } = {}) {
  migrate(db);
  const tx = () => {
    db.prepare("INSERT OR IGNORE INTO seasons (key, from_date, to_date) VALUES (?,?,?)")
      .run(pattern.season.key, pattern.season.from, pattern.season.to);
    const seasonId = db.prepare("SELECT id FROM seasons WHERE key = ?").get(pattern.season.key).id;

    seedRoles(db, pattern.roles);   // one definition, so the two callers cannot drift apart

    const act = db.prepare(`INSERT INTO activities (key,parent,subtype,label,booth_label,consolidation)
                            VALUES (?,?,?,?,?,?)
                            ON CONFLICT (key) DO UPDATE SET
                              parent=excluded.parent, subtype=excluded.subtype, label=excluded.label,
                              booth_label=excluded.booth_label, consolidation=excluded.consolidation`);
    for (const a of pattern.activities) act.run(a.key, a.parent, a.subtype, a.label, a.boothLabel, a.consolidation);

    const slot = db.prepare("INSERT OR IGNORE INTO timeslots (day_of_week,hour,minute) VALUES (?,?,?)");
    for (const w of pattern.weekly) slot.run(w.dayOfWeek, w.hour, w.minute ?? 0);

    // One session per (date, timeslot, activity) across the whole season.
    const findSlot = db.prepare("SELECT id FROM timeslots WHERE day_of_week=? AND hour=? AND minute=?");
    const findAct = db.prepare("SELECT id FROM activities WHERE key=?");
    const insSession = db.prepare("INSERT OR IGNORE INTO sessions (season_id,date,timeslot_id,activity_id) VALUES (?,?,?,?)");
    let sessions = 0;
    const first = fromDate && fromDate > pattern.season.from ? fromDate : pattern.season.from;
    for (const { iso, dow } of datesIn(first, pattern.season.to)) {
      for (const w of pattern.weekly) {
        if (w.dayOfWeek !== dow) continue;
        const slotId = findSlot.get(w.dayOfWeek, w.hour, w.minute ?? 0).id;
        for (const key of w.activities) {
          const r = insSession.run(seasonId, iso, slotId, findAct.get(key).id);
          sessions += r.changes;
        }
      }
    }
    return { seasonId, sessions };
  };
  // One transaction: a half-seeded season is worse than an unseeded one, because it looks populated.
  db.exec("BEGIN");
  try { const out = tx(); db.exec("COMMIT"); return out; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

// Demo people + capabilities + one empty assignment per session, so there is an actual vagtbørs to look at.
// `names` is passed in; this function invents no one.
export function seedPeople(db, seasonId, people) {
  const insP = db.prepare("INSERT INTO people (name, contact, preferred_role, auth_provider, auth_subject) VALUES (?,?,?,?,?)");
  const insC = db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) VALUES (?, (SELECT id FROM activities WHERE key=?))");
  const ids = [];
  db.exec("BEGIN");
  try {
    for (const p of people) {
      const r = insP.run(p.name, p.contact ?? null, p.preferredRole ?? "b", p.authProvider ?? "oidc", p.authSubject ?? null);
      const id = Number(r.lastInsertRowid);
      ids.push(id);
      for (const k of p.can ?? []) insC.run(id, k);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return ids;
}

// Every session gets one open assignment row — person_id NULL. This is the vagtbørs' initial state: the
// whole season is "open" until someone claims or a planner assigns.
// One open row PER ROLE the session's activity requires: a partner-dance class needs a leader and a follower,
// so it gets two; a workshop gets one row with no role.
//
// Idempotency is per (session, role, ordinal) rather than "does this session have any assignment at all".
// The old check was the latter, which would have created the leader row and then never created the follower —
// a session permanently half-staffed with nothing to show why.
export function openEverySession(db, seasonId, pattern = null) {
  const cfg = pattern ?? loadPattern();
  const byKey = new Map(cfg.activities.map((a) => [a.key, a]));
  const sessions = db.prepare(`
    SELECT s.id, act.key FROM sessions s JOIN activities act ON act.id = s.activity_id
     WHERE s.season_id = ?`).all(seasonId);

  const existing = db.prepare(`
    SELECT session_id AS sid, role, COUNT(*) AS n FROM assignments
     WHERE session_id IN (SELECT id FROM sessions WHERE season_id = ?)
     GROUP BY session_id, role`).all(seasonId);
  const have = new Map(existing.map((r) => [`${r.sid}:${r.role ?? ""}`, r.n]));

  const insert = db.prepare("INSERT INTO assignments (session_id, person_id, role, state) VALUES (?, NULL, ?, 'confirmed')");
  let created = 0;
  db.exec("BEGIN");
  try {
    for (const s of sessions) {
      // Count how many of each role this session should have, then top up to that number.
      const wanted = new Map();
      for (const role of roleSlotsFor(byKey.get(s.key))) wanted.set(role, (wanted.get(role) ?? 0) + 1);
      for (const [role, want] of wanted) {
        const already = have.get(`${s.id}:${role ?? ""}`) ?? 0;
        for (let i = already; i < want; i++) { insert.run(s.id, role); created++; }
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return created;
}
