import { releaseFutureShifts } from "./admin.mjs";
import { pseudonymiseAuditActor, scrubAuditDetail } from "./audit.mjs";
import { deleteNotesBy } from "./notes.mjs";

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
  // The audit trail's own window, and it is deliberately much longer than the notification one. A notification is
  // operational — useful for weeks, to tell a broken webhook from a quiet period. An audit answers "who changed
  // this" a season or two later, when somebody asks why a volunteer was stood down, so a 90-day window would
  // throw away exactly the rows worth keeping. Two years by default, which outlives the season retention above
  // and can be shortened by a board that would rather hold less.
  auditDays: atLeastOne(pattern?.retention?.auditDays, 730),
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

  // Sweep what this cascade just orphaned. The same sweep also runs unconditionally from runRetention, for the reason
  // written on pruneOrphanedAvailability below — a season being dropped is not the only way a date loses its sessions.
  const orphaned = pruneOrphanedAvailability(db).removed;

  return { removed: counted, keptCount: all.length - doomed.length, orphanedAvailability: orphaned };
}

// Availability rows are keyed by DATE, not by season, so no foreign key reaches them: delete the sessions on a date
// and every volunteer's answer for that date stays behind, personal data with nothing left to justify it.
//
// This used to be six lines inside pruneSeasons, BELOW its `if (doomed.length === 0) return` — so it ran only when a
// season was dropped in the same call. Since the default is to keep two seasons and an association normally has two,
// the steady state drops nothing, and in the steady state the sweep never ran at all.
//
// It is reachable in two ordinary clicks, which is what makes it worth fixing rather than noting: volunteers answer
// availability for a date, an admin marks that date as a holiday with no classes, and `DELETE FROM sessions WHERE
// season_id=? AND date=?` in the holiday route takes the sessions. Measured: with two seasons and keep=2 the answers
// survive a retention run ten years later; with four seasons they are swept. Same data, same code, different day.
//
// The test that covered the sweep created a droppable season in its own setup, so it exercised the only path on which
// the sweep could run. A check whose fixture only reaches the working case cannot report the broken one.
//
// Dates are not filtered to the past. An orphaned FUTURE date could in principle become live again — an admin who
// cancels 24 December and then changes their mind re-seeds the sessions — and that volunteer would have to answer
// again. That is the right trade: while the sessions are gone the answer is unreachable from every screen in the app,
// because availability is rendered from sessions, so keeping it stores personal data nobody can see or use.
export function pruneOrphanedAvailability(db) {
  const orphan = "date NOT IN (SELECT date FROM sessions)";
  const removed = db.prepare(`SELECT COUNT(*) n FROM availability_day WHERE ${orphan}`).get().n
                + db.prepare(`SELECT COUNT(*) n FROM availability_hour WHERE ${orphan}`).get().n;
  db.prepare(`DELETE FROM availability_day WHERE ${orphan}`).run();
  db.prepare(`DELETE FROM availability_hour WHERE ${orphan}`).run();
  return { removed };
}

// Spent and dead invitations. Found by asking where else an unbounded thing was hiding after two list-size
// defects — and this one is worse than a big page: invitations.email is a personal email address, docs/PRIVACY.md
// lists it as stored personal data, and NOTHING has ever deleted one. Increment N built retention for
// notifications and seasons and did not touch this table, so an invite sent to somebody who never joined leaves
// their address in the database permanently, with no lawful basis for keeping it.
//
// Two cases, both genuinely dead:
//   - ACCEPTED: the person record is now the record of truth, and the invitation table does not store who
//     issued it, so there is no audit value left in the row. Revoked invitations land here too — revokeInvite
//     stamps accepted_at with the epoch as a sentinel, which makes them immediately older than any cutoff, and
//     that is right: a revoked invite is dead the moment it is revoked.
//   - UNACCEPTED and past the redemption window: it can never be redeemed again, so it is an email address and
//     nothing else. Given a grace period beyond expiry so an admin can still see a recent one on the screen.
export function pruneInvitations(db, { olderThanDays = 90, ttlDays = 14, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanDays * 86400000).toISOString();
  const deadCutoff = new Date(now.getTime() - (olderThanDays + ttlDays) * 86400000).toISOString();

  const spent = db.prepare("DELETE FROM invitations WHERE accepted_at IS NOT NULL AND accepted_at < ?").run(cutoff).changes;
  const expired = db.prepare("DELETE FROM invitations WHERE accepted_at IS NULL AND created_at < ?").run(deadCutoff).changes;
  return { removed: spent + expired, spent, expired, cutoff, deadCutoff };
}

