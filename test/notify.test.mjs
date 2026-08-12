// Increment E. The properties that matter are negative ones: a broken webhook must not break the app, the
// URL must never be logged, and the nudge must not turn into a weekly nag loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withLoopAlive } from "../tools/testkit.mjs";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db.mjs";
import { loadPattern, makeT, validatePattern, notifyTimingConfig } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { makeNotifier, notifyConfig, stubTransport, slotOpenMessage, nudgeMessage,
         shiftReminderMessage } from "../src/notify.mjs";
import { isoWeek, runNudge, volunteersNeedingNudge, startJobs, runShiftReminders } from "../src/jobs.mjs";
import { setAvailabilityDay } from "../src/queries.mjs";
import { listOutbox, renderOutbox } from "../src/pages/outbox.mjs";

const SECRET_URL = "https://chat.example.org/hooks/xxxxSECRETxxxx";
const t = makeT("en");

function world({ volunteers = 3 } = {}) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const people = seedPeople(db, seasonId, Array.from({ length: volunteers }, (_, i) => ({
    name: `Volunteer ${i + 1}`, contact: `v${i + 1}@example.org`, can: [pattern.activities[0].key],
  })));
  return { db, pattern, seasonId, people };
}

// ---- configuration ------------------------------------------------------------------------------------
test("with no webhook configured the channel is the outbox, not a crash", () => {
  assert.equal(notifyConfig({}).channel, "outbox");
  assert.equal(notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }).channel, "mattermost");
});

test("the config describes itself without ever revealing the URL", () => {
  const c = notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL });
  const described = c.describe();
  assert.ok(!described.includes("SECRET"), `describe() leaked the path: ${described}`);
  assert.ok(!described.includes("/hooks/"), `describe() leaked the path: ${described}`);
  assert.match(described, /chat\.example\.org/, "the host is useful and not the secret");
  assert.equal(notifyConfig({ MATTERMOST_WEBHOOK: "not a url" }).describe(), "mattermost(invalid-url)");
});

// ---- delivery -----------------------------------------------------------------------------------------
test("a message is delivered to the webhook and recorded as sent", async () => {
  const { db } = world();
  const { calls, fetchImpl } = stubTransport();
  const n = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }), fetchImpl });

  const r = await n.send({ kind: "slot_open", body: "a slot is open" });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, "a slot is open");
  const row = db.prepare("SELECT * FROM notifications WHERE id=?").get(r.id);
  assert.equal(row.status, "sent");
  assert.equal(row.channel, "mattermost");
});

test("a failing webhook returns not-ok, records the failure, and NEVER throws", async () => {
  const { db } = world();
  const logged = [];
  const { fetchImpl } = stubTransport({ fail: true });
  const n = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }), fetchImpl,
                           log: { warn: (m) => logged.push(m) } });

  const r = await n.send({ kind: "slot_open", body: "a slot is open" });   // must not reject
  assert.equal(r.ok, false);
  const row = db.prepare("SELECT * FROM notifications WHERE id=?").get(r.id);
  assert.equal(row.status, "failed", "a silently-broken webhook must be visible in the data, not only a log");
  assert.match(row.error, /network is down/);

  // The whole point: the log line must not carry the credential.
  assert.ok(logged.length === 1);
  assert.ok(!logged[0].includes("SECRET"), `the warning leaked the webhook URL: ${logged[0]}`);
  assert.ok(!logged[0].includes("/hooks/"), `the warning leaked the webhook path: ${logged[0]}`);
});

// The sibling sink this file used to check only half of. The test above asserts the LOG carries no credential;
// nothing asserted the same of `notifications.error`, which is the more exposed of the two — it is rendered on
// the outbox screen, so a credential landing there is shown to whoever opens it.
//
// Nothing observed leaks it: the timeout text names "the webhook", a non-2xx names only the status, undici's
// rejection is "fetch failed". So this drives the case that WOULD leak — a transport whose error message quotes
// the URL it was given, which is a perfectly ordinary thing for a transport to do — and requires the notifier to
// scrub rather than to be lucky about somebody else's wording.
test("a webhook URL never reaches the notifications row, even when the transport quotes it back", async () => {
  const { db } = world();
  const logged = [];
  // The kind of message a transport writes when it wants to be helpful.
  const fetchImpl = async (url) => { throw new Error(`connect ECONNREFUSED for ${url}`); };
  const n = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }), fetchImpl,
                           log: { warn: (m) => logged.push(m) } });

  const r = await n.send({ kind: "slot_open", body: "a slot is open" });
  assert.equal(r.ok, false);
  const row = db.prepare("SELECT * FROM notifications WHERE id=?").get(r.id);
  assert.equal(row.status, "failed");

  for (const [where, text] of [["the stored error", row.error], ["the log line", logged[0]],
                               ["the returned error", r.error]]) {
    assert.ok(!text.includes("SECRET"), `${where} leaked the webhook URL: ${text}`);
    assert.ok(!text.includes("/hooks/"), `${where} leaked the webhook path: ${text}`);
  }
  // And it must still be diagnosable — scrubbing that removes the reason is its own failure.
  assert.match(row.error, /ECONNREFUSED/, "the operator still has to be able to tell what went wrong");
  assert.match(row.error, /chat\.example\.org/, "and which host, since that is not the secret part");
});

