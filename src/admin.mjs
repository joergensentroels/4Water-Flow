// Administration: who is on the roster, who can do what, and the season's shape.
import { writeFileSync, renameSync } from "node:fs";
import { validatePattern, PATTERN_FILE } from "./config.mjs";
import { holidayConfig, suppressed } from "./holidays.mjs";

// ---- people, roles, capabilities ----------------------------------------------------------------------
// Searchable and capped by default, because the editor per person is large and the roster is not.
//
// Measured at the size the multi-department plan implies — 200 volunteers, roughly what Lyon was described as
// bringing — this screen rendered 953 KB. Each person carries twelve small forms (three roles, six
// capabilities, status, export, two erase modes), every one with its own CSRF token, so 200 people is about
// 2,400 forms. Exactly the defect already fixed on the planner, where the whole-season view was 534 KB and a
// four-week default brought it to 84 KB — and unlooked-at here, on a screen whose whole point is being usable
// from a phone.
//
// The distinction that matters: the planner's big view is an OPT-IN, chosen by clicking "the whole season".
// This was the default. And searching is what an admin wants at 200 people anyway; scrolling 200 cards is bad
// regardless of bytes.
export const PEOPLE_PAGE = 25;

export function peopleWithDetail(db, { q = "", limit = PEOPLE_PAGE } = {}) {
  const term = String(q ?? "").trim();
  const all = limit === "all";
  const total = db.prepare("SELECT COUNT(*) n FROM people").get().n;
  const matching = term
    ? db.prepare("SELECT COUNT(*) n FROM people WHERE name LIKE :like OR COALESCE(contact,'') LIKE :like").get({ like: `%${term}%` }).n
    : total;

  const rows = db.prepare(`
    SELECT p.id, p.name, p.contact, p.status, p.auth_provider AS authProvider,
           (p.auth_subject IS NOT NULL) AS linked,
           (SELECT GROUP_CONCAT(r.name) FROM person_roles pr JOIN roles r ON r.id = pr.role_id WHERE pr.person_id = p.id) AS roles,
           (SELECT GROUP_CONCAT(a.key) FROM capabilities c JOIN activities a ON a.id = c.activity_id WHERE c.person_id = p.id) AS can
      FROM people p
     ${term ? "WHERE p.name LIKE :like OR COALESCE(p.contact,'') LIKE :like" : ""}
     ORDER BY p.name
     ${all ? "" : "LIMIT :lim"}
  `).all({
    ...(term ? { like: `%${term}%` } : {}),
    ...(all ? {} : { lim: Number(limit) > 0 ? Number(limit) : PEOPLE_PAGE }),
  }).map((r) => ({ ...r, roles: r.roles ? r.roles.split(",") : [], can: r.can ? r.can.split(",") : [] }));

  // shown, matching and total are three different numbers, and the page says all three. A list that quietly
  // stops at 25 of 200 reads as "that is everybody" — the same silent-truncation problem as the outbox.
  return { rows, shown: rows.length, matching, total, q: term, limit: all ? "all" : Number(limit) || PEOPLE_PAGE };
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
    // Only refuse if THIS person is one of the admins being counted. The tally alone is not enough: it counts
    // active admins, so with one active admin plus a former one marked inactive it reads 1 and refused to strip
    // the stale role from the inactive person — a role that still grants full access, since inactive revokes
    // neither sign-in nor privileges. It refused the very tidy-up that would have made the situation safe.
    // Measured, together with the identical asymmetry in erasePerson.
    const targetIsActiveAdmin = db.prepare(`SELECT 1 FROM person_roles pr JOIN roles r ON r.id = pr.role_id
                                             JOIN people p ON p.id = pr.person_id
                                            WHERE pr.person_id=? AND r.name='admin' AND p.status='active'`)
      .get(personId);
    if (targetIsActiveAdmin && admins <= 1) return { ok: false, reason: "last_admin" };
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

// Going inactive RELEASES the shifts they had not yet done. The note above about capabilities — "do not give them
// more of these, not erase the ones they already agreed to" — is right for a capability and wrong here, and this
// function inherited it from next door. Removing a capability does not say the person is gone. This does, and
// every consumer of the roster already agrees: eligibility, the claim guard, auto-roster and both notification
// jobs all filter on status='active'.
//
// So a held future shift was covered by nobody and looked covered by somebody. Measured on a season with 51 held:
// after deactivation they still held all 51, no slot opened, the vagtbørs offered them to nobody, auto-roster
// could not re-fill them, and the shift reminder found 0 of them due — verified against the same query with the
// person active again, which found theirs. The planner grid still printed their name beside every one. A gap that
// reads as filled is worse than a gap, because nobody chases it.
//
// PAST assignments stay. That is history, and it is true: they did run those. The count comes back so the caller
// can say what happened rather than reporting a bare "saved" over fifty released shifts — the same reason
// `erasePerson` returns its counts.
export function setPersonStatus(db, personId, status, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!["active", "inactive"].includes(status)) return { ok: false, reason: "bad_status" };
  db.prepare("UPDATE people SET status=? WHERE id=?").run(status, personId);
  const released = status === "inactive" ? releaseFutureShifts(db, personId, today) : 0;
  return { ok: true, released };
}

