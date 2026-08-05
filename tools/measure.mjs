// `node tools/measure.mjs` — the scale figures in PLAN.md, produced rather than remembered.
//
// It exists because attendance, the audit log and public holidays had never been measured at all: PLAN.md's figures
// were taken at 200 volunteers and re-taken after roles doubled the assignment rows, and three features landed after
// that. Kept as a tool rather than a test because it takes seconds, prints numbers rather than asserting them, and
// the point of a number is to be read by a person deciding whether to worry.
//
// What could plausibly be slow, written down first so the numbers are looked FOR rather than admired:
//   - the Administration screen calls sessionsOnDate() once per holiday, for every holiday and not only the
//     opted-in ones;
//   - the audit page resolves every `person:`/`assignment:` reference on it through describeAudit();
//   - the planner grid gained unmarkedShifts() and an `attended` sum inside rosterReview;
//   - pruneAudit() sweeps the whole table on a nightly job.
//
// ⚠ THE FIXTURE IS THE HARD PART, and three of the seven figures were measurements of nothing on the first run: the
// backlog card had no backlog because every past shift was marked, the prune removed nothing because all 5,000 rows
// sat inside the retention window, and the holiday lookups found no sessions because the season had been seeded with
// suppression already on. That last one is worth remembering — the fixture said `{ ...loadPattern(), season: {...} }`
// under a comment claiming "no country", and the repository's config now HAS one, so the spread carried it in.
// Omitting a key from a spread does not remove it. A fast measurement of an empty input reads exactly like a fast
// measurement, so every figure below prints its own row count next to the time.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "../src/db.mjs";
import { loadPattern, makeT } from "../src/config.mjs";
import { seedSeason, seedPeople } from "../src/seed.mjs";
import { setAvailabilityDay, markAttendance, unmarkedShifts } from "../src/queries.mjs";
import { rosterReview, autoRoster } from "../src/roster.mjs";
import { recordAudit, listAudit, countAudit, describeAudit } from "../src/audit.mjs";
import { renderAudit } from "../src/pages/audit.mjs";
import { holidayConfig, holidaysBetween } from "../src/holidays.mjs";
import { sessionsOnDate } from "../src/admin.mjs";
import { pruneAudit, retentionConfig } from "../src/retention.mjs";
import { countQueries } from "./testkit.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "4water-measure-"));
const file = path.join(dir, "big.db");
const db = new DatabaseSync(file);
migrate(db);

// A season the size the spec describes, spanning today so the future/past split is exercised both ways.
const base = loadPattern();
const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
const to = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
// Seeded with holidays EXPLICITLY OFF, so the holiday dates get sessions — the retrofit state, and the only state
// in which the admin screen has anything to count. Two attempts at this were wrong: the first configured DK and
// measured lookups against empty dates; the second said "no country" in a comment while `{...base}` quietly carried
// `holidays.country: "DK"` in from config/pattern.json, because the repository's config now has one. Omitting a key
// from a spread does not remove it, and the comment claiming otherwise is exactly the kind of prose this project
// keeps catching.
// A BUSIER week than Copenhagen's, to land on the same order as the record's second measurement (380 sessions, 586
// slots) rather than reporting figures from a smaller season beside them. Copenhagen runs two evenings; this runs
// five, with the same activities.
const busier = base.weekly.flatMap((w) => [1, 2, 3, 4, 5].map((dow) => ({ ...w, dayOfWeek: dow })));
const pattern = { ...base, weekly: busier, season: { key: "measure", from, to }, holidays: {} };
const withHolidays = { ...pattern, holidays: { country: "DK", extra: [] } };

const t0 = Date.now();
const { seasonId } = seedSeason(db, pattern);
const NAMES = Array.from({ length: 200 }, (_, i) => ({
  name: `Volunteer ${i + 1}`, contact: `v${i + 1}@example.invalid`,
  preferredRole: ["l", "f", "b"][i % 3],
  can: [pattern.activities[i % pattern.activities.length].key,
        pattern.activities[(i + 1) % pattern.activities.length].key],
}));
const people = seedPeople(db, seasonId, NAMES);
const dates = db.prepare("SELECT DISTINCT date FROM sessions WHERE season_id=? ORDER BY date").all(seasonId).map((r) => r.date);
db.exec("BEGIN");
for (const p of people) for (const d of dates) setAvailabilityDay(db, p, d, true);
db.exec("COMMIT");
console.log(`seeded in ${Date.now() - t0}ms: ${people.length} people, ${dates.length} dates, ` +
  `${db.prepare("SELECT COUNT(*) n FROM sessions").get().n} sessions, ` +
  `${db.prepare("SELECT COUNT(*) n FROM assignments").get().n} slots, ` +
  `${db.prepare("SELECT COUNT(*) n FROM availability_day").get().n} availability rows`);