// "already_sent" was returned for EVERY insert failure, not just the UNIQUE violation it names. runNudge reads
// only `ok`, so a genuine database rejection meant the volunteer was silently never nudged — no row, no log line,
// nothing in the data. A false explanation with a silent consequence, in the file whose opening argument is that
// a broken channel must be visible in the data.
test("only a duplicate is reported as already-sent; a real insert failure says so and is logged", async () => {
  const { db } = world();
  const { fetchImpl } = stubTransport();
  const logged = [];
  const n = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }), fetchImpl,
                           log: { warn: (m) => logged.push(m) } });

  // The real duplicate case, which must keep working: same kind, person and period twice.
  const first = await n.send({ kind: "availability_nudge", personId: 1, period: "2026-W20", body: "please answer" });
  assert.equal(first.ok, true);
  const again = await n.send({ kind: "availability_nudge", personId: 1, period: "2026-W20", body: "please answer" });
  assert.deepEqual(again, { ok: false, skipped: true, reason: "already_sent" });
  assert.equal(logged.length, 0, "a duplicate is normal and must not warn");

  // A different constraint failure entirely. The CHECK on `status` cannot be tripped through send(), so this
  // drops the table's NOT NULL on `body` in the way a botched migration would: rename the column out from under
  // the prepared statement. Any insert error that is not 2067 must take the honest path.
  db.exec("ALTER TABLE notifications RENAME TO notifications_gone");
  const broken = await n.send({ kind: "availability_nudge", personId: 2, period: "2026-W21", body: "please answer" });
  assert.equal(broken.ok, false);
  assert.equal(broken.skipped, false, "a database that refused the write has NOT already sent anything");
  assert.equal(broken.reason, "not_recorded");
  assert.equal(logged.length, 1, "and it is the only place this can surface, since there is no row to mark");
  assert.match(logged[0], /could not be recorded/);
  assert.ok(!logged[0].includes("SECRET"), "still no credential in the log");
});

test("without a webhook, messages queue in the outbox rather than vanishing", async () => {
  const { db } = world();
  const n = makeNotifier({ db, config: notifyConfig({}) });
  const r = await n.send({ kind: "slot_open", body: "a slot is open" });
  assert.equal(r.ok, true);
  assert.equal(r.queued, true);
  const row = db.prepare("SELECT * FROM notifications WHERE id=?").get(r.id);
  assert.equal(row.status, "queued");
  assert.equal(row.channel, "outbox");
});

// A hand-back INSIDE the deadline is a different fact from an ordinary opening, and the person who needs to know
// is the planner, not the volunteer who just handed it back. The banner asks that volunteer to tell the planner as
// well — asking a person to relay something the app already knows is the chasing this file exists to reduce — so
// the announcement carries it, in the channel planners already read.
test("a hand-back at short notice says so in the channel; an ordinary one reads exactly as before", () => {
  const tl = makeT("en");
  const label = loadPattern().activities[0].label;
  const args = { when: "4/1 15:00", activity: label, eligible: 3 };

  const ordinary = slotOpenMessage(tl, args);
  const urgent = slotOpenMessage(tl, { ...args, shortNotice: true });

  // The control, and it is the half that matters: the flag must CHANGE something. A test that only checks the
  // urgent case would pass on a build where every announcement says "short notice".
  assert.notEqual(urgent, ordinary, "the flag must change the message, or it is not wired to anything");
  assert.equal(ordinary, slotOpenMessage(tl, { ...args, shortNotice: false }),
    "and the default must be indistinguishable from not passing it at all");
  assert.ok(!/short notice/i.test(ordinary), `an ordinary opening must not claim urgency: "${ordinary}"`);
  assert.match(urgent, /short notice/i);

  // It must still be the whole announcement — a prefix that swallowed the slot details would leave a planner
  // knowing something is urgent and not which shift.
  assert.ok(urgent.includes(label), "the activity must survive");
  assert.match(urgent, /4\/1 15:00/, "and so must the time");
  assert.match(urgent, /3/, "and the count of people who could take it");
  assert.ok(!urgent.includes("{"), `unfilled placeholder: "${urgent}"`);

  // Both locales, because a Danish deployment reading an English urgency marker is the same defect.
  const da = slotOpenMessage(makeT("da"), { ...args, shortNotice: true });
  assert.ok(!/short notice/i.test(da), `the Danish message must be Danish: "${da}"`);
  assert.notEqual(da, slotOpenMessage(makeT("da"), args), "and the flag must work there too");
});

