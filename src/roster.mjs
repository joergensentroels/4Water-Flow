// Auto-roster. Modelled on how Troels described it working at PDC: it makes REAL changes to the plan, which
// the planner then discards or locks in. Not a read-only list of suggestions — that is the difference between
// something a planner uses every season and something they try once.
//
// Three properties make re-running safe, which is what makes it usable at all:
//   1. It only ever touches slots with nobody in them.
//   2. Proposals are provisional, so a re-run CLEARS them first and starts over. Two runs on the same input
//      therefore produce the same plan.
//   3. Locked (confirmed) assignments are invisible to it. A planner can lock the parts they are sure about
//      and keep re-running the rest.
import { eligiblePeopleFor } from "./queries.mjs";

const OPEN_SLOTS = `
  SELECT a.id, s.date, s.activity_id, t.hour, t.minute
    FROM assignments a
    JOIN sessions  s ON s.id = a.session_id
    JOIN timeslots t ON t.id = s.timeslot_id
   WHERE a.person_id IS NULL AND s.season_id = :sid AND s.date >= :from
   ORDER BY s.date, t.hour, t.minute, s.activity_id, a.id
`;

// Confirmed work per person this season — the fairness input. Read at the START of a run, and it therefore
// already includes anything the vagtbørs redistributed: the board quietly moves Score around, so reading it
// before board activity would balance against a stale picture.
function confirmedTally(db, seasonId) {
  const tally = new Map();
  for (const r of db.prepare(`
    SELECT a.person_id AS pid, COUNT(*) AS n
      FROM assignments a JOIN sessions s ON s.id = a.session_id
     WHERE s.season_id = :sid AND a.state = 'confirmed' AND a.person_id IS NOT NULL
     GROUP BY a.person_id`).all({ sid: seasonId })) tally.set(r.pid, r.n);
  return tally;
}

export function discardProposals(db, seasonId, fromDate = "0000-00-00") {
  // Back to a plain open slot. `state` only carries meaning while somebody occupies the row, so it returns
  // to the neutral default rather than gaining a third value nothing else understands.
  return db.prepare(`
    UPDATE assignments SET person_id = NULL, state = 'confirmed'
     WHERE state = 'proposed' AND person_id IS NOT NULL
       AND session_id IN (SELECT id FROM sessions WHERE season_id = :sid AND date >= :from)
  `).run({ sid: seasonId, from: fromDate }).changes;
}

export function lockInProposals(db, seasonId, fromDate = "0000-00-00") {
  return db.prepare(`
    UPDATE assignments SET state = 'confirmed'
     WHERE state = 'proposed' AND person_id IS NOT NULL
       AND session_id IN (SELECT id FROM sessions WHERE season_id = :sid AND date >= :from)
  `).run({ sid: seasonId, from: fromDate }).changes;
}

export const countProposals = (db, seasonId, fromDate = "0000-00-00") =>
  db.prepare(`SELECT COUNT(*) n FROM assignments a JOIN sessions s ON s.id = a.session_id
               WHERE a.state = 'proposed' AND a.person_id IS NOT NULL AND s.season_id = :sid AND s.date >= :from`)
    .get({ sid: seasonId, from: fromDate }).n;

export function autoRoster(db, { seasonId, fromDate = "0000-00-00" }) {
  const cleared = discardProposals(db, seasonId, fromDate);
  const tally = confirmedTally(db, seasonId);
  const slots = db.prepare(OPEN_SLOTS).all({ sid: seasonId, from: fromDate });

  const claim = db.prepare("UPDATE assignments SET person_id = :pid, state = 'proposed' WHERE id = :aid AND person_id IS NULL");
  const proposed = [];
  const unfillable = [];

  for (const slot of slots) {
    // Candidates come from the ONE shared eligibility rule, re-read per slot because each proposal changes
    // who is still free — including the double-booking check, which is why this cannot be hoisted.
    const candidates = eligiblePeopleFor(db, slot.id);
    if (candidates.length === 0) { unfillable.push(slot.id); continue; }

    // Fewest activities first. Ties break on name then id so the same input always yields the same plan —
    // a roster that shuffles between identical runs is impossible for a planner to review.
    candidates.sort((x, y) =>
      (tally.get(x.id) ?? 0) - (tally.get(y.id) ?? 0) ||
      x.name.localeCompare(y.name) ||
      x.id - y.id);

    const pick = candidates[0];
    if (claim.run({ aid: slot.id, pid: pick.id }).changes !== 1) continue;   // someone took it mid-run
    tally.set(pick.id, (tally.get(pick.id) ?? 0) + 1);
    proposed.push({ assignmentId: slot.id, personId: pick.id, date: slot.date });
  }

  return { cleared, proposed, unfillable, filled: proposed.length, gaps: unfillable.length };
}

