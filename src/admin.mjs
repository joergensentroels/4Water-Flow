// Administration: who is on the roster, who can do what, and the season's shape.
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import { validatePattern, PATTERN_FILE } from "./config.mjs";

// ---- people, roles, capabilities ----------------------------------------------------------------------
export function peopleWithDetail(db) {
  return db.prepare(`
    SELECT p.id, p.name, p.contact, p.status, p.auth_provider AS authProvider,
           (p.auth_subject IS NOT NULL) AS linked,
           (SELECT GROUP_CONCAT(r.name) FROM person_roles pr JOIN roles r ON r.id = pr.role_id WHERE pr.person_id = p.id) AS roles,
           (SELECT GROUP_CONCAT(a.key) FROM capabilities c JOIN activities a ON a.id = c.activity_id WHERE c.person_id = p.id) AS can
      FROM people p ORDER BY p.name
  `).all().map((r) => ({ ...r, roles: r.roles ? r.roles.split(",") : [], can: r.can ? r.can.split(",") : [] }));
}

export function setRole(db, personId, roleName, on) {
  const role = db.prepare("SELECT id FROM roles WHERE name = ?").get(roleName);
  if (!role) return { ok: false, reason: "no_such_role" };
  const person = db.prepare("SELECT id FROM people WHERE id = ?").get(personId);
  if (!person) return { ok: false, reason: "no_such_person" };

  if (on) {
    db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(personId, role.id);
    return { ok: true };
  }
  // Refuse to remove the LAST admin. An org that can lock itself out of its own admin screen has to be
  // rescued by whoever has shell access — exactly the single point of failure this project keeps removing.
  if (roleName === "admin") {
    const admins = db.prepare(`SELECT COUNT(*) n FROM person_roles pr JOIN roles r ON r.id = pr.role_id
                                JOIN people p ON p.id = pr.person_id
                                WHERE r.name='admin' AND p.status='active'`).get().n;
    if (admins <= 1) return { ok: false, reason: "last_admin" };
  }
  db.prepare("DELETE FROM person_roles WHERE person_id=? AND role_id=?").run(personId, role.id);
  return { ok: true };
}

export function setCapability(db, personId, activityKey, on) {
  const act = db.prepare("SELECT id FROM activities WHERE key = ?").get(activityKey);
  if (!act) return { ok: false, reason: "no_such_activity" };
  if (on) {
    db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) VALUES (?,?)").run(personId, act.id);
  } else {
    db.prepare("DELETE FROM capabilities WHERE person_id=? AND activity_id=?").run(personId, act.id);
    // Note what is deliberately NOT done: existing assignments are left alone. Removing a capability says
    // "do not give them more of these", not "erase the ones they already agreed to".
  }
  return { ok: true };
}

export function setPersonStatus(db, personId, status) {
  if (!["active", "inactive"].includes(status)) return { ok: false, reason: "bad_status" };
  db.prepare("UPDATE people SET status=? WHERE id=?").run(status, personId);
  return { ok: true };
}

export const invitesWithDetail = (db) =>
  db.prepare(`SELECT i.id, i.email, i.created_at AS createdAt, i.accepted_at AS acceptedAt, r.name AS role,
                     p.name AS personName
                FROM invitations i
                LEFT JOIN roles r ON r.id = i.role_id
                LEFT JOIN people p ON p.id = i.person_id
               ORDER BY i.id DESC LIMIT 50`).all();

// ---- the season's shape -------------------------------------------------------------------------------
// Validate BEFORE writing, then write atomically. A half-written pattern.json is an outage on next boot,
// and validating after the write means the bad file is already on disk.
export function savePattern(db, next, { file = PATTERN_FILE, seed } = {}) {
  let validated;
  try { validated = validatePattern(next); }
  catch (e) { return { ok: false, reason: "invalid", message: e.message }; }

  const json = JSON.stringify(validated, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, json, "utf8");
  renameSync(tmp, file);        // atomic on the same filesystem: readers see old or new, never half

  // Materialise the change: seedStructure is idempotent, so new activities and timeslots appear and new
  // sessions are generated. Nothing is DELETED — removing an activity from config stops new sessions being
  // created for it and leaves existing ones, because deleting sessions would destroy assignments people
  // have already agreed to.
  const seeded = seed ? seed(db, validated) : null;
  return { ok: true, pattern: validated, seeded };
}

export const readPatternFile = (file = PATTERN_FILE) => JSON.parse(readFileSync(file, "utf8"));

// Parse the season form. Kept separate from savePattern so a bad number is a validation message rather than
// a thrown exception from deep inside the writer.
export function patternFromForm(current, form) {
  const next = structuredClone(current);
  next.season = {
    key: String(form.seasonKey ?? current.season.key).trim(),
    from: String(form.seasonFrom ?? current.season.from).trim(),
    to: String(form.seasonTo ?? current.season.to).trim(),
  };
  if (form.cutoffDays != null && form.cutoffDays !== "") {
    next.board = { ...(next.board ?? {}), cutoffDays: Number(form.cutoffDays) };
  }
  return next;
}