test("board announcements are not deduplicated with each other", async () => {
  const { db } = world();
  const { calls, fetchImpl } = stubTransport();
  const n = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }), fetchImpl });
  // person_id is NULL for these; SQLite treats NULLs in a UNIQUE index as distinct, which is exactly why
  // many slot announcements coexist while a per-person nudge collides with itself.
  for (let i = 0; i < 3; i++) assert.equal((await n.send({ kind: "slot_open", body: `slot ${i}` })).ok, true);
  assert.equal(calls.length, 3);
});

// ---- the nudge ----------------------------------------------------------------------------------------
test("ISO weeks are stable across a year boundary", () => {
  assert.equal(isoWeek("2026-01-01"), "2026-W01");
  assert.equal(isoWeek("2026-01-05"), "2026-W02");
  assert.equal(isoWeek("2025-12-29"), "2026-W01", "the last days of December belong to next year's week 1");
  assert.equal(isoWeek("2026-06-30"), "2026-W27");
});

test("only volunteers with unanswered dates are nudged", () => {
  const { db, seasonId, people, pattern } = world();
  const from = pattern.season.from;
  const to = "2026-02-01";
  const dates = db.prepare("SELECT DISTINCT date FROM sessions WHERE date BETWEEN ? AND ? ORDER BY date").all(from, to);
  assert.ok(dates.length > 2);

  // people[0] answers everything in the window; people[1] answers one date; people[2] answers nothing.
  for (const { date } of dates) setAvailabilityDay(db, people[0], date, true);
  setAvailabilityDay(db, people[1], dates[0].date, false);

  const need = volunteersNeedingNudge(db, seasonId, from, to).map((r) => r.id);
  assert.ok(!need.includes(people[0]), "a volunteer who answered every date must not be nudged");
  assert.ok(need.includes(people[1]), "a partial answer still leaves dates unanswered");
  assert.ok(need.includes(people[2]));
  // A 'no' counts as an answer — the nudge is about silence, not about saying yes.
  assert.equal(db.prepare("SELECT available FROM availability_day WHERE person_id=? AND date=?").get(people[1], dates[0].date).available, 0);
});

test("the nudge is idempotent per person per period, however often the job runs", async () => {
  const { db, seasonId, pattern } = world();
  const { calls, fetchImpl } = stubTransport();
  const notifier = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }), fetchImpl });
  const opts = { notifier, t, seasonId, today: pattern.season.from };

  const first = await runNudge(db, opts);
  assert.equal(first.sent.length, 3, "all three have answered nothing");
  const after = calls.length;

  const second = await runNudge(db, opts);
  assert.deepEqual(second.sent, [], "a second run in the same week must send nothing");
  assert.equal(calls.length, after, "and must not touch the transport at all");

  // A different period is a different reminder.
  const third = await runNudge(db, { ...opts, period: "2026-W99" });
  assert.equal(third.sent.length, 3);
  assert.equal(calls.length, after + 3);
});

test("an inactive volunteer is not nudged", async () => {
  const { db, seasonId, people, pattern } = world();
  db.prepare("UPDATE people SET status='inactive' WHERE id=?").run(people[0]);
  const need = volunteersNeedingNudge(db, seasonId, pattern.season.from, "2026-02-01").map((r) => r.id);
  assert.ok(!need.includes(people[0]));
});

test("a nudge that fails to deliver is not marked as sent, so the next run retries it", async () => {
  const { db, seasonId, pattern } = world({ volunteers: 1 });
  const { fetchImpl } = stubTransport({ fail: true });
  const notifier = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }), fetchImpl, log: {} });
  const r = await runNudge(db, { notifier, t, seasonId, today: pattern.season.from });
  assert.deepEqual(r.sent, [], "a failed delivery must not count as sent");
  assert.equal(db.prepare("SELECT status FROM notifications").get().status, "failed");
});

