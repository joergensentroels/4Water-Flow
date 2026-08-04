// Increment E. The properties that matter are negative ones: a broken webhook must not break the app, the
// URL must never be logged, and the nudge must not turn into a weekly nag loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db.mjs";
import { loadPattern, makeT } from "../src/config.mjs";
import { seedStructure, seedPeople } from "../src/seed.mjs";
import { makeNotifier, notifyConfig, stubTransport, slotOpenMessage, nudgeMessage } from "../src/notify.mjs";
import { isoWeek, runNudge, volunteersNeedingNudge, startJobs } from "../src/jobs.mjs";
import { setAvailabilityDay } from "../src/queries.mjs";

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