// ---- the weekly rhythm --------------------------------------------------------------------------------
// Which days, which times, which activities in each slot. This was editable only by hand-editing
// config/pattern.json, which CONTRIBUTING names as the way a volunteer breaks the config — and it matters
// because the shipped pattern (one slot per day) was a placeholder, not a description of anything real.
export function addWeeklyToForm(current, { dayOfWeek, hour, minute, activities }) {
  const next = structuredClone(current);
  next.weekly = [...next.weekly, {
    dayOfWeek: Number(dayOfWeek),
    hour: Number(hour),
    minute: Number(minute ?? 0),
    // A slot with no activity is meaningless; validatePattern rejects it, which is where the message comes from.
    activities: (Array.isArray(activities) ? activities : [activities]).filter(Boolean),
  }];
  // Keep the list in the order a human reads a week, so the admin screen does not shuffle after every edit.
  next.weekly.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour || (a.minute ?? 0) - (b.minute ?? 0));
  return next;
}

// Removal is by value, not index: an index would silently target the wrong row if two admins edit at once.
export function removeWeeklyFromForm(current, { dayOfWeek, hour, minute }) {
  const next = structuredClone(current);
  const before = next.weekly.length;
  next.weekly = next.weekly.filter((w) =>
    !(w.dayOfWeek === Number(dayOfWeek) && w.hour === Number(hour) && (w.minute ?? 0) === Number(minute ?? 0)));
  return { pattern: next, removed: before - next.weekly.length };
}

// What removing a slot does NOT do: delete the sessions already generated for it. Same policy as removing an
// activity — "stop creating these", not "erase what volunteers already signed up for". The admin screen says so.
export const sessionsForSlot = (db, seasonId, { dayOfWeek, hour, minute }) =>
  db.prepare(`SELECT COUNT(*) n FROM sessions s JOIN timeslots t ON t.id = s.timeslot_id
               WHERE s.season_id = :sid AND t.day_of_week = :dow AND t.hour = :h AND t.minute = :m`)
    .get({ sid: seasonId, dow: Number(dayOfWeek), h: Number(hour), m: Number(minute ?? 0) }).n;

// ---- season rollover ----------------------------------------------------------------------------------
// The cutover plan in the spec is a clean break at a season boundary: the new season starts empty, and
// nothing is carried over except people, their capabilities and the weekly pattern — all of which live
// outside the season already, so "carrying them" is simply not deleting them.
//
// This PROPOSES the next season rather than creating it. The dates are computed, the key is guessed, and an
// admin confirms or corrects both before anything is written — because a key is a human label ("2026-Q3Q4")
// and no rule can reliably derive the next one. Editing dates by hand in JSON is how a volunteer breaks the
// config; a pre-filled form they approve is not.
export function proposeNextSeason(pattern) {
  const from = new Date(Date.parse(`${pattern.season.to}T00:00:00Z`) + 86400000);
  const lengthDays = Math.round(
    (Date.parse(`${pattern.season.to}T00:00:00Z`) - Date.parse(`${pattern.season.from}T00:00:00Z`)) / 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const halfYear = /Q1Q2|Q3Q4/.test(pattern.season.key);
  const half = from.getUTCMonth() < 6 ? "Q1Q2" : "Q3Q4";

  // For a half-year season, snap to the END OF THE HALF rather than reusing the day count. Copying the length
  // gave 2026-12-28 for a season that plainly means "the rest of the year", quietly dropping the last
  // sessions. Anything else keeps the same length, which is the only safe guess when the shape is unknown.
  const to = halfYear
    ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() < 6 ? 5 : 11, from.getUTCMonth() < 6 ? 30 : 31))
    : new Date(from.getTime() + lengthDays * 86400000);

  // Key suggestion: keep the shape of the current one where it is recognisable, otherwise fall back to the
  // dates, which are always unambiguous even if they are ugly.
  const key = halfYear ? `${from.getUTCFullYear()}-${half}` : `${iso(from)}--${iso(to)}`;

  return { key, from: iso(from), to: iso(to), lengthDays, snapped: halfYear };
}

export function addActivityToForm(current, { key, label, parent, subtype }) {
  const next = structuredClone(current);
  next.activities = [...next.activities, {
    key: String(key ?? "").trim().toLowerCase(),
    label: String(label ?? "").trim(),
    parent: String(parent ?? "").trim() || null,
    subtype: String(subtype ?? "").trim() || null,
    boothLabel: null,
    consolidation: null,
  }];
  return next;
}