// A channel that never answers was the only outcome this file could not see: `fail: true` rejects, and a
// rejection was already handled. Node's fetch has no request timeout, so a hung Mattermost stalled send() for
// five minutes — and runNudge awaits one per volunteer, so nobody after the first got nudged, with nothing in
// the log and no row saying anything was wrong.
//
// The stub deliberately IGNORES the abort signal. Real fetch honours it, but the transport is injectable, so a
// timeout that depends on the transport cooperating is a timeout that can be bypassed by the next adapter.
test("a webhook that never answers is failed, not waited on forever", withLoopAlive(async () => {
  const { db, seasonId, pattern } = world({ volunteers: 2 });
  let aborts = 0;
  const fetchImpl = (url, opts) => {
    opts?.signal?.addEventListener?.("abort", () => { aborts++; });
    return new Promise(() => {});               // never settles, and never looks at the signal
  };
  const notifier = makeNotifier({ db, config: notifyConfig({ MATTERMOST_WEBHOOK: SECRET_URL }),
                                  fetchImpl, log: {}, timeoutMs: 50 });

  const started = process.hrtime.bigint();
  const r = await runNudge(db, { notifier, t, seasonId, today: pattern.season.from });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.deepEqual(r.sent, [], "nothing was delivered");
  assert.ok(ms < 2000, `runNudge must not hang: took ${ms.toFixed(0)}ms`);
  const rows = db.prepare("SELECT status, error FROM notifications ORDER BY id").all();
  assert.equal(rows.length, 2, "every volunteer was still attempted — the first hang must not end the loop");
  for (const row of rows) {
    assert.equal(row.status, "failed");
    assert.match(row.error, /did not answer within/, "the row must say WHY, since that is where an operator looks");
  }
  assert.equal(aborts, 2, "and the socket is released rather than left open");
}));

test("a slow tick is skipped rather than run twice over the same broken channel", async () => {
  const { db, seasonId, pattern } = world({ volunteers: 1 });
  let inFlight = 0, maxInFlight = 0;
  const slow = { send: async () => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 120));
    inFlight--;
    return { ok: true };
  } };
  const warned = [];
  const jobs = startJobs({ db, notifier: slow, t, seasonId, today: () => pattern.season.from,
                           everyMs: 60_000, log: { warn: (m) => warned.push(m), log: () => {} } });
  const [, second] = await Promise.all([jobs.tick(), jobs.tick()]);
  jobs.stop();

  assert.equal(maxInFlight, 1, "two runs must not overlap");
  assert.equal(second?.skipped, true, "the second tick reports that it stood down");
  assert.match(warned[0] ?? "", /has not finished/, "and says so, because a skipped nudge is worth knowing about");
});

test("the job timer swallows its own errors and does not hold the process open", async () => {
  const { db, seasonId, pattern } = world({ volunteers: 1 });
  const broken = { send: async () => { throw new Error("boom"); } };
  const warned = [];
  const jobs = startJobs({ db, notifier: broken, t, seasonId, today: () => pattern.season.from,
                           everyMs: 60_000, log: { warn: (m) => warned.push(m) } });
  await jobs.tick();                      // must not reject
  assert.equal(warned.length, 1);
  assert.match(warned[0], /nudge failed/);
  jobs.stop();
});

// /status reads `lastError` to decide whether the nudge job is healthy: `note: lastError ? "error" : null` and
// `level: lastError ? "bad"`. The success path clears it; the no-current-season path recorded a run and did NOT,
// which made that branch a one-way door. One transient failure, then a config season key naming a row nobody has
// created yet — which is every rollover — and the job stayed painted red forever on an instance where every tick
// since had been fine. Nothing short of a restart could clear it.
test("a healthy run with no current season clears an earlier failure rather than latching it", async () => {
  const { db, seasonId, pattern } = world({ volunteers: 1 });
  const broken = { send: async () => { throw new Error("boom"); } };
  let sid = seasonId;
  const jobs = startJobs({ db, notifier: broken, t, seasonId: () => sid, today: () => pattern.season.from,
                           everyMs: 60_000, log: { warn: () => {}, log: () => {} } });
  try {
    await jobs.tick();
    assert.match(jobs.state().lastError ?? "", /boom/, "precondition: the first tick really did fail");

    // Now the season key names nothing — the state at a rollover before the next season exists.
    sid = null;
    await jobs.tick();

    const s = jobs.state();
    assert.equal(s.lastError, null,
      "a tick that looked and found no season is a successful run, so /status must stop reporting a failure");
    assert.equal(s.lastSent, 0);
    assert.ok(s.lastRun !== null, "and it still counts as having run, or a live instance reads as a dead timer");
  } finally { jobs.stop(); }
});

// ---- the shift reminder --------------------------------------------------------------------------------
//
// src/calendar.mjs says missed shifts are the failure this app exists to prevent, and the answer until now was a
// calendar feed — which reaches exactly the volunteers who went and subscribed. These pin the two properties
// that make a reminder safe to run every few hours, plus the one that makes it worth sending at all.
const fmt = { formatDate: (t, d) => `on ${d}`, formatTime: (h, m) => `${h}:${String(m).padStart(2, "0")}`,
              formatRole: (t, r) => (r ? ` (${r})` : "") };

