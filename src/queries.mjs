// The behaviour that makes this a scheduling system rather than a set of tables.

// ---- Eligibility, defined exactly ONCE ----------------------------------------------------------------
// Both the vagtbørs listing and the claim guard use this same fragment. Two copies would drift, and the
// drift is not cosmetic: a volunteer could claim a slot the board never showed them, or vice versa.
//
// Availability resolution: an hour-level row wins over the day-level row for that hour; if neither exists
// the person counts as NOT available. That default is deliberate — silence is not consent. Assigning a
// volunteer who never answered is the exact failure the availability nudge exists to prevent.
// The predicate itself, parameterised by how the PERSON is named. The board asks "which slots suit this
// person" (:pid) and the planner asks "which people suit this slot" (p.id) — opposite directions, one rule.
// Writing it twice is how a volunteer ends up able to claim something the board never offered, or a planner
// sees a suggestion the system would then refuse.
//
// `person` is always a fragment this module controls (":pid" or "p.id"), never anything user-supplied.
// The gates, named individually — because two things need them: the rule, and the EXPLANATION of the rule.
//
// An empty shift exchange used to say only "there are no open slots you can take right now". True, and
// useless: it cannot tell "nothing is open" from "eleven slots are open and you are ineligible for all of them
// because you never said which role you teach", which a volunteer could fix in twenty seconds if anyone told
// them. Diagnosing that means relaxing the gates one at a time, and doing THAT without a second copy of the
// rule means naming them here and composing both from the same pieces.
export const GATE = {
  open: `a.person_id IS NULL`,

  capable: (person) => `EXISTS (SELECT 1 FROM capabilities c
                                 WHERE c.person_id = ${person} AND c.activity_id = s.activity_id)`,

  // A slot with no role takes anyone; a leader slot takes leaders and people who do both. Here rather than in
  // each caller so the board, the claim guard, the planner's candidates and auto-roster all inherit it.
  role: (person) => `(a.role IS NULL
                      OR (SELECT preferred_role FROM people WHERE id = ${person}) = 'b'
                      OR (SELECT preferred_role FROM people WHERE id = ${person}) = a.role)`,

  // An hour-level row wins over the day-level row for that hour; neither means NOT available. Deliberate —
  // silence is not consent. Assigning someone who never answered is what the nudge exists to prevent.
  available: (person) => `COALESCE(
        (SELECT ah.available FROM availability_hour ah
          WHERE ah.person_id = ${person} AND ah.date = s.date AND ah.hour = t.hour),
        (SELECT ad.available FROM availability_day ad
          WHERE ad.person_id = ${person} AND ad.date = s.date),
        0) = 1`,

  // Nobody can be in two places at once. Found while writing auto-roster, but the gap was real in the
  // vagtbørs too: config puts more than one activity in the same timeslot, so without this a volunteer could
  // claim both and nothing would notice until the evening itself.
  free: (person) => `NOT EXISTS (
        SELECT 1 FROM assignments a2
          JOIN sessions  s2 ON s2.id = a2.session_id
          JOIN timeslots t2 ON t2.id = s2.timeslot_id
         WHERE a2.person_id = ${person}
           AND a2.id <> a.id
           AND s2.date = s.date AND t2.hour = t.hour AND t2.minute = t.minute)`,
};

// The gates in the order a volunteer can act on them: what an admin controls, then what they control
// themselves, then the mechanical one. boardEmptyReason walks this list and reports the first that empties.
const GATE_ORDER = ["capable", "role", "available", "free"];

// The reason codes, named once and exported.
//
// They were string literals scattered through the two functions below, and test/strings.test.mjs kept a
// hand-written list of them so it could check a translation exists for each. A list of what to check cannot
// notice something missing from itself: add a thirteenth reason and the test stays green while the volunteer
// reading the shift exchange gets "board.why.whatever_new" on screen. Exactly the failure that list exists to
// prevent, and the same one that let a new notification kind slip past its own check.
//
// So there is one definition. The functions return values from here and the test enumerates the same object;
// drift is not expressible.
export const BOARD_EMPTY_REASONS = {
  NONE_OPEN: "none_open",
  NO_CAPABILITIES: "no_capabilities",
  NOTHING_IN_YOURS: "nothing_in_your_activities",
  NO_ROLE_STATED: "no_role_stated",
  OTHER_ROLE: "only_the_other_role",
  NO_AVAILABILITY: "no_availability",
  NOT_FREE_THEN: "not_free_then",
  ALREADY_BUSY: "already_busy_then",
};