// What the planner needs before pressing "lock in", and what nothing showed them until now.
//
// Measured on a full season seeded from zero — 178 slots, twelve volunteers with deliberately uneven
// capabilities and availability — the greedy loop evens out COUNTS about as well as availability permits: the
// four broadly-available volunteers landed on 21, 22, 22 and 23. Everyone below that was capped by what they
// had offered, not by the algorithm.
//
// But three of those four were given 78%, 82% and 91% of their shifts on ONE weekday, having offered two
// roughly equally. That is not a bug in the tally — it is what a stable tie-break does against a weekly cycle:
// the rotation locks to a period that divides the week, so the same people keep landing on the same evening.
//
// Whether that is a problem is 4water's call and not mine. "I always get stuck with Sundays" is a real reason
// volunteers quit; having the same teacher every Sunday is also real continuity for a class. So this reports
// the distribution and changes no decision. What it must not do is stay invisible: workloadSpread() below
// computed the fairness picture for the TESTS and showed it to nobody, while the planner locked in 178
// proposals blind.
//
// Whole-season, deliberately: that is the window autoRoster's own tally uses, so the planner sees the same
// numbers the machine balanced against rather than a differently-scoped second opinion.
export function rosterReview(db, seasonId) {
  // Two queries, both constant in headcount. strftime('%w') is 0=Sunday, which is getUTCDay()'s convention and
  // therefore the `weekday.N` string keys — no weekday name appears here, and none may.
  const rows = db.prepare(`
    SELECT p.id, p.name,
           CAST(strftime('%w', s.date) AS INTEGER) AS dow,
           SUM(CASE WHEN a.state = 'proposed' THEN 1 ELSE 0 END) AS proposed,
           COUNT(a.id) AS n
      FROM people p
      LEFT JOIN assignments a ON a.person_id = p.id
           AND a.session_id IN (SELECT id FROM sessions WHERE season_id = :sid)
      LEFT JOIN sessions s ON s.id = a.session_id
     WHERE p.status = 'active'
     GROUP BY p.id, dow
     ORDER BY p.name`).all({ sid: seasonId });

  // How many distinct weekdays each person could have been given, from their own availability. Needed to avoid
  // blaming the roster for concentration the volunteer chose: someone who only ever offered Sundays was not
  // put on Sundays by an algorithm. Day-level availability only — an hour-level override could in principle
  // narrow this further, so treat it as a floor on choice rather than an exact count.
  const choice = new Map();
  for (const r of db.prepare(`
    SELECT av.person_id AS pid, COUNT(DISTINCT CAST(strftime('%w', s.date) AS INTEGER)) AS d
      FROM sessions s
      JOIN availability_day av ON av.date = s.date AND av.available = 1
      JOIN capabilities  c  ON c.person_id = av.person_id AND c.activity_id = s.activity_id
     WHERE s.season_id = :sid
     GROUP BY av.person_id`).all({ sid: seasonId })) choice.set(r.pid, r.d);

  const people = new Map();
  for (const r of rows) {
    if (!people.has(r.id)) people.set(r.id, { id: r.id, name: r.name, total: 0, proposed: 0, byDay: new Map() });
    const p = people.get(r.id);
    if (r.dow === null) continue;                 // the row a person with no work at all produces
    p.total += r.n;
    p.proposed += r.proposed;
    p.byDay.set(r.dow, (p.byDay.get(r.dow) ?? 0) + r.n);
  }

  // Busiest first: the two ends of this list are the two questions a planner has — who is carrying too much,
  // and who has been left out entirely.
  const list = [...people.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  for (const p of list) {
    const top = [...p.byDay.entries()].sort((a, b) => b[1] - a[1])[0];
    // Only meaningful once there is enough work for a pattern to exist, and only when they HAD another option.
    p.topDay = top && p.total >= 4 && (choice.get(p.id) ?? 0) > 1
      ? { dow: top[0], n: top[1], share: top[1] / p.total }
      : null;
  }

  const totals = list.map((p) => p.total);
  return {
    people: list,
    idle: list.filter((p) => p.total === 0),
    min: totals.length ? Math.min(...totals) : 0,
    max: totals.length ? Math.max(...totals) : 0,
    spread: totals.length ? Math.max(...totals) - Math.min(...totals) : 0,
    // A planner cannot act on "0.78". They can act on "20 of Broad Two's 22 fall on the same weekday".
    concentrated: list.filter((p) => p.topDay && p.topDay.share >= 0.75),
  };
}

// How evenly the work is spread, counting proposals as if they were real. Kept as the narrow number the
// balancing test asserts on; rosterReview above is what a human reads.
export function workloadSpread(db, seasonId) {
  const rows = db.prepare(`
    SELECT p.id, COUNT(a.id) AS n
      FROM people p
      LEFT JOIN assignments a ON a.person_id = p.id
        AND a.session_id IN (SELECT id FROM sessions WHERE season_id = :sid)
     WHERE p.status = 'active'
     GROUP BY p.id`).all({ sid: seasonId });
  const counts = rows.map((r) => r.n);
  return { counts, min: Math.min(...counts), max: Math.max(...counts), spread: Math.max(...counts) - Math.min(...counts) };
}