// Frees the assignments a person holds from `today` onward, leaving earlier ones as the record of what they did.
// Shared with erasure so the two cannot drift: an anonymised person and a deactivated one are equally gone, and
// the app should not hold shifts for either.
// `state` returns to 'confirmed', the neutral default, exactly as discardProposals does — its comment gives the
// reason: state only carries meaning while somebody occupies the row. Leaving a released row 'proposed' would put
// it in countProposals' way, and 'open' is not a value the CHECK constraint allows.
export function releaseFutureShifts(db, personId, today) {
  return db.prepare(`UPDATE assignments SET person_id = NULL, state = 'confirmed'
                      WHERE person_id = :pid
                        AND session_id IN (SELECT id FROM sessions WHERE date >= :today)`)
    .run({ pid: personId, today }).changes;
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

// `readPatternFile` used to live here, exported and called by nothing — and it was the function whose absence
// caused the defect above: reading the file is exactly what the admin forms needed to do instead of cloning the
// process's in-memory copy. A hook that looks wired and is not, sitting next to the problem it would have solved.
//
// Removed rather than wired up, because it also bypassed `readJson`: it called `JSON.parse(readFileSync(...))`
// directly, so it stripped no byte-order mark and named no file on failure. Anybody reaching for it in good faith
// would have reintroduced the boot crash that a config saved in Notepad now survives. `loadPattern(file)` is the
// one way in, it validates, and server.mjs's `baseForEdit()` is what the admin routes use.

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

// ---- public holidays ---------------------------------------------------------------------------------------
// The planner's opt-back-in, one date at a time, in both directions. By VALUE for the same reason
// removeWeeklyFromForm is: an index would target the wrong row when two people edit at once, and the wrong row
// here is somebody's class.
//
// Returns `changed` so the route can tell "already in that state" from "done". A toggle reporting success over a
// no-op is how somebody concludes a button works when it does not.
// BOTH LISTS, and until this handled `extra` the "no classes" direction was a lie on any ordinary date.
//
// `classesAnyway` is the opt-back-IN and it had a screen. `holidays.extra` — the config's own comment calls it
// "days 4water is closed but the country is not" — is the opt-OUT, and it had none: adding one meant hand-editing
// pattern.json, which CONTRIBUTING names as the way a volunteer breaks the config. That is the exact argument the
// weekly-rhythm editor was built on, and the comment stating it sits ten lines above a capability that never got
// the same treatment. One direction had a button and its opposite did not.
//
// What that cost, measured: POST /admin/holiday with on=0 on a date the country table does not name deleted the
// sessions, `applyPattern` immediately re-created them because nothing in the config said the date was suppressed,
// and the route reported "that date is a holiday again, and its sessions have been removed" — writing an audit
// entry that said so. Session ids 1,2 became 99,100 and the classes were still scheduled. The message, the redirect
// code and the audit record were all false, because a suppression with nowhere to persist cannot survive a re-seed.
//
// Not reachable through the old screen, which only ever offered dates from the country table — so it was latent
// rather than live. The fix is the same either way: a suppression has to be written down somewhere the seeder reads.
// It asks the TABLE question itself rather than taking it as an argument. The first version had the route pass a
// `suppressedByTable` flag computed from the same config object being handed in — so a caller that forgot it got
// different semantics silently, and the existing unit test became the caller that forgot. The function has the
// config; it can answer its own question, and then there is no way to call it inconsistently.
export function setClassesAnyway(current, date, on) {
  const next = structuredClone(current);
  // Does something OTHER than the planner's own opt-in already account for this date? Asked with both editable
  // lists emptied: suppressed() short-circuits on classesAnyway by design, and `extra` is decided below.
  const cfg = holidayConfig(current);
  const suppressedByTable = suppressed(date, { ...cfg, classesAnyway: [], extra: [] }) !== null;
  const anyway = Array.isArray(next.holidays?.classesAnyway) ? [...next.holidays.classesAnyway] : [];
  const extra = Array.isArray(next.holidays?.extra) ? [...next.holidays.extra] : [];
  const wasAnyway = anyway.includes(date);
  const wasExtra = extra.includes(date);
  // Was this date going to have classes before the edit? Only if it is neither in the board's own closing list nor
  // named by the country table — unless the planner had already opted it back in.
  const hadClasses = wasAnyway || !(wasExtra || suppressedByTable);

  let nextAnyway = anyway, nextExtra = extra;
  if (on) {
    // Classes run after all. Removing the date from the board's own list is the honest inverse of adding it; only a
    // date the COUNTRY suppresses needs an opt-in recorded, because that list is not ours to edit.
    if (wasExtra) nextExtra = extra.filter((d) => d !== date);
    else if (!wasAnyway) nextAnyway = [...anyway, date].sort();
  } else {
    // No classes. Drop any opt-in, and record the closure unless a table already accounts for it — writing a date
    // into `extra` that the country table already names would be a duplicate the admin screen shows once.
    nextAnyway = anyway.filter((d) => d !== date);
    if (!suppressedByTable && !wasExtra) nextExtra = [...extra, date].sort();
  }

  next.holidays = { ...(next.holidays ?? {}), classesAnyway: nextAnyway, extra: nextExtra };
  return { pattern: next, changed: hadClasses !== on };
}

// What is on a date, and who is on it. Asked before removing anything: turning a holiday back OFF deletes the
// sessions that were created for it, and deleting a session takes its assignments — so the route refuses when a
// person is on one, rather than quietly cancelling on somebody who had agreed to teach.
export function sessionsOnDate(db, seasonId, date) {
  const rows = db.prepare(`
    SELECT s.id, COUNT(a.id) AS slots, SUM(CASE WHEN a.person_id IS NOT NULL THEN 1 ELSE 0 END) AS taken
      FROM sessions s LEFT JOIN assignments a ON a.session_id = s.id
     WHERE s.season_id = :sid AND s.date = :date
     GROUP BY s.id`).all({ sid: seasonId, date });
  return {
    sessions: rows.length,
    slots: rows.reduce((n, r) => n + r.slots, 0),
    taken: rows.reduce((n, r) => n + (r.taken ?? 0), 0),
    ids: rows.map((r) => r.id),
  };
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
