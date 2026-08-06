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

  // ON THE ROSTER AT ALL. This gate was missing, and its absence let a stood-down volunteer take work straight back.
  //
  // Measured before fixing: an admin sets somebody inactive, which releases their future shifts by design. Their
  // availability answers survive — only assignments are released — and nothing in this predicate looked at status,
  // so the shift exchange then offered that person 172 open slots and the claim SUCCEEDED. The one path a volunteer
  // drives themselves was the one path the stand-down did not reach.
  //
  // It looked covered because the planner's side is covered: eligiblePeopleFor, slotEmptyReason, rosterReview and
  // workloadSpread each filter status = active in their own WHERE clause, so a planner could not assign an inactive
  // person and the review screens left them out. Four call sites enforcing a rule the shared predicate did not have
  // is exactly the shape the comment above this object warns about, which is why the gate belongs here.
  onRoster: (person) => `(SELECT status FROM people WHERE id = ${person}) = 'active'`,

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
const GATE_ORDER = ["onRoster", "capable", "role", "available", "free"];

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
  NOT_ON_ROSTER: "not_on_roster",
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
  NOBODY_ON_ROSTER: "nobody_on_roster",
  NOBODY_CAPABLE: "nobody_capable",
  NOBODY_IN_THAT_ROLE: "nobody_in_that_role",
  NOBODY_FREE: "nobody_free",
  ALL_ALREADY_BUSY: "all_already_busy",
};