// Fill the season, then mark attendance on everything that has already happened — the state a planner reaches
// after a term of using this.
const r = autoRoster(db, { seasonId, fromDate: from });
const past = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                          WHERE s.season_id=? AND s.date < ? AND a.person_id IS NOT NULL`).all(seasonId, today);
db.exec("BEGIN");
db.prepare("UPDATE assignments SET state='confirmed' WHERE state='proposed'").run();
// A THIRD marked, two thirds not. Marking everything left the backlog card empty and measured the zero-row case —
// and a planner who has marked everything is not the planner this card exists for.
let marked = 0;
for (const [i, row] of past.entries()) {
  if (i % 3 !== 0) continue;
  if (markAttendance(db, row.id, i % 7 === 0 ? 0 : 1, { today }).ok) marked++;
}
db.exec("COMMIT");
console.log(`auto-roster filled ${r.filled}, gaps ${r.gaps}; ${marked} of ${past.length} past slots marked, ` +
  `${past.length - marked} left for the backlog`);

// An audit log after a couple of seasons of use: two years of planner activity at a few actions a day.
const AUDIT_ROWS = 5000;
db.exec("BEGIN");
for (let i = 0; i < AUDIT_ROWS; i++) {
  recordAudit(db, {
    actorId: people[i % people.length], actorName: `Volunteer ${(i % people.length) + 1}`,
    action: ["planner.assign", "planner.unassign", "planner.attendance", "admin.role", "admin.status"][i % 5],
    subject: `assignment:${past[i % past.length]?.id ?? 1}`,
    detail: `person:${people[(i * 7) % people.length]} on ${dates[i % dates.length]}`,
    // Spread over THREE YEARS so some rows fall outside the 730-day window. At one hour apart they all landed
    // inside it, and the prune measurement was of a no-op reported as "removed 0".
    at: new Date(Date.now() - i * 5.25 * 3600_000),
  });
}
db.exec("COMMIT");
console.log(`audit rows: ${countAudit(db)}`);

const time = (label, fn) => {
  const counter = countQueries(db);
  const start = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`  ${label.padEnd(42)} ${ms.toFixed(1).padStart(7)} ms   ${String(counter.n).padStart(4)} queries` +
    (out === undefined ? "" : `   ${out}`));
  return out;
};

const t = makeT("en");
console.log("\n--- the audit page ---");
time("listAudit (one page of 100)", () => `${listAudit(db).length} rows`);
const rows = listAudit(db);
time("describeAudit (resolve every reference)", () => `${describeAudit(db, rows).size} labels`);
const labels = describeAudit(db, rows);
time("renderAudit HTML", () => {
  const html = renderAudit({ t, session: { csrf: "x" }, roles: ["admin"], who: "A", rows, labels,
                             total: countAudit(db), retentionDays: 730, older: { at: rows.at(-1).at, id: rows.at(-1).id } }).__raw;
  return `${(html.length / 1024).toFixed(0)} KB`;
});

console.log("\n--- the administration screen's holiday section ---");
const hcfg = holidayConfig(withHolidays);
const holidays = time("holidaysBetween (whole season)", () => `${holidaysBetween(from, to, hcfg).length} holidays`);
time("sessionsOnDate for every holiday", () => {
  const list = holidaysBetween(from, to, hcfg);
  let slots = 0;
  for (const h of list) slots += sessionsOnDate(db, seasonId, h.date).slots;
  return `${list.length} lookups, ${slots} slots`;
});

console.log("\n--- the planner grid's new parts ---");
time("unmarkedShifts (the backlog card)", () => `${unmarkedShifts(db, seasonId, today).length} rows`);
time("rosterReview (now sums attended too)", () => {
  const rev = rosterReview(db, seasonId);
  return `${rev.people.length} people, spread ${rev.spread}`;
});

console.log("\n--- the nightly retention job ---");
time("pruneAudit over 5000 rows", () => {
  const cfg = retentionConfig(withHolidays);
  return `removed ${pruneAudit(db, { olderThanDays: cfg.auditDays }).removed}`;
});

db.close();
rmSync(dir, { recursive: true, force: true });