// This file's `world()` builds STRUCTURE only — seedStructure creates sessions, not the open assignment rows a
// volunteer occupies. That is fine for the nudge, which is about availability and needs no slots, and it is the
// exact shape of the defect that shipped once: sessions with no slots look like a populated plan and are
// unusable. So open them here, through the real function, rather than hand-inserting rows that might not match
// what production creates.
function withSlots(w) {
  if (!w._slots) { openEverySession(w.db, w.seasonId, w.pattern); w._slots = true; }
  return w;
}

function shift(w, { state = "confirmed", person = null, date = null } = {}) {
  withSlots(w);
  const row = w.db.prepare(`SELECT a.id, s.date FROM assignments a JOIN sessions s ON s.id = a.session_id
                             WHERE a.person_id IS NULL AND s.season_id = :sid ${date ? "AND s.date = :d" : ""}
                             ORDER BY s.date LIMIT 1`).get(date ? { sid: w.seasonId, d: date } : { sid: w.seasonId });
  assert.ok(row, "the fixture needs an open slot to assign");
  w.db.prepare("UPDATE assignments SET person_id = ?, state = ? WHERE id = ?").run(person, state, row.id);
  return row;
}

test("a volunteer is reminded of a confirmed shift, once, with a message that stands alone", async () => {
  const w = world();
  const me = w.people[0];
  const s = shift(w, { person: me });
  const notifier = makeNotifier({ db: w.db, config: notifyConfig({}), log: {} });   // outbox

  const first = await runShiftReminders(w.db, { notifier, t, seasonId: w.seasonId, today: s.date, daysBefore: 2, ...fmt });
  assert.deepEqual(first.sent, [s.id], "the shift starting today is within the window");

  const row = w.db.prepare("SELECT kind, person_id, period, body FROM notifications WHERE kind='shift_reminder'").get();
  assert.equal(row.person_id, me);
  assert.equal(row.period, `a${s.id}`, "keyed on the assignment, so two shifts on one evening both get a message");
  // It has to make sense with none of the app around it: a real date, the activity, and what to do instead.
  assert.match(row.body, new RegExp(s.date), "the date must be in the message");
  assert.ok(!/\bl\b|\bf\b/.test(row.body.replace(/[^\w\s]/g, " ").replace(/\bshift\b/g, "")) || /\(/.test(row.body),
    "a bare role code is not information");
  assert.match(row.body, /hand it back|læg den tilbage/i, "and it must say what to do if they cannot make it");

  // Run again — the job runs several times a day, and nobody wants four reminders for one shift.
  const second = await runShiftReminders(w.db, { notifier, t, seasonId: w.seasonId, today: s.date, daysBefore: 2, ...fmt });
  assert.deepEqual(second.sent, [], "a second run must send nothing");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind='shift_reminder'").get().n, 1);
});

test("a PROPOSED shift is never reminded about — that would be telling someone to show up for a guess",
  async () => {
  const w = world();
    const s = shift(w, { person: w.people[0], state: "proposed" });
    const notifier = makeNotifier({ db: w.db, config: notifyConfig({}), log: {} });
    const r = await runShiftReminders(w.db, { notifier, t, seasonId: w.seasonId, today: s.date, daysBefore: 2, ...fmt });
    assert.deepEqual(r.sent, [], "an auto-roster proposal is the planner thinking out loud");
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications").get().n, 0);
  });

test("the window is respected, and an inactive volunteer is left alone", async () => {
  const w = world();
  const dates = w.db.prepare(`SELECT DISTINCT date FROM sessions WHERE season_id=? ORDER BY date`)
    .all(w.seasonId).map((r) => r.date);
  const far = dates.at(-1);
  const s = shift(w, { person: w.people[0], date: far });
  const notifier = makeNotifier({ db: w.db, config: notifyConfig({}), log: {} });

  const early = await runShiftReminders(w.db, { notifier, t, seasonId: w.seasonId, today: dates[0], daysBefore: 2, ...fmt });
  assert.deepEqual(early.sent, [], "a shift months out is not due a reminder yet");

  // Deactivated between assignment and shift: no message.
  w.db.prepare("UPDATE people SET status='inactive' WHERE id=?").run(w.people[0]);
  const gone = await runShiftReminders(w.db, { notifier, t, seasonId: w.seasonId, today: far, daysBefore: 2, ...fmt });
  assert.deepEqual(gone.sent, [], "somebody who has left the roster must not be chased");

  w.db.prepare("UPDATE people SET status='active' WHERE id=?").run(w.people[0]);
  const due = await runShiftReminders(w.db, { notifier, t, seasonId: w.seasonId, today: far, daysBefore: 2, ...fmt });
  assert.deepEqual(due.sent, [s.id], "and once they are back and the date is close, it goes");
});

test("the tick runs both jobs, and says so without the formatters rather than skipping silently",
  async () => {
  const w = world();
    const s = shift(w, { person: w.people[0] });
    const notifier = makeNotifier({ db: w.db, config: notifyConfig({}), log: {} });
    const warned = [];

    // Without the formatters: reminders must NOT go out, and it must be loud. A reminder built from an ISO date
    // and a raw role code would be worse than none, and a silent skip is how the notifier stayed dead once.
    const bare = startJobs({ db: w.db, notifier, t, seasonId: w.seasonId, today: () => s.date,
                             everyMs: 60_000, log: { warn: (m) => warned.push(m), log: () => {} } });
    await bare.tick();
    bare.stop();
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind='shift_reminder'").get().n, 0);
    assert.ok(warned.some((m) => /formatters/.test(m)), `expected a warning, got ${JSON.stringify(warned)}`);

    // With them: one tick covers both jobs, and the reported count includes both.
    //
    // Counted as a DELTA across this tick, not as a total. `lastSent` is what the last run sent, and the first
    // tick above already delivered the week's nudges — so a cumulative count would be 4 against a lastSent of 1
    // and the test would be measuring the wrong thing while looking rigorous.
    const total = () => w.db.prepare("SELECT COUNT(*) n FROM notifications").get().n;
    const before = total();
    const jobs = startJobs({ db: w.db, notifier, t, seasonId: w.seasonId, today: () => s.date,
                             everyMs: 60_000, log: {}, ...fmt });
    await jobs.tick();
    jobs.stop();

    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind='shift_reminder'").get().n, 1,
      "the reminder went out through the timer, not only through a direct call");
    assert.equal(jobs.state().lastSent, total() - before,
      "/status reports one number per tick, so it must count every kind that tick sent");
    assert.ok(jobs.state().lastSent >= 1, "and this tick did send something");
  });