// Which reason each gate produces on the planner's side. Keyed by GATE_ORDER, so a new gate without a reason is
// `undefined` here rather than a silently missing explanation — and the test below asserts the mapping is total.
export const SLOT_REASON_BY_GATE = {
  onRoster: SLOT_EMPTY_REASONS.NOBODY_ON_ROSTER,   // everyone able is stood down; bring one back
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

// And how the planner's DIRECT write honours each gate — because `assignSlot` cannot simply use
// eligiblePredicate, and the gap that creates has already shipped a bug.
//
// A planner is allowed two things the shared rule forbids: reassigning an occupied slot, and assigning somebody
// who has not answered. So assignSlot re-derives the checks by hand, and two of them deliberately differ. That
// is defensible. What is not defensible is it happening by accident, which is what happened with the
// double-booking gate: it was added to GATE, the board and auto-roster inherited it for free, assignSlot did
// not, and nobody noticed until demo data grew nine double-bookings — one person listed as both the leader AND
// the follower of the same class. The predicate said the rule; the write did not enforce it.
//
// So a new gate now has to be answered for here as well. Not enforcement — this is a note, and a note cannot
// check that assignSlot really does what it says. What it does is make the omission impossible to commit
// silently: add a sixth gate and the app refuses to load until somebody has decided what a planner's direct
// write should do about it. That decision is the step that was skipped.
export const PLANNER_WRITE_HONOURS = {
  onRoster: "yes, and it already did before this gate existed — but under the WRONG NAME. The check read " +
            "`!person || person.status !== 'active'` and reported `no_such_person`, conflating somebody who was " +
            "never here with somebody an admin stood down. One is fixed by an admin in a click; the other means " +
            "the name is wrong. Split, so a planner is told which. Refuses with `not_on_roster`.",
  open: "NO, deliberately — a planner may reassign an occupied slot. `expectPersonId` is the guard instead, so " +
        "overwriting somebody is only possible if the planner was looking at that somebody.",
  capable: "yes — a direct query, refusing with `not_capable`.",
  role: "yes — a direct query, refusing with `wrong_role`.",
  available: "PARTLY, deliberately — an explicit 'cannot' refuses with `said_no`, but silence is allowed and " +
             "reported back as `unanswered` so the planner is told to go and ask. The gate treats silence as no; " +
             "a planner has presumably just asked them in person.",
  free: "yes — refusing with `already_booked`. Re-queried rather than reused because it also returns the label " +
        "of the clashing activity, which the gate cannot produce.",
};
for (const gate of Object.keys(GATE)) {
  if (!PLANNER_WRITE_HONOURS[gate]) {
    throw new Error(`gate "${gate}" has no entry in PLANNER_WRITE_HONOURS — decide what a planner's direct ` +
      `assignment does about it before shipping it. The double-booking rule was added to GATE and missed in ` +
      `assignSlot exactly this way, and the board was safe while a planner assignment was not.`);
  }
}
for (const gate of Object.keys(PLANNER_WRITE_HONOURS)) {
  if (!GATE[gate]) throw new Error(`PLANNER_WRITE_HONOURS describes "${gate}", which is not a gate any more`);
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

// ---- Two numbers, and they must not be one -------------------------------------------------------------
// Always computed, never stored, as the spec requires. But there are TWO questions here and one number cannot
// answer both:
//
//   LOAD (`score`)     — how many confirmed shifts does this person HOLD this season, past and future?
//                        Forward-looking. This is what auto-roster balances and what the planner's candidate
//                        list orders by, so that filling a gap by hand and filling it by machine agree.
//   RECORD (`attendedCount`) — how many did they actually TURN UP for? Backward-looking. This is the
//                        contribution number a planner eyeballs and a report would use.
//
// Feeding the RECORD to auto-roster is the trap, and it is not subtle: somebody holding four future shifts has
// attended none of them, so an auto-roster balancing on attendance sees an under-loaded volunteer and hands them
// a fifth. Every unstarted shift makes them look emptier. So auto-roster and the candidate list stay on load,
// deliberately, and the two are named differently here so a later change cannot conflate them by accident.
export function score(db, personId, seasonId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
      FROM assignments a JOIN sessions s ON s.id = a.session_id
     WHERE a.person_id = :pid AND s.season_id = :sid AND a.state = 'confirmed'
  `).get({ pid: personId, sid: seasonId }).n;
}

// Shifts they turned up for. `attended IS 1` rather than `= 1` so NULL — nobody has said — counts as neither
// attended nor missed, which is the whole reason that column is nullable.
export function attendedCount(db, personId, seasonId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
      FROM assignments a JOIN sessions s ON s.id = a.session_id
     WHERE a.person_id = :pid AND s.season_id = :sid AND a.state = 'confirmed' AND a.attended IS 1
  `).get({ pid: personId, sid: seasonId }).n;
}

// Marking it. Only for a shift whose date has PASSED: recording that somebody attended next Wednesday is not a
// fact, and a planner who can do it will eventually do it by accident on the wrong row.
//
// `attended` may be 1, 0, or null — the third is how a planner undoes a mistake, and it has to be reachable or
// the only fix for a mis-click is a database edit.
export function markAttendance(db, assignmentId, attended, { today }) {
  if (![0, 1, null].includes(attended)) return { ok: false, reason: "bad_attendance" };
  const row = db.prepare(`SELECT a.person_id AS personId, s.date
                            FROM assignments a JOIN sessions s ON s.id = a.session_id
                           WHERE a.id = ?`).get(assignmentId);
  if (!row) return { ok: false, reason: "no_such_slot" };
  if (row.personId == null) return { ok: false, reason: "nobody_on_it" };
  if (row.date >= today) return { ok: false, reason: "not_yet" };

  db.prepare("UPDATE assignments SET attended = :a WHERE id = :id").run({ a: attended, id: assignmentId });
  return { ok: true, personId: row.personId, date: row.date, attended };
}

// One session, for its own page. Returns null rather than throwing on an id that does not exist, because the id
// arrives out of a URL and a 404 is the answer.
export const sessionDetail = (db, id) => db.prepare(`
  SELECT s.id, s.date, s.season_id AS seasonId, t.hour, t.minute, act.label AS activityLabel, act.key AS activityKey
    FROM sessions s
    JOIN timeslots  t   ON t.id = s.timeslot_id
    JOIN activities act ON act.id = s.activity_id
   WHERE s.id = :id
`).get({ id }) ?? null;

// Who is on it — OPEN SLOTS INCLUDED. An empty slot is part of the answer to "who is on this", and leaving it out
// would show a shorter list that reads as fully staffed, which is the shape of defect this project keeps finding.
export const peopleOnSession = (db, sessionId) => db.prepare(`
  SELECT a.id AS assignmentId, a.role, a.state, p.name
    FROM assignments a LEFT JOIN people p ON p.id = a.person_id
   WHERE a.session_id = :sid
   ORDER BY CASE WHEN p.name IS NULL THEN 1 ELSE 0 END, p.name
`).all({ sid: sessionId });

// Shifts in the past that nobody has marked either way — the planner's to-do list, and the reason attendance
// does not silently stay empty forever. Capped, because a season of unmarked shifts is not a page.
export const unmarkedShifts = (db, seasonId, today, limit = 50) =>
  db.prepare(`
    SELECT a.id AS assignmentId, s.date, t.hour, t.minute, act.label AS activityLabel,
           COALESCE(a.role, '') AS role, p.name AS personName, a.person_id AS personId
      FROM assignments a
      JOIN sessions   s   ON s.id = a.session_id
      JOIN timeslots  t   ON t.id = s.timeslot_id
      JOIN activities act ON act.id = s.activity_id
      JOIN people     p   ON p.id = a.person_id
     WHERE s.season_id = :sid AND s.date < :today AND a.state = 'confirmed' AND a.attended IS NULL
     ORDER BY s.date DESC, t.hour LIMIT :n
  `).all({ sid: seasonId, today, n: limit });

// "Active volunteer" in the spreadsheet's sense: has done at least `threshold` activities this season.
//
// Deliberately still LOAD rather than attendance. This feeds nothing that gates eligibility — `people.status` does
// that, for the bootstrapping reason recorded in PLAN.md — and switching it to attendance would make a volunteer
// who has signed up but not yet run anything read as inactive, which is the same paradox one layer along.
export const isActive = (db, personId, seasonId, threshold = 1) => score(db, personId, seasonId) >= threshold;

// ---- The vagtbørs -------------------------------------------------------------------------------------
// `fromDate` defaults to the beginning of time so callers that do not care get everything; the board passes
// today, because offering a volunteer a slot that already happened is noise they have to read past.
// The date every caller must state, and there is no default any more — because a permissive default is exactly how
// two screens came to show the past. `/plan` opened six weeks before today and `/availability` offered twelve dates
// that had already happened, and in both cases the mechanism was the same: a filter that a caller could simply not
// apply. The board's one production caller was passing today() correctly, so nothing here was broken — but the shape
// was, and the two commits before this one are what it costs when a caller forgets.
//
// ANY_DATE is for the tests that genuinely want the whole season regardless of when it is, and it is exported with a
// name so that choice is legible at the call site rather than being the absence of an argument.
export const ANY_DATE = "0000-00-00";

export function openSlotsFor(db, personId, seasonId, fromDate) {
  if (!fromDate) throw new Error("openSlotsFor needs the date to offer from — pass today(), or ANY_DATE on purpose");
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
    // Their own status is the cause, and unlike every other gate here it is not theirs to fix — so the message
    // has to say who can. Checked FIRST because it makes every later gate moot: a stood-down volunteer is not
    // "missing a capability", they are not on the roster.
    if (gate === "onRoster") return { reason: BOARD_EMPTY_REASONS.NOT_ON_ROSTER };
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

  // Past the cutoff it still releases, but the caller is told to notify a planner: at that point a human needs
  // to know, otherwise the board quietly becomes the no-show channel. Both dates are parsed at UTC midnight, so
  // the difference is an exact number of days and no DST offset can shift it across a boundary.
  let pastCutoff = false, daysUntil = null;
  if (today && cutoffDays > 0) {
    daysUntil = Math.round((Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    pastCutoff = daysUntil < cutoffDays;
  }

  // ONE update, and its result is read whichever branch we are in. There used to be two copies of this
  // statement: the one inside the past-cutoff branch returned `{ ok: true }` without ever looking at `changes`,
  // and the one here checked it properly.
  //
  // Being honest about what that was and was not. It is NOT a reachable bug: the ownership check a few lines up
  // already returned `not_yours`, and node:sqlite is synchronous in one process, so `changes` was always 1 by
  // the time either copy ran. I first wrote this comment claiming the late path would report a bogus success —
  // then probed it by restoring the unchecked version, and the test I had written to catch it stayed green,
  // because it never reached the update at all. The claim was mine, unverified, in a comment. Exactly the thing
  // this codebase keeps having to correct.
  //
  // What it WAS: the same write in two places, one of which discarded its result, so the guarantee held only
  // because of a check three lines away. That is worth collapsing on its own merits — a second copy is what
  // drifts when someone later relaxes the ownership check, or moves this behind anything asynchronous, or runs
  // two containers against one volume. One statement, one place that reads `changes`.
  const info = db.prepare("UPDATE assignments SET person_id = NULL WHERE id = :aid AND person_id = :pid")
    .run({ aid: assignmentId, pid: personId });
  if (info.changes !== 1) return { ok: false, reason: "not_yours" };
  // Shape kept exactly: a test asserts the ordinary result deep-equals `{ ok: true, pastCutoff: false }`, so
  // daysUntil must not appear on that path.
  return pastCutoff ? { ok: true, pastCutoff: true, daysUntil } : { ok: true, pastCutoff: false };
}

// ---- Reading the plan ---------------------------------------------------------------------------------
// ---- the horizon, defined once ------------------------------------------------------------------------------
//
// Measured in a browser at 375px on the demo instance: `/plan` rendered 46 dates, 59 KB and **15,012 pixels** of page —
// eighteen phone screens — starting six weeks IN THE PAST, so a volunteer opening "The plan" had to scroll past a month
// and a half of history to find out who is on this Wednesday.
//
// The planner's grid had a four-week window with links to widen it, added after the whole-season view was measured at
// 490 KB. The page every VOLUNTEER opens got none of it: the same fix, applied to the back-office screen and not to the
// one with twenty times the readers. So the windowing lives here now and both pages call it.
//
// `weeks = null` means "all". On the planner that still means future-only, because a grid of past shifts is not work to
// do; on the read-only plan it includes the past, because "who taught in September" is a question that page should be
// able to answer. That is the one difference, and it is a parameter rather than two copies of the arithmetic.
export const horizonWeeks = (raw) => (raw === "all" ? null : Math.max(1, Number(raw) || 4));

export function withinHorizon(rows, { today, weeks, past = false }) {
  const until = weeks === null ? null
    : new Date(Date.parse(`${today}T00:00:00Z`) + weeks * 7 * 86400000).toISOString().slice(0, 10);
  return rows.filter((r) => (past || r.date >= today) && (until === null || r.date <= until));
}

export function planForSeason(db, seasonId) {
  return db.prepare(`
    SELECT s.id AS sessionId, s.date, t.day_of_week AS dayOfWeek, t.hour, t.minute,
           act.key AS activityKey, act.label AS activityLabel,
           a.id AS assignmentId, a.role, a.state, a.person_id AS personId, p.name AS personName,
           -- Carried so the grid can offer the attendance control on shifts that have happened. Without it the
           -- view cannot tell "marked as absent" from "nobody has said", which are the two states a planner most
           -- needs to distinguish when working through a backlog.
           a.attended
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
  if (!person) return { ok: false, reason: "no_such_person" };
  // Stood down is not the same fact as never existed, and a planner staring at an unfillable slot needs to know
  // which one it is: one is fixed by an admin in a click, the other means the name is wrong.
  if (person.status !== "active") return { ok: false, reason: "not_on_roster" };

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