export const SLOT_EMPTY_REASONS = {
  NO_VOLUNTEERS: "no_volunteers",
  NOBODY_CAPABLE: "nobody_capable",
  NOBODY_IN_THAT_ROLE: "nobody_in_that_role",
  NOBODY_FREE: "nobody_free",
  ALL_ALREADY_BUSY: "all_already_busy",
};

// Which reason each gate produces on the planner's side. Keyed by GATE_ORDER, so a new gate without a reason is
// `undefined` here rather than a silently missing explanation — and the test below asserts the mapping is total.
export const SLOT_REASON_BY_GATE = {
  capable: SLOT_EMPTY_REASONS.NOBODY_CAPABLE,        // grant somebody the capability
  role: SLOT_EMPTY_REASONS.NOBODY_IN_THAT_ROLE,      // recruit, or ask a both-role teacher — availability is fine
  available: SLOT_EMPTY_REASONS.NOBODY_FREE,         // the only case where the old message was true
  free: SLOT_EMPTY_REASONS.ALL_ALREADY_BUSY,         // free, but already on something at that hour; move it
};

// Every gate must produce a reason, checked at load rather than in a test: a gate added without one would report
// `undefined` to a planner staring at an unfillable slot.
for (const gate of GATE_ORDER) {
  if (!SLOT_REASON_BY_GATE[gate]) {
    throw new Error(`gate "${gate}" has no entry in SLOT_REASON_BY_GATE — a planner would be told undefined`);
  }
}

// The predicate itself, parameterised by how the PERSON is named. The board asks "which slots suit this
// person" (:pid) and the planner asks "which people suit this slot" (p.id) — opposite directions, one rule.
// Writing it twice is how a volunteer ends up able to claim something the board never offered, or a planner
// sees a suggestion the system would then refuse.
//
// `person` is always a fragment this module controls (":pid" or "p.id"), never anything user-supplied.
const eligiblePredicate = (person) =>
  [GATE.open, ...GATE_ORDER.map((g) => GATE[g](person))].join("\n  AND ");

const ELIGIBLE_OPEN_IDS = `
  SELECT a.id
    FROM assignments a
    JOIN sessions  s ON s.id = a.session_id
    JOIN timeslots t ON t.id = s.timeslot_id
   WHERE ${eligiblePredicate(":pid")}
`;

// The same rule, read the other way: who could take this particular open slot.
//
// Ordered by FAIRNESS — fewest confirmed activities this season first, then name. It used to be alphabetical,
// which meant the planner's dropdown and auto-roster disagreed about who should take a slot: the machine
// balanced while a planner filling gaps by hand kept picking whoever came first in the alphabet. Same
// eligibility rule, two different answers, and the practical effect was one volunteer quietly overloaded.
// Score exists to prevent exactly that, so the suggestion order has to honour it.
export function eligiblePeopleFor(db, assignmentId) {
  return db.prepare(`
    SELECT p.id, p.name,
           (SELECT COUNT(*) FROM assignments a2
              JOIN sessions s2 ON s2.id = a2.session_id
             WHERE a2.person_id = p.id AND a2.state = 'confirmed' AND s2.season_id = s.season_id) AS score
      FROM people p
      JOIN assignments a ON a.id = :aid
      JOIN sessions  s ON s.id = a.session_id
      JOIN timeslots t ON t.id = s.timeslot_id
     WHERE p.status = 'active'
       AND ${eligiblePredicate("p.id")}
     ORDER BY score ASC, p.name
  `).all({ aid: assignmentId });
}

