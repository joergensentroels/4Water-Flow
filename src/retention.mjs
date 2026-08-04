// Deleting things on purpose. docs/PRIVACY.md admitted that nothing ever deleted anything, ever — which is
// both a GDPR gap and the reason `notifications` would grow forever with volunteers' names in it.
//
// Every function here REPORTS what it removed. A retention policy that deletes silently is indistinguishable
// from one that is broken, and the failure is invisible in exactly the direction that matters.

// A configured 0, a negative, or anything unparseable falls back to the DEFAULT rather than being honoured.
// Someone typing 0 has almost certainly made a mistake, and "keep zero seasons" would delete every record of
// who taught what — not an instruction to follow on the strength of a typo. Written out rather than leaning on
// `Number(x) || default`, where 0 silently becomes the default and any floor beside it is dead code.
const atLeastOne = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

export const retentionConfig = (pattern) => ({
  seasons: atLeastOne(pattern?.retention?.seasons, 2),
  notificationDays: atLeastOne(pattern?.retention?.notificationDays, 90),
});

// Notifications carry names ("Hi Volunteer One — please enter your availability"). They are operational
// records, useful for a few weeks to tell a broken webhook from a quiet period, and pointless after that.
export function pruneNotifications(db, { olderThanDays, now = new Date() }) {
  const cutoff = new Date(now.getTime() - olderThanDays * 86400000).toISOString();
  const doomed = db.prepare("SELECT COUNT(*) n FROM notifications WHERE created_at < ?").get(cutoff).n;
  db.prepare("DELETE FROM notifications WHERE created_at < ?").run(cutoff);
  return { removed: doomed, cutoff };
}