test("remindDaysBefore comes from config, and zero means same-day rather than the default", () => {
  const base = loadPattern();
  assert.equal(notifyTimingConfig({}).remindDaysBefore, 2, "absent means the default");
  assert.equal(notifyTimingConfig({ notify: { remindDaysBefore: 0 } }).remindDaysBefore, 0,
    "zero is a real setting — `|| 2` would silently turn it into two days");
  assert.equal(notifyTimingConfig({ notify: { remindDaysBefore: 5 } }).remindDaysBefore, 5);
  for (const bad of [-1, 15, 1.5, "2", null]) {
    assert.throws(() => validatePattern({ ...base, notify: { remindDaysBefore: bad } }), /remindDaysBefore/,
      `${JSON.stringify(bad)} must be refused`);
  }
  assert.throws(() => validatePattern({ ...base, notify: 2 }), /notify must be an object/);
});

// ---- message bodies ----------------------------------------------------------------------------------
test("message bodies fill their placeholders in both locales", () => {
  // The label comes from config, not a literal — test/ is subject to the same no-hardcoding rule as src/,
  // and the seams gate caught the first version of this test writing the activity name inline.
  const label = loadPattern().activities[0].label;
  for (const locale of ["da", "en"]) {
    const tl = makeT(locale);
    const slot = slotOpenMessage(tl, { when: "4/1 15:00", activity: label, eligible: 3 });
    assert.ok(!slot.includes("{"), `${locale}: unfilled placeholder in "${slot}"`);
    assert.ok(slot.includes(label), `${locale}: the activity should be named: ${slot}`);
    assert.match(slot, /3/);

    const nudge = nudgeMessage(tl, { name: "Volunteer 1", from: "2026-01-01", to: "2026-01-29" });
    assert.ok(!nudge.includes("{"), `${locale}: unfilled placeholder in "${nudge}"`);
    assert.match(nudge, /Volunteer 1/);
  }
});

test("an unknown placeholder is left visible rather than blanked", () => {
  const tl = makeT("en");
  assert.match(tl("notify.nudge", { name: "X" }), /\{from\}/, "a missing value should be obvious, not silent");
});

