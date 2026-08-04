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

// How evenly the work is spread, counting proposals as if they were real. Used by the tests to show that
// balancing actually balances, and worth keeping: "it feels fairer" is not a claim anyone can check.
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