// Seasons beyond the newest `keep`. Ordered by from_date rather than id, because a season created later can
// cover an earlier period — an admin fixing a mistake should not change what counts as "old".
//
// ⚠ This is the destructive one: dropping a season takes its sessions, and therefore its assignments, with it
// via ON DELETE CASCADE. So it refuses to touch the CURRENT season whatever the count says.
export function pruneSeasons(db, { keep, currentKey = null }) {
  const all = db.prepare("SELECT id, key, from_date FROM seasons ORDER BY from_date DESC, id DESC").all();
  const doomed = all.slice(keep).filter((s) => s.key !== currentKey);
  if (doomed.length === 0) return { removed: [], keptCount: all.length };

  const counted = doomed.map((s) => ({
    key: s.key,
    sessions: db.prepare("SELECT COUNT(*) n FROM sessions WHERE season_id=?").get(s.id).n,
    assignments: db.prepare(`SELECT COUNT(*) n FROM assignments a JOIN sessions s ON s.id=a.session_id
                              WHERE s.season_id=?`).get(s.id).n,
  }));

  db.exec("BEGIN");
  try {
    for (const s of doomed) db.prepare("DELETE FROM seasons WHERE id=?").run(s.id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  // Availability rows are keyed by date, not by season, so cascade does not reach them. Sweep the ones that
  // no longer belong to any session — otherwise a deleted season leaves every volunteer's answers behind,
  // which is precisely the data the retention rule exists to remove.
  const orphaned = db.prepare(`SELECT COUNT(*) n FROM availability_day
                                WHERE date NOT IN (SELECT date FROM sessions)`).get().n
                 + db.prepare(`SELECT COUNT(*) n FROM availability_hour
                                WHERE date NOT IN (SELECT date FROM sessions)`).get().n;
  db.prepare("DELETE FROM availability_day WHERE date NOT IN (SELECT date FROM sessions)").run();
  db.prepare("DELETE FROM availability_hour WHERE date NOT IN (SELECT date FROM sessions)").run();

  return { removed: counted, keptCount: all.length - doomed.length, orphanedAvailability: orphaned };
}

export function runRetention(db, { pattern, currentKey, now = new Date() }) {
  const cfg = retentionConfig(pattern);
  const notes = pruneNotifications(db, { olderThanDays: cfg.notificationDays, now });
  const seasons = pruneSeasons(db, { keep: cfg.seasons, currentKey });
  return { config: cfg, notifications: notes, seasons };
}

// ---- erasure ------------------------------------------------------------------------------------------
// Two honest options, and the choice belongs to the organisation rather than to a schema default:
//
//   anonymise — the person is gone, the history is not. Who taught which session stays answerable, but the
//               name is replaced and every contact detail and login link is destroyed. This is usually what
//               a rota actually wants, and it is what "right to erasure" normally amounts to in practice
//               when the remaining record is no longer about an identifiable person.
//   remove    — the row goes, and CASCADE takes capabilities, availability and roles with it. Assignments
//               survive with a NULL person (ON DELETE SET NULL), so past sessions show as unfilled rather
//               than vanishing from the plan.
//
// Neither is offered as a default. The admin screen makes you pick, with the consequence written next to it.
export const ERASURE_MODES = ["anonymise", "remove"];

export function erasePerson(db, personId, { mode, now = new Date() }) {
  if (!ERASURE_MODES.includes(mode)) return { ok: false, reason: "bad_mode" };
  const person = db.prepare("SELECT id, name FROM people WHERE id=?").get(personId);
  if (!person) return { ok: false, reason: "no_such_person" };

  // The same guard as removing an admin role: an organisation must not be able to erase its way out of
  // having an administrator.
  const admins = db.prepare(`SELECT COUNT(*) n FROM person_roles pr JOIN roles r ON r.id=pr.role_id
                              JOIN people p ON p.id=pr.person_id
                             WHERE r.name='admin' AND p.status='active'`).get().n;
  const isAdmin = db.prepare(`SELECT 1 FROM person_roles pr JOIN roles r ON r.id=pr.role_id
                               WHERE pr.person_id=? AND r.name='admin'`).get(personId);
  if (isAdmin && admins <= 1) return { ok: false, reason: "last_admin" };

  const before = {
    assignments: db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id=?").get(personId).n,
    availability: db.prepare("SELECT COUNT(*) n FROM availability_day WHERE person_id=?").get(personId).n
                + db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(personId).n,
  };

  db.exec("BEGIN");
  try {
    if (mode === "anonymise") {
      // A stable, obviously-not-a-name label. Keyed on the id so two erased people stay distinguishable in
      // the history without either being identifiable.
      db.prepare(`UPDATE people SET name = ?, contact = NULL, preferred_role = NULL, status = 'inactive',
                                     auth_provider = 'erased', auth_subject = NULL
                   WHERE id = ?`).run(`#${personId}`, personId);
      db.prepare("DELETE FROM availability_day WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM availability_hour WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM person_roles WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM capabilities WHERE person_id=?").run(personId);
      db.prepare("UPDATE invitations SET email='erased', person_id=NULL WHERE person_id=?").run(personId);
    } else {
      db.prepare("UPDATE invitations SET email='erased', person_id=NULL WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM people WHERE id=?").run(personId);
    }
    // Messages about them mention them by name.
    db.prepare("DELETE FROM notifications WHERE person_id=?").run(personId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  const after = db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id=?").get(personId).n;
  return { ok: true, mode, was: person.name, availabilityRemoved: before.availability,
           assignmentsBefore: before.assignments, assignmentsStillLinked: after };
}

// ---- export -------------------------------------------------------------------------------------------
// Everything held about one person, for an access or portability request. Assembled from the tables rather
// than a stored blob, so it cannot drift out of date with what is actually stored.
export function exportPerson(db, personId) {
  const person = db.prepare(`SELECT id, name, contact, preferred_role AS preferredRole, status,
                                    auth_provider AS authProvider
                               FROM people WHERE id=?`).get(personId);
  if (!person) return null;
  const q = (sql) => db.prepare(sql).all(personId);
  return {
    exportedAt: null,      // stamped by the caller: this module takes no clock so its output is comparable
    person,
    roles: q("SELECT r.name FROM person_roles pr JOIN roles r ON r.id=pr.role_id WHERE pr.person_id=?").map((r) => r.name),
    capabilities: q("SELECT a.key, a.label FROM capabilities c JOIN activities a ON a.id=c.activity_id WHERE c.person_id=?"),
    availabilityByDay: q("SELECT date, available FROM availability_day WHERE person_id=? ORDER BY date"),
    availabilityByHour: q("SELECT date, hour, available FROM availability_hour WHERE person_id=? ORDER BY date, hour"),
    assignments: q(`SELECT s.date, t.hour, t.minute, act.key AS activity, a.state
                      FROM assignments a JOIN sessions s ON s.id=a.session_id
                      JOIN timeslots t ON t.id=s.timeslot_id JOIN activities act ON act.id=s.activity_id
                     WHERE a.person_id=? ORDER BY s.date, t.hour`),
    messagesAboutYou: q("SELECT created_at AS at, kind, body, status FROM notifications WHERE person_id=? ORDER BY id"),
  };
}

// A season as CSV, for planners who want it in a spreadsheet — which, given where this app came from, is a
// request that will absolutely be made.
export function exportSeasonCsv(db, seasonId) {
  const rows = db.prepare(`
    SELECT s.date, t.hour, t.minute, act.key AS activity, act.label,
           COALESCE(p.name, '') AS person, a.state
      FROM sessions s
      JOIN timeslots t ON t.id = s.timeslot_id
      JOIN activities act ON act.id = s.activity_id
      LEFT JOIN assignments a ON a.session_id = s.id
      LEFT JOIN people p ON p.id = a.person_id
     WHERE s.season_id = ?
     ORDER BY s.date, t.hour, t.minute, act.key`).all(seasonId);

  // Quote every field and double internal quotes. A volunteer called O'Brien, or an activity label with a
  // comma in it, must not shift every later column by one.
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["date", "time", "activity_key", "activity", "person", "state"];
  const lines = [header.map(esc).join(",")];
  for (const r of rows) {
    lines.push([r.date, `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
                r.activity, r.label, r.person, r.state ?? ""].map(esc).join(","));
  }
  return lines.join("\r\n") + "\r\n";   // CRLF: what spreadsheets expect from a .csv
}