export function runRetention(db, { pattern, currentKey, now = new Date() }) {
  const cfg = retentionConfig(pattern);
  const notes = pruneNotifications(db, { olderThanDays: cfg.notificationDays, now });
  const invites = pruneInvitations(db, { olderThanDays: cfg.notificationDays, now });
  const seasons = pruneSeasons(db, { keep: cfg.seasons, currentKey });
  const audit = pruneAudit(db, { olderThanDays: cfg.auditDays, now });
  // Unconditionally, and after the cascade above rather than before it: whatever pruneSeasons orphaned is already
  // gone by now, so this call is a no-op in that case and the whole point of it is the case where pruneSeasons
  // dropped nothing. A holiday cancellation orphans availability on a day no season is due to expire.
  const availability = pruneOrphanedAvailability(db);
  return { config: cfg, notifications: notes, invitations: invites, seasons, audit, availability };
}

// The audit trail holds names, so it cannot be kept forever without a reason — and it cannot be dropped after a
// few weeks either, because the questions it answers arrive late. Reported like everything else here: a retention
// step that deletes silently is indistinguishable from one that is broken.
export function pruneAudit(db, { olderThanDays, now = new Date() }) {
  const cutoff = new Date(now.getTime() - olderThanDays * 86400000).toISOString();
  const doomed = db.prepare("SELECT COUNT(*) n FROM audit WHERE at < ?").get(cutoff).n;
  db.prepare("DELETE FROM audit WHERE at < ?").run(cutoff);
  return { removed: doomed, cutoff };
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

export function erasePerson(db, personId, { mode, now = new Date(), today = now.toISOString().slice(0, 10) }) {
  if (!ERASURE_MODES.includes(mode)) return { ok: false, reason: "bad_mode" };
  let released = 0;
  let auditRenamed = 0;
  let auditScrubbed = 0;
  let notesRemoved = 0;
  let notificationsRemoved = 0;
  // `contact` is read here, before anything is deleted, because the audit sweep below needs the address and both
  // modes destroy it — anonymise nulls the column, remove takes the row.
  const person = db.prepare("SELECT id, name, contact FROM people WHERE id=?").get(personId);
  if (!person) return { ok: false, reason: "no_such_person" };

  // The same guard as removing an admin role: an organisation must not be able to erase its way out of having
  // an administrator.
  //
  // Both halves count the same thing, which they did not used to. The tally was of ACTIVE admins and the
  // "is this person one" test had no status filter, so the two disagreed about anybody inactive — and the
  // asymmetry refused a request it had no reason to refuse. Measured: one active admin plus a former admin
  // marked inactive (which is the documented way to handle somebody leaving, and leaves their role row in
  // place) gave a tally of 1, an `isAdmin` of true, and `{ ok: false, reason: "last_admin" }` for the former
  // admin's own erasure request. Nothing was at risk of lockout; the app refused a right-to-erasure request and
  // gave a reason that was not true. A guard that fails closed is not automatically a safe guard when what it
  // closes is somebody's GDPR request.
  const admins = db.prepare(`SELECT COUNT(*) n FROM person_roles pr JOIN roles r ON r.id=pr.role_id
                              JOIN people p ON p.id=pr.person_id
                             WHERE r.name='admin' AND p.status='active'`).get().n;
  const isActiveAdmin = db.prepare(`SELECT 1 FROM person_roles pr JOIN roles r ON r.id=pr.role_id
                                     JOIN people p ON p.id=pr.person_id
                                    WHERE pr.person_id=? AND r.name='admin' AND p.status='active'`).get(personId);
  if (isActiveAdmin && admins <= 1) return { ok: false, reason: "last_admin" };

  const before = {
    assignments: db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id=?").get(personId).n,
    availability: db.prepare("SELECT COUNT(*) n FROM availability_day WHERE person_id=?").get(personId).n
                + db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(personId).n,
  };

  db.exec("BEGIN");
  try {
    // ⚠ EVERYTHING KEYED ON THE PERSON'S ID HAPPENS FIRST, while the id still resolves to them.
    //
    // These four ran AFTER the mode branch, and under `remove` that made three of them do nothing at all. The
    // people row is deleted there, `PRAGMA foreign_keys = ON` is set in db.mjs, and every one of these tables
    // declares `person_id ... ON DELETE SET NULL` — so by the time the sweeps ran, no row matched the id any more
    // and a hard erasure left behind:
    //
    //   - the person's NAME in `audit.actor_name`, because pseudonymiseAuditActor matches on actor_id;
    //   - their own notes, free text and all;
    //   - notification bodies, which the schema comment says carry names ("Hi Volunteer One — ...").
    //
    // Measured, not deduced: an erasure with mode=remove reported `auditRenamed: 0` and the row still read the
    // person's full name. The comment that used to sit here reasoned about this exact mechanism — "under `remove`
    // the people row is gone by now and the foreign key has set actor_id to NULL" — and drew the opposite
    // conclusion from it, treating the nulled id as the REASON to pseudonymise rather than as what made
    // pseudonymising impossible. Prose can describe a mechanism correctly and still miss what follows.
    //
    // It went unnoticed because the test that covered both modes never ran this one: the fixture had a single
    // admin, so `remove` hit the last-admin guard and `continue`d. A skipped branch inside a loop, passing as
    // coverage.
    //
    // Messages about somebody mention them by name, so they go outright.
    notificationsRemoved = db.prepare("DELETE FROM notifications WHERE person_id=?").run(personId).changes;
    // Their own notes go ENTIRELY, and the asymmetry with the audit trail is the point. An audit row is a record OF
    // an action, and keeping it under a #id label still answers "who did this". A note is the person's own sentence,
    // and there is no version of it with the person taken out — so over free text the right to erasure is only
    // satisfiable by deleting the text. What this cannot reach is their name inside somebody ELSE's note;
    // docs/PRIVACY.md says so plainly rather than implying a completeness that is not available.
    notesRemoved = deleteNotesBy(db, personId);
    // The audit keeps its rows and loses the human: pseudonymising rather than deleting is the whole bargain — the
    // log keeps its answer to "who", erasure takes away "which human", and neither gives up what it exists for.
    auditRenamed = pseudonymiseAuditActor(db, personId);
    // And their address out of the details, which the line above does not touch: one action used to write an email
    // address into `detail`, and nothing reached it. Both modes, for the same reason as the actor rename.
    auditScrubbed = scrubAuditDetail(db, personId, person.contact);

    if (mode === "anonymise") {
      // A stable, obviously-not-a-name label. Keyed on the id so two erased people stay distinguishable in
      // the history without either being identifiable.
      // calendar_token_hash goes too. The feed would already stop serving, because resolving a token filters on
      // status='active' and this row becomes inactive — but that is a filter in another module doing an
      // erasure's job. A right-to-erasure that leaves a live credential in the database because something
      // elsewhere currently declines to honour it is exactly the kind of safe-by-coincidence this keeps finding.
      db.prepare(`UPDATE people SET name = ?, contact = NULL, preferred_role = NULL, status = 'inactive',
                                     auth_provider = 'erased', auth_subject = NULL, calendar_token_hash = NULL
                   WHERE id = ?`).run(`#${personId}`, personId);
      db.prepare("DELETE FROM availability_day WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM availability_hour WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM person_roles WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM capabilities WHERE person_id=?").run(personId);
      db.prepare("UPDATE invitations SET email='erased', person_id=NULL WHERE person_id=?").run(personId);
      // And the shifts they had not yet done, for the reason written three lines up about the calendar token: not
      // leaving the consequence to a filter somewhere else. This row is now inactive, and every consumer of the
      // roster skips inactive people — so a future shift left on it was covered by nobody while reading as covered
      // by somebody. "Keep history" means keep the past; a shift next month is not history. `remove` already frees
      // them, by deleting the row, so the two modes were differing in the future when they should differ only in
      // what happens to the past.
      released = releaseFutureShifts(db, personId, today);
    } else {
      db.prepare("UPDATE invitations SET email='erased', person_id=NULL WHERE person_id=?").run(personId);
      db.prepare("DELETE FROM people WHERE id=?").run(personId);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  const after = db.prepare("SELECT COUNT(*) n FROM assignments WHERE person_id=?").get(personId).n;
  return { ok: true, mode, was: person.name, availabilityRemoved: before.availability,
           assignmentsBefore: before.assignments, assignmentsStillLinked: after, released, auditRenamed,
           auditScrubbed, notesRemoved, notificationsRemoved };
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
    // Whether a calendar subscription is live is a fact about them and belongs in a subject access request.
    // The token hash deliberately is NOT here: it is a credential, not personal data, and an export lands in
    // a downloaded file. Whether one exists is the useful part; its value would only be a liability.
    calendarFeedEnabled: Boolean(db.prepare("SELECT calendar_token_hash h FROM people WHERE id=?").get(personId)?.h),
    roles: q("SELECT r.name FROM person_roles pr JOIN roles r ON r.id=pr.role_id WHERE pr.person_id=?").map((r) => r.name),
    capabilities: q("SELECT a.key, a.label FROM capabilities c JOIN activities a ON a.id=c.activity_id WHERE c.person_id=?"),
    availabilityByDay: q("SELECT date, available FROM availability_day WHERE person_id=? ORDER BY date"),
    availabilityByHour: q("SELECT date, hour, available FROM availability_hour WHERE person_id=? ORDER BY date, hour"),
    assignments: q(`SELECT s.date, t.hour, t.minute, act.key AS activity, a.state
                      FROM assignments a JOIN sessions s ON s.id=a.session_id
                      JOIN timeslots t ON t.id=s.timeslot_id JOIN activities act ON act.id=s.activity_id
                     WHERE a.person_id=? ORDER BY s.date, t.hour`),
    messagesAboutYou: q("SELECT created_at AS at, kind, body, status FROM notifications WHERE person_id=? ORDER BY id"),

    // ---- the three tables this export used to walk straight past ------------------------------------------------
    //
    // Found by asking why `erasePerson`, twenty lines up, reaches ten tables while this function reads six. Erasure
    // knows about `notes`, `audit` and `invitations` — it deletes the notes outright, pseudonymises the audit actor,
    // scrubs an address out of `audit.detail`, and overwrites the invitation email. Every one of those is an
    // admission that the table holds this person's personal data. The export, a hand-written list of queries, had
    // never been told. Measured before changing anything: a note, an audit row and an invitation seeded for one
    // person came back in none of them, with notifications present as the control proving the reader worked.
    //
    // Access and erasure are the same question asked twice — what do we hold about this person — and answering it in
    // two places means one answer goes stale. The gate in test/privacy.test.mjs now derives the table list from the
    // schema and fails until a new table is either exported or exempted with a reason, so the next one cannot
    // silently be omitted.
    //
    // Their own notes, in full. Erasure DELETES these rather than relabelling them, on the grounds that a note is the
    // person's own sentence and there is no version of it with the person taken out. The same reasoning makes it
    // theirs to receive.
    notesYouWrote: q(`SELECT n.at, s.date AS sessionDate, n.body
                        FROM notes n JOIN sessions s ON s.id = n.session_id
                       WHERE n.person_id=? ORDER BY n.at`),
    // Invitations addressed to them. Just the address and the two timestamps — the token is a credential and stays
    // out for the same reason `calendar_token_hash` does.
    invitations: q("SELECT created_at AS at, email, accepted_at AS acceptedAt FROM invitations WHERE person_id=? ORDER BY id"),
    // Actions THEY took, from the audit trail — and `detail` is included deliberately. It can name a third party
    // (that is why scrubAuditDetail exists), which normally argues for holding it back under Art. 15(4); but these
    // are rows recording what this person did themselves, so there is nothing here they did not already see at the
    // time. Rows where they are the SUBJECT of somebody else's action are a different question and are not included:
    // those are largely about the actor, and an admin's identity is not the requester's to receive.
    actionsYouTook: q("SELECT at, action, subject, detail FROM audit WHERE actor_id=? ORDER BY id"),
  };
}

// A season as CSV, for planners who want it in a spreadsheet — which, given where this app came from, is a
// request that will absolutely be made.
export function exportSeasonCsv(db, seasonId, { delimiter = ",", bom = true } = {}) {
  const rows = db.prepare(`
    SELECT s.date, t.hour, t.minute, act.key AS activity, act.label,
           COALESCE(a.role, '') AS role,
           COALESCE(p.name, '') AS person, a.state
      FROM sessions s
      JOIN timeslots t ON t.id = s.timeslot_id
      JOIN activities act ON act.id = s.activity_id
      LEFT JOIN assignments a ON a.session_id = s.id
      LEFT JOIN people p ON p.id = a.person_id
     WHERE s.season_id = ?
     ORDER BY s.date, t.hour, t.minute, act.key, a.role`).all(seasonId);

  // Quote every field and double internal quotes. A volunteer called O'Brien, or an activity label with a
  // comma in it, must not shift every later column by one.
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  // `role` is not decoration. Since a partner-dance class opens one slot per role, this export emits TWO rows
  // with the same date, time and activity — and without this column they are indistinguishable, which for an
  // unfilled pair means two identical empty rows that read as a duplicate. Raw 'l'/'f' rather than a
  // translation: this is a data export, and a spreadsheet somebody filters should not change wording with the
  // locale. The value is empty for a slot whose role does not matter.
  const header = ["date", "time", "activity_key", "activity", "role", "person", "state"];
  const lines = [header.map(esc).join(delimiter)];
  for (const r of rows) {
    lines.push([r.date, `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
                r.activity, r.label, r.role, r.person, r.state ?? ""].map(esc).join(delimiter));
  }
  const body = lines.join("\r\n") + "\r\n";   // CRLF: what spreadsheets expect from a .csv

  // A UTF-8 byte-order mark, because this file is DOWNLOADED and then opened from disk, where the response's
  // `charset=utf-8` is not present and cannot help. Without the BOM a spreadsheet on Windows decodes it as the
  // system ANSI codepage: measured, "Søren Nørgård" renders as "SÃ¸ren NÃ¸rgÃ¥rd". For a Danish organisation
  // that is most volunteer names in the export, in the one artefact the board is most likely to open.
  //
  // `\uFEFF` as an escape, never the literal character: a BOM pasted into source is invisible, so a later edit
  // can delete or duplicate it with nothing on screen to show for it.
  //
  // The cost is honest rather than zero. Readers that strip a leading BOM — Excel, LibreOffice, Google Sheets,
  // Python's utf-8-sig, Node reading with a BOM-aware decoder — see nothing. A reader that does NOT strip it
  // gets the mark glued to the first header name, so the first column is called `\uFEFF"date"` instead of
  // `date`. That is a cosmetic surprise in one cell, against mojibake in every Danish name on every row.
  return bom ? `\uFEFF${body}` : body;
}