// ---- the outbox (increment T) ----------------------------------------------------------------------------
// The gap this closes: with MATTERMOST_WEBHOOK unset — the DEFAULT — every message is written with
// status 'queued' and delivered to nobody, and there was no way to read one. /status could say "23 queued"
// and that was the whole story: the app composed text no human could ever see, while the planner believed
// the volunteers had been nudged.
test("the outbox shows undelivered messages first, whatever order they were written in", async () => {
  const w = world();
  const notifier = makeNotifier({ db: w.db, config: notifyConfig({}), fetchImpl: stubTransport() });
  await notifier.send({ kind: "availability_nudge", personId: w.people[0], period: "2026-W20", body: "first, queued" });
  // A sent one written LATER must still sort after the queued one — newest-first would bury the actionable row.
  w.db.prepare("INSERT INTO notifications (kind, person_id, channel, body, status, created_at) VALUES ('slot_open', NULL, 'mattermost', 'later, sent', 'sent', '2026-05-20T10:00:00Z')").run();
  w.db.prepare("INSERT INTO notifications (kind, person_id, channel, body, status, error, created_at) VALUES ('slot_open', NULL, 'mattermost', 'later, failed', 'failed', 'connect ECONNREFUSED', '2026-05-20T11:00:00Z')").run();

  const out = listOutbox(w.db);
  assert.deepEqual(out.rows.map((r) => r.status), ["queued", "failed", "sent"],
    "queued needs a human, failed needs a look at the webhook, sent is history");
  assert.deepEqual(out.counts, { queued: 1, failed: 1, sent: 1 });
  assert.equal(out.total, 3);
  assert.equal(out.truncated, 0);
  // A board announcement has no person; it must read as "everyone", not as a blank.
  assert.equal(out.rows.find((r) => r.body === "later, sent").person, null);
  assert.equal(out.rows.find((r) => r.status === "queued").person, "Volunteer 1");
  assert.match(out.rows.find((r) => r.status === "failed").error, /ECONNREFUSED/);
  w.db.close();
});

test("the outbox says so when nothing was actually delivered, and does not touch the webhook URL", () => {
  const w = world();
  w.db.prepare("INSERT INTO notifications (kind, person_id, channel, body, status, created_at) VALUES ('availability_nudge', NULL, 'outbox', 'please answer', 'queued', '2026-05-20T10:00:00Z')").run();
  const outbox = listOutbox(w.db);

  const undelivered = renderOutbox({ t, roles: ["planner"], who: "P", outbox, webhookConfigured: false }).__raw;
  // Scoped to the rows still marked not-sent. The first version of this asserted "nothing here was actually
  // delivered", which the page can disprove by itself: remove a webhook, or keep older history, and there are
  // 'sent' rows in the list right underneath the banner.
  assert.match(undelivered, /was not delivered to anyone/, "silence about this is how a planner assumes people were told");
  assert.match(undelivered, /please answer/, "the body is the point of the page");

  // With a webhook configured the warning goes away — and either way the URL is never in the page, because it
  // never reaches the render function at all.
  const delivered = renderOutbox({ t, roles: ["planner"], who: "P", outbox, webhookConfigured: true }).__raw;
  assert.ok(!/was not delivered to anyone/.test(delivered));
  for (const page of [undelivered, delivered]) {
    assert.ok(!page.includes("SECRET"), "a webhook URL must never reach the outbox page");
    assert.ok(!page.includes("/hooks/"));
  }
  w.db.close();
});

test("the outbox filters by status, and reports what it did not show", () => {
  const w = world();
  const ins = w.db.prepare("INSERT INTO notifications (kind, person_id, channel, body, status, created_at) VALUES ('slot_open', NULL, 'outbox', :b, :s, '2026-05-20T10:00:00Z')");
  for (let i = 0; i < 5; i++) ins.run({ b: `q${i}`, s: "queued" });
  for (let i = 0; i < 3; i++) ins.run({ b: `s${i}`, s: "sent" });

  const queued = listOutbox(w.db, { status: "queued" });
  assert.equal(queued.rows.length, 5);
  assert.ok(queued.rows.every((r) => r.status === "queued"));
  assert.equal(queued.counts.sent, 3, "the counts describe everything, not just the filtered view");

  // Truncation must be stated. A page showing 2 of 8 without saying so reads as "that is all of them", which
  // is exactly the false reassurance this whole page exists to remove.
  const capped = listOutbox(w.db, { limit: 2 });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.truncated, 6);
  assert.match(renderOutbox({ t, roles: ["planner"], who: "P", outbox: capped, webhookConfigured: true }).__raw,
    /6 older messages are not shown/);
  w.db.close();
});

// The banner used to say "nothing here was actually delivered" whenever no webhook was configured. But the page
// can show 'sent' rows from a period when one existed — remove the webhook, or keep older history, and the
// banner contradicts the list directly beneath it, where rows are plainly marked Sent. It now claims only what
// is true regardless of history: the ones still marked not-sent went nowhere.
test("the no-webhook banner does not contradict the rows underneath it", () => {
  const w = world();
  const ins = w.db.prepare(`INSERT INTO notifications (kind, person_id, channel, body, status, created_at)
                            VALUES ('slot_open', NULL, ?, ?, ?, '2026-05-20T10:00:00Z')`);
  ins.run("mattermost", "this one really did go out", "sent");
  ins.run("outbox", "this one did not", "queued");

  const page = renderOutbox({ t, roles: ["planner"], who: "P", outbox: listOutbox(w.db), webhookConfigured: false }).__raw;
  assert.match(page, /Sent/, "a delivered row is on the page");
  assert.ok(!/nothing here was actually delivered/.test(page),
    "so the banner must not claim otherwise — it would be visibly wrong on its own page");
  assert.match(page, /still marked/, "it names the rows it is actually talking about");
  w.db.close();
});

