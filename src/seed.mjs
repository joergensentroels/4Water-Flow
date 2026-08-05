// Turning config/pattern.json into rows. Note what is NOT here: any activity name, any weekday name, any
// clock time. All of it arrives via `pattern`, so seeding another department means handing in another file.
import { migrate } from "./db.mjs";
import { loadPattern, roleSlotsFor } from "./config.mjs";
import { holidayConfig, suppressed } from "./holidays.mjs";

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
    let skipped = 0;
    // Public holidays, suppressed by DEFAULT. Nothing here decides which dates those are — see src/holidays.mjs
    // for the tables and for why suppression is the default direction. A planner who says classes run anyway adds
    // the date to `holidays.classesAnyway`, and this loop then treats it as an ordinary date.
    //
    // Read once, outside the loop: `suppressed()` is called for every day of a six-month season.
    const hol = holidayConfig(pattern);
    const first = fromDate && fromDate > pattern.season.from ? fromDate : pattern.season.from;
    for (const { iso, dow } of datesIn(first, pattern.season.to)) {
      if (suppressed(iso, hol)) { skipped++; continue; }
      for (const w of pattern.weekly) {
        if (w.dayOfWeek !== dow) continue;
        const slotId = findSlot.get(w.dayOfWeek, w.hour, w.minute ?? 0).id;
        for (const key of w.activities) {
          const r = insSession.run(seasonId, iso, slotId, findAct.get(key).id);
          sessions += r.changes;
        }
      }
    }
    // `skipped` counts DAYS not created, and it is reported rather than silent for the same reason every other
    // deletion in this project reports: a suppression nobody can see is indistinguishable from a seeding bug, and
    // this one removes classes from the plan.
    return { seasonId, sessions, skipped };
  };
  // One transaction: a half-seeded season is worse than an unseeded one, because it looks populated.
  db.exec("BEGIN");
  try { const out = tx(); db.exec("COMMIT"); return out; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

// Structure AND the open slots, in one call.
//
// This exists because the two steps were separate and PRODUCTION ONLY EVER MADE THE FIRST ONE. A fresh
// deployment seeded 102 sessions and zero assignments: the shift exchange had nothing to claim, the planner
// had nothing to assign, auto-roster had nothing to propose, and /status cheerfully reported "0 of 0 slots
// unfilled" — a working-looking app that could not do the one thing it exists for. The same hole was in the
// admin's config edit (add a Thursday class, get sessions with no slots) and in the season rollover.
//
// This is the SECOND time this class of defect shipped. The first fix added seedStructure to boot and stopped
// one step short of the rows that make a plan operable, and the test written to catch it asserted
// `sessions > 0` and never `assignments > 0` — structure, not usability. So the fix is not another reminder to
// call both: it is one function, so that calling half of it is no longer expressible.
export function seedSeason(db, pattern, { fromDate = null } = {}) {
  const { seasonId, sessions, skipped } = seedStructure(db, pattern, { fromDate });
  // Not scoped by fromDate on purpose: any session in this season that lacks its slots gets them, which also
  // repairs a database seeded by a version that created sessions and no assignments.
  const slots = openEverySession(db, seasonId, pattern);
  return { seasonId, sessions, slots, skipped };
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
  // Skipping is right, but skipping SILENTLY is not: sessions for an activity nobody defines any more are a
  // config edit somebody should know landed. Named at the end rather than per session, because a season has
  // dozens of each.
  const unknown = new Set();
  db.exec("BEGIN");
  try {
    for (const s of sessions) {
      // An activity the pattern no longer defines: leave its sessions EXACTLY as they are.
      //
      // Without this, `byKey.get` returns undefined and roleSlotsFor's "absent needs means one person, role
      // irrelevant" default invents a role-less slot for every such session. Measured: removing one activity from
      // config and rebooting created 51 phantom open slots across a season — including a third row on classes
      // whose leader and follower were both already filled and confirmed. The shift exchange then offers a slot on
      // a fully-staffed class, a volunteer can claim it, and the planner sees a gap that is not one.
      //
      // RUNBOOK says removal "stops new sessions being created for it and leaves existing ones alone, because
      // deleting sessions would destroy assignments volunteers have already agreed to". That was true of the
      // sessions and false of their slots. Reachable by editing config/pattern.json and restarting, which is the
      // only way to remove an activity — the admin screen can add one but not take one away.
      //
      // roleSlotsFor's own default is fine and stays: it is about `needs` being absent from a known activity. The
      // mistake was asking it about an activity that does not exist.
      const activity = byKey.get(s.key);
      if (!activity) { unknown.add(s.key); continue; }

      // Count how many of each role this session should have, then top up to that number.
      const wanted = new Map();
      for (const role of roleSlotsFor(activity)) wanted.set(role, (wanted.get(role) ?? 0) + 1);
      for (const [role, want] of wanted) {
        const already = have.get(`${s.id}:${role ?? ""}`) ?? 0;
        for (let i = already; i < want; i++) { insert.run(s.id, role); created++; }
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  if (unknown.size) {
    console.warn(`[seed] ${unknown.size} activity key(s) in this season are not in the config and were left ` +
                 `untouched: ${[...unknown].sort().join(", ")}`);
  }
  return created;
}