// ---- Score --------------------------------------------------------------------------------------------
// Always computed, never stored. Only CONFIRMED assignments count: an auto-roster proposal the planner has
// not locked in yet is not something the volunteer has done.
export function score(db, personId, seasonId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
      FROM assignments a JOIN sessions s ON s.id = a.session_id
     WHERE a.person_id = :pid AND s.season_id = :sid AND a.state = 'confirmed'
  `).get({ pid: personId, sid: seasonId }).n;
}

// "Active volunteter" in the spreadsheet's sense: has done at least `threshold` activities this season.
export const isActive = (db, personId, seasonId, threshold = 1) => score(db, personId, seasonId) >= threshold;

// ---- The vagtbørs -------------------------------------------------------------------------------------
// `fromDate` defaults to the beginning of time so callers that do not care get everything; the board passes
// today, because offering a volunteer a slot that already happened is noise they have to read past.
export function openSlotsFor(db, personId, seasonId, fromDate = "0000-00-00") {
  return db.prepare(`
    SELECT a.id AS assignmentId, s.id AS sessionId, s.date, a.role,
           t.day_of_week AS dayOfWeek, t.hour, t.minute,
           act.key AS activityKey, act.label AS activityLabel
      FROM assignments a
      JOIN sessions   s ON s.id = a.session_id
      JOIN timeslots  t ON t.id = s.timeslot_id
      JOIN activities act ON act.id = s.activity_id
     WHERE a.id IN (${ELIGIBLE_OPEN_IDS})
       AND s.season_id = :sid
       AND s.date >= :from
     ORDER BY s.date, t.hour, t.minute
  `).all({ pid: personId, sid: seasonId, from: fromDate });
}

// WHY the shift exchange is empty, when it is.
//
// Written because "there are no open slots you can take right now" is true in every case and actionable in
// none. A volunteer invited into a partner-dance department, given a capability, who has not yet said whether
// they teach as leader or follower, is ineligible for every slot on every class — correctly — and the page told
// them nothing. They would conclude the app was broken, or that nobody needed them. Both wrong, both fixable by
// one sentence.
//
// Relaxes the gates one at a time, in the order a volunteer can act on them, and reports the FIRST one that
// takes the count to zero. Built from the same GATE fragments as the rule itself, so a change to eligibility
// cannot make the explanation lie.
export function boardEmptyReason(db, personId, seasonId, fromDate = "0000-00-00") {
  const countWith = (gates) => {
    const sql = `
      SELECT COUNT(*) n
        FROM assignments a
        JOIN sessions  s ON s.id = a.session_id
        JOIN timeslots t ON t.id = s.timeslot_id
       WHERE ${[GATE.open, ...gates.map((g) => GATE[g](":pid"))].join(" AND ")}
         AND s.season_id = :sid AND s.date >= :from`;
    // Bind :pid only when the statement actually mentions it. With no gates relaxed in yet, it does not — and
    // node:sqlite REJECTS a named parameter the statement does not use, so passing it unconditionally turned
    // the whole board into a 500. Same family as its refusal to mix ? with :named.
    const params = { sid: seasonId, from: fromDate };
    if (sql.includes(":pid")) params.pid = personId;
    return db.prepare(sql).get(params).n;
  };

  // Nothing open at all: not about this volunteer, so say that and nothing else.
  if (countWith([]) === 0) return { reason: BOARD_EMPTY_REASONS.NONE_OPEN };

  let passed = [];
  for (const gate of GATE_ORDER) {
    const next = [...passed, gate];
    if (countWith(next) > 0) { passed = next; continue; }

    // This gate is the one that empties it. Some have two distinct causes with two different remedies, and
    // conflating them would recreate the uselessness this function exists to remove.
    if (gate === "capable") {
      const mine = db.prepare("SELECT COUNT(*) n FROM capabilities WHERE person_id=?").get(personId).n;
      return { reason: mine === 0 ? BOARD_EMPTY_REASONS.NO_CAPABILITIES : BOARD_EMPTY_REASONS.NOTHING_IN_YOURS };
    }
    if (gate === "role") {
      const prefers = db.prepare("SELECT preferred_role FROM people WHERE id=?").get(personId)?.preferred_role;
      // No stated role is the volunteer's to fix in seconds; the other case is genuinely somebody else's shift.
      return { reason: prefers ? BOARD_EMPTY_REASONS.OTHER_ROLE : BOARD_EMPTY_REASONS.NO_ROLE_STATED };
    }
    if (gate === "available") {
      const answered = db.prepare(`SELECT (SELECT COUNT(*) FROM availability_day WHERE person_id=:p)
                                        + (SELECT COUNT(*) FROM availability_hour WHERE person_id=:p) AS n`)
        .get({ p: personId }).n;
      return { reason: answered === 0 ? BOARD_EMPTY_REASONS.NO_AVAILABILITY : BOARD_EMPTY_REASONS.NOT_FREE_THEN };
    }
    return { reason: BOARD_EMPTY_REASONS.ALREADY_BUSY };   // the double-booking gate
  }
  // Every gate passes and the board is still empty — only possible if the caller filtered further.
  return { reason: BOARD_EMPTY_REASONS.NONE_OPEN };
}

// WHY nobody can take this slot — the same question as boardEmptyReason, asked from the other end.
//
// The planner used to be told "Nobody has said they are free yet" for every empty candidate list, and unlike
// the board's old message that is not merely vague, it is usually FALSE. If nobody is recorded as able to run
// the activity, plenty of people have said they are free. If it is a leader slot and only followers answered,
// they said they are free. If everyone who could is already on something else at that hour, they certainly said
// they were free. In each case a planner reads "nobody is free", goes and chases people for availability, and
// the actual remedy was to grant a capability, find a leader, or move the session.
//
// So this reports which gate empties the list, and each answer maps to a different action.
export function slotEmptyReason(db, assignmentId) {
  const countWith = (gates) => db.prepare(`
    SELECT COUNT(*) n
      FROM people p
      JOIN assignments a ON a.id = :aid
      JOIN sessions  s ON s.id = a.session_id
      JOIN timeslots t ON t.id = s.timeslot_id
     WHERE p.status = 'active'
       ${gates.map((g) => `AND ${GATE[g]("p.id")}`).join("\n       ")}
  `).get({ aid: assignmentId }).n;

  // No active volunteers at all: nothing about this slot, and nothing a planner can do on this screen.
  if (countWith([]) === 0) return { reason: SLOT_EMPTY_REASONS.NO_VOLUNTEERS };

  let passed = [];
  for (const gate of GATE_ORDER) {
    const next = [...passed, gate];
    if (countWith(next) > 0) { passed = next; continue; }
    return { reason: SLOT_REASON_BY_GATE[gate] };
  }
  return { reason: SLOT_EMPTY_REASONS.NOBODY_FREE };   // unreachable while the list is empty, never guess silently
}

// Claiming. The guard IS the race protection: `person_id IS NULL` inside the UPDATE means two volunteers
// hitting this at the same moment cannot both win — the second sees changes === 0. Eligibility is checked
// in the same statement so it cannot be bypassed by calling this directly.
export function claimSlot(db, assignmentId, personId) {
  const info = db.prepare(`
    UPDATE assignments
       SET person_id = :pid, state = 'confirmed'
     WHERE id = :aid
       AND id IN (${ELIGIBLE_OPEN_IDS})
  `).run({ aid: assignmentId, pid: personId });
  if (info.changes === 1) return { ok: true };
  // Distinguish "someone beat you to it" from "you were never allowed to take it" — the volunteer needs
  // different words for each, and lumping them together is how a UI ends up lying.
  const row = db.prepare("SELECT person_id FROM assignments WHERE id = :aid").get({ aid: assignmentId });
  if (!row) return { ok: false, reason: "no_such_slot" };
  if (row.person_id !== null) return { ok: false, reason: "already_taken" };
  return { ok: false, reason: "not_eligible" };
}

// Handing a slot back. Guarded on person_id = you, so one volunteer cannot release another's slot.
// `today` is injected rather than read from the clock so the cutoff is testable without freezing time.
export function handBackSlot(db, assignmentId, personId, { today, cutoffDays = 0 } = {}) {
  const row = db.prepare(`
    SELECT a.person_id, s.date
      FROM assignments a JOIN sessions s ON s.id = a.session_id
     WHERE a.id = :aid
  `).get({ aid: assignmentId });
  if (!row) return { ok: false, reason: "no_such_slot" };
  if (row.person_id !== personId) return { ok: false, reason: "not_yours" };

  if (today && cutoffDays > 0) {
    const days = Math.round((Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    // Past the cutoff it still releases, but the caller is told to notify a planner: at that point a human
    // needs to know, otherwise the board quietly becomes the no-show channel.
    if (days < cutoffDays) {
      db.prepare("UPDATE assignments SET person_id = NULL WHERE id = :aid AND person_id = :pid")
        .run({ aid: assignmentId, pid: personId });
      return { ok: true, pastCutoff: true, daysUntil: days };
    }
  }
  const info = db.prepare("UPDATE assignments SET person_id = NULL WHERE id = :aid AND person_id = :pid")
    .run({ aid: assignmentId, pid: personId });
  return info.changes === 1 ? { ok: true, pastCutoff: false } : { ok: false, reason: "not_yours" };
}

// ---- Reading the plan ---------------------------------------------------------------------------------
export function planForSeason(db, seasonId) {
  return db.prepare(`
    SELECT s.id AS sessionId, s.date, t.day_of_week AS dayOfWeek, t.hour, t.minute,
           act.key AS activityKey, act.label AS activityLabel,
           a.id AS assignmentId, a.role, a.state, a.person_id AS personId, p.name AS personName
      FROM sessions s
      JOIN timeslots  t ON t.id = s.timeslot_id
      JOIN activities act ON act.id = s.activity_id
      LEFT JOIN assignments a ON a.session_id = s.id
      LEFT JOIN people p ON p.id = a.person_id
     WHERE s.season_id = :sid
     ORDER BY s.date, t.hour, t.minute, act.key
  `).all({ sid: seasonId });
}

// ---- planner assignment -------------------------------------------------------------------------------
// A planner may assign someone who has NOT answered — they have presumably just asked them in person, and
// refusing would push the work back into the group chat this app exists to replace. A planner may NOT assign
// someone who explicitly answered "cannot": silence is not consent, but an actual "no" is an actual no, and
// overriding it is the one thing that would make volunteers stop trusting the tool.
//
// `expectPersonId` is optimistic concurrency: the form carries whoever occupied the slot when it was
// rendered, so overwriting a person is only possible if the planner was looking at that person. If somebody
// else changed it meanwhile, this refuses instead of silently discarding their work.
export function assignSlot(db, assignmentId, personId, { expectPersonId = null } = {}) {
  const row = db.prepare(`
    SELECT a.person_id, a.role, s.date, s.activity_id, t.hour, t.minute
      FROM assignments a JOIN sessions s ON s.id = a.session_id JOIN timeslots t ON t.id = s.timeslot_id
     WHERE a.id = :aid
  `).get({ aid: assignmentId });
  if (!row) return { ok: false, reason: "no_such_slot" };

  const current = row.person_id ?? null;
  if (current !== (expectPersonId ?? null)) return { ok: false, reason: "changed", current };

  const person = db.prepare("SELECT id, status FROM people WHERE id = ?").get(personId);
  if (!person || person.status !== "active") return { ok: false, reason: "no_such_person" };

  const capable = db.prepare("SELECT 1 FROM capabilities WHERE person_id=? AND activity_id=?").get(personId, row.activity_id);
  if (!capable) return { ok: false, reason: "not_capable" };

  // A leader slot needs a leader or someone who does both. Checked here as well as in the shared predicate,
  // because a planner assigns directly rather than through the board.
  const prefers = db.prepare("SELECT preferred_role FROM people WHERE id=?").get(personId)?.preferred_role;
  if (row.role && prefers !== "b" && prefers !== row.role) return { ok: false, reason: "wrong_role" };

  // Nobody can be in two places at one time. The shared predicate has always said so, but it only gated the
  // CANDIDATE LIST — so the board and the auto-roster were safe while a direct planner assignment was not, and
  // tools/demo.mjs (which calls straight into here) produced nine of them, including one person listed as both
  // the leader AND the follower of the same class. Same reasoning as the role check above: a planner assigns
  // directly rather than through the board, so the rule has to hold at the write.
  const clash = db.prepare(`
    SELECT act.label AS label
      FROM assignments a2
      JOIN sessions   s2 ON s2.id = a2.session_id
      JOIN timeslots  t2 ON t2.id = s2.timeslot_id
      JOIN activities act ON act.id = s2.activity_id
     WHERE a2.person_id = :pid AND a2.id <> :aid
       AND s2.date = :d AND t2.hour = :h AND t2.minute = :m
     LIMIT 1
  `).get({ pid: personId, aid: assignmentId, d: row.date, h: row.hour, m: row.minute });
  if (clash) return { ok: false, reason: "already_booked", clashesWith: clash.label };

  const answer = db.prepare(`
    SELECT COALESCE(
      (SELECT available FROM availability_hour WHERE person_id=:pid AND date=:d AND hour=:h),
      (SELECT available FROM availability_day  WHERE person_id=:pid AND date=:d)) AS a
  `).get({ pid: personId, d: row.date, h: row.hour }).a;
  if (answer === 0) return { ok: false, reason: "said_no" };

  const info = db.prepare(`UPDATE assignments SET person_id = :pid, state = 'confirmed'
                            WHERE id = :aid AND COALESCE(person_id, -1) = COALESCE(:expect, -1)`)
    .run({ aid: assignmentId, pid: personId, expect: expectPersonId ?? null });
  return info.changes === 1 ? { ok: true, unanswered: answer == null } : { ok: false, reason: "changed" };
}

export function unassignSlot(db, assignmentId, { expectPersonId = null } = {}) {
  const info = db.prepare(`UPDATE assignments SET person_id = NULL
                            WHERE id = :aid AND COALESCE(person_id, -1) = COALESCE(:expect, -1)`)
    .run({ aid: assignmentId, expect: expectPersonId ?? null });
  return info.changes === 1 ? { ok: true } : { ok: false, reason: "changed" };
}

// One person's own slots from `fromDate` onward. Separate from planForSeason because this is the first thing
// a volunteer wants to see and it must not require reading the whole season to find it.
export function myUpcoming(db, personId, seasonId, fromDate, limit = 20) {
  return db.prepare(`
    SELECT a.id AS assignmentId, s.date, a.role, t.day_of_week AS dayOfWeek, t.hour, t.minute,
           act.key AS activityKey, act.label AS activityLabel, a.state
      FROM assignments a
      JOIN sessions   s ON s.id = a.session_id
      JOIN timeslots  t ON t.id = s.timeslot_id
      JOIN activities act ON act.id = s.activity_id
     WHERE a.person_id = :pid AND s.season_id = :sid AND s.date >= :from
     ORDER BY s.date, t.hour, t.minute
     LIMIT :lim
  `).all({ pid: personId, sid: seasonId, from: fromDate, lim: limit });
}

// Everything the calendar feed needs, for one person, across ALL seasons.
//
// Not season-scoped, unlike every other view: a calendar spans a rollover, and a volunteer whose subscription
// went blank on the day the new season opened would reasonably conclude the app had lost their shifts.
// Bounded by date instead, with a little history so the feed is not empty in the first week of a season.
export function calendarRowsFor(db, personId, fromDate) {
  return db.prepare(`
    SELECT a.id AS assignmentId, s.date, a.role, t.hour, t.minute,
           act.label AS activityLabel, a.state
      FROM assignments a
      JOIN sessions   s ON s.id = a.session_id
      JOIN timeslots  t ON t.id = s.timeslot_id
      JOIN activities act ON act.id = s.activity_id
     WHERE a.person_id = :pid AND s.date >= :from
     ORDER BY s.date, t.hour, t.minute
  `).all({ pid: personId, from: fromDate });
}

export function setAvailabilityDay(db, personId, date, available) {
  db.prepare(`INSERT INTO availability_day (person_id, date, available) VALUES (:pid, :d, :a)
              ON CONFLICT (person_id, date) DO UPDATE SET available = :a`)
    .run({ pid: personId, d: date, a: available ? 1 : 0 });
}

export function setAvailabilityHour(db, personId, date, hour, available) {
  db.prepare(`INSERT INTO availability_hour (person_id, date, hour, available) VALUES (:pid, :d, :h, :a)
              ON CONFLICT (person_id, date, hour) DO UPDATE SET available = :a`)
    .run({ pid: personId, d: date, h: hour, a: available ? 1 : 0 });
}