// ---- the claim link (increment AI) -----------------------------------------------------------------------
// §3a of the discovery spec says the board announcement reads "Sun 15:00 Salsa is open, 3 qualified" WITH A
// CLAIM LINK. It was never built. All three messages named a screen — "the shift exchange", "your
// availability" — that the reader had no way to reach except by remembering a hostname, in a chat channel
// away from the app. The entire argument for posting into Mattermost is that it meets people where they
// already are; a message that then asks them to go and find the app themselves moves the chasing rather than
// reducing it.
test("every notification carries a link when the deployment knows its own address", () => {
  const tl = makeT("en");
  const label = loadPattern().activities[0].label;
  const base = "https://plan.example.org";
  const messages = {
    "notify.slotOpen": slotOpenMessage(tl, { when: "4/1 15:00", activity: label, eligible: 3, publicUrl: base }),
    "notify.nudge": nudgeMessage(tl, { name: "Volunteer 1", from: "2026-01-01", to: "2026-01-29", publicUrl: base }),
    "notify.shiftReminder": shiftReminderMessage(tl, { name: "Volunteer 1", when: "4/1 15:00", activity: label, publicUrl: base }),
  };
  for (const [key, body] of Object.entries(messages)) {
    assert.ok(body.includes(base), `${key} must carry the address: "${body}"`);
    // A path, not a bare origin: "go to plan.example.org" is the same instruction as before, just typed out.
    const link = body.split("\n").find((l) => l.includes(base));
    assert.match(link, /https:\/\/plan\.example\.org\/\w+$/, `${key}: the link must end at a real screen: "${link}"`);
    assert.ok(!body.includes("{"), `${key}: unfilled placeholder in "${body}"`);
    // The link is a SEPARATE line. A URL run together with prose is what mail clients mangle.
    assert.ok(body.split("\n").length >= 2, `${key}: the link belongs on its own line`);
  }
  // And they point at the right screens: the two board messages at the exchange, the nudge at availability.
  assert.match(messages["notify.slotOpen"], /\/board/);
  assert.match(messages["notify.shiftReminder"], /\/board/);
  assert.match(messages["notify.nudge"], /\/availability/);
});

test("and with no address configured, the messages are exactly what they were before", () => {
  const tl = makeT("en");
  const label = loadPattern().activities[0].label;
  // Every builder must default publicUrl to null, not undefined-into-a-template. The old behaviour is the
  // documented behaviour for a deployment that has not set FOURWATER_BASE_URL yet.
  for (const body of [
    slotOpenMessage(tl, { when: "4/1 15:00", activity: label, eligible: 3 }),
    nudgeMessage(tl, { name: "V", from: "2026-01-01", to: "2026-01-29" }),
    shiftReminderMessage(tl, { name: "V", when: "4/1 15:00", activity: label }),
  ]) {
    assert.equal(body.split("\n").length, 1, `no address means no extra line: "${body}"`);
    assert.ok(!/https?:|null|undefined/.test(body), `nothing half-rendered may leak: "${body}"`);
  }
});

// The builders are the easy half. What matters is whether the WEBHOOK BODY carries the link, because that is
// the text a volunteer reads — and until this increment the answer was no even though the strings existed.
test("the link reaches the webhook body, end to end, from the environment alone", async () => {
  const w = world();
  const s = shift(w, { person: w.people[0] });
  const { calls, fetchImpl } = stubTransport();
  const cfg = notifyConfig({ MATTERMOST_WEBHOOK: "https://chat.example/hooks/abc",
                             FOURWATER_BASE_URL: "https://plan.example.org/" });
  assert.equal(cfg.publicUrl, "https://plan.example.org", "a trailing slash must not survive into every message");
  const notifier = makeNotifier({ db: w.db, config: cfg, fetchImpl, log: {} });

  const r = await runShiftReminders(w.db, { notifier, t, seasonId: w.seasonId, today: s.date, daysBefore: 2, ...fmt });
  assert.deepEqual(r.sent, [s.id], "the fixture must actually produce a reminder, or this test asserts nothing");
  assert.equal(calls.length, 1, "and it must actually reach the transport");
  assert.match(calls[0].body, /https:\/\/plan\.example\.org\/board/,
    "the volunteer reads the webhook body, not the message builder");
  w.db.close();
});
