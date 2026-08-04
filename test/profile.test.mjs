// Increment O. The status page exists because a season entirely in the past looks IDENTICAL to a broken app —
// every screen empty-states politely and nothing says why. That is the fact it must surface first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeWorld, makeAvailableEverywhere, csrfFromCookie } from "../tools/testkit.mjs";
import { myProfile, saveProfile } from "../src/pages/profile.mjs";
import { collectStatus, renderStatus } from "../src/pages/status.mjs";
import { makeT } from "../src/config.mjs";
import { assignSlot, setAvailabilityDay } from "../src/queries.mjs";
import { startJobs } from "../src/jobs.mjs";

const withWorld = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["planner"] }, ...opts });
  try { await fn(w); } finally { w.close(); }
};
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");
const factFor = (status, key) => status.facts.find((f) => f.key === key);

// ---- profile ------------------------------------------------------------------------------------------
test("a volunteer can see what the system believes about them", withWorld({}, async (w) => {
  const me = myProfile(w.db, w.people[1], w.seasonId);
  assert.equal(me.person.name, "Volunteer 2");
  assert.ok(me.capabilities.length > 0, "which activities they are down for");
  assert.equal(me.answered, 0);
  assert.ok(me.datesInSeason > 0, "and how many dates there are to answer");

  setAvailabilityDay(w.db, w.people[1], w.pattern.season.from, true);
  assert.equal(myProfile(w.db, w.people[1], w.seasonId).answered, 1);

  const cookie = await w.signIn(w.people[1]);
  const body = await (await w.get("/me", cookie)).text();
  assert.match(body, /Volunteer 2/);
  assert.match(body, /answered 1 of|svaret på 1 af/);
  assert.match(body, /href="\/me\/export\.json"/, "portability without asking an admin");
  assert.match(body, /href="\/privacy"/);
}));

test("a volunteer can correct their own name and contact", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[1]);
  const { token } = await w.csrfFrom("/me", cookie);
  const r = await w.post("/me", cookie, new URLSearchParams({ csrf: token, name: "Corrected Name", contact: "new@example.org" }));
  assert.equal(reasonOf(r), "saved");
  const row = w.db.prepare("SELECT name, contact FROM people WHERE id=?").get(w.people[1]);
  assert.equal(row.name, "Corrected Name");
  assert.equal(row.contact, "new@example.org");
}));

test("the profile form has no person field, and a forged one is ignored", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[1]);
  const { token, body } = await w.csrfFrom("/me", cookie);
  assert.ok(!/name="personId"/.test(body), "the person must come from the session");

  const form = new URLSearchParams({ csrf: token, name: "Hijacked", contact: "" });
  form.set("personId", String(w.people[0]));
  form.set("id", String(w.people[0]));
  await w.post("/me", cookie, form);
  assert.equal(w.db.prepare("SELECT name FROM people WHERE id=?").get(w.people[0]).name, "Volunteer 1",
    "a forged id must not rename somebody else");
  assert.equal(w.db.prepare("SELECT name FROM people WHERE id=?").get(w.people[1]).name, "Hijacked");
}));

test("profile edits are validated, and nothing is written when they fail", withWorld({}, async (w) => {
  assert.deepEqual(saveProfile(w.db, w.people[1], { name: "  ", contact: "a@b.c" }), { ok: false, reason: "name_required" });
  assert.deepEqual(saveProfile(w.db, w.people[1], { name: "Fine", contact: "not-an-email" }), { ok: false, reason: "bad_contact" });
  // A contact address is how an invite finds someone, so it has to stay unique.
  assert.deepEqual(saveProfile(w.db, w.people[1], { name: "Fine", contact: "v1@example.org" }), { ok: false, reason: "contact_taken" });
  assert.equal(w.db.prepare("SELECT name FROM people WHERE id=?").get(w.people[1]).name, "Volunteer 2", "no partial write");

  // Clearing the address is allowed — not everyone has one.
  assert.equal(saveProfile(w.db, w.people[1], { name: "Fine", contact: "" }).ok, true);
  assert.equal(w.db.prepare("SELECT contact FROM people WHERE id=?").get(w.people[1]).contact, null);
}));

test("a volunteer cannot grant themselves a capability from their profile", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[1]);
  const { token, body } = await w.csrfFrom("/me", cookie);
  // Capabilities are somebody else's judgement; self-service here would make the eligibility rule meaningless.
  assert.ok(!/action="\/admin\/capability"/.test(body), "the profile must not offer capability editing");
  const before = w.db.prepare("SELECT COUNT(*) n FROM capabilities WHERE person_id=?").get(w.people[1]).n;
  const form = new URLSearchParams({ csrf: token, name: "Volunteer 2", contact: "" });
  form.set("capability", w.pattern.activities[2].key);
  await w.post("/me", cookie, form);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM capabilities WHERE person_id=?").get(w.people[1]).n, before);
}));

// ---- status -------------------------------------------------------------------------------------------
test("a season that has ENDED is reported as the reason the plan looks empty", withWorld({}, async (w) => {
  // The clock past the season's end — which is the real situation on this project right now.
  const after = new Date(Date.parse(`${w.pattern.season.to}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const status = collectStatus(w.db, { pattern: w.pattern, today: after, backupDir: null });
  const season = factFor(status, "season");
  assert.equal(season.level, "bad");
  assert.equal(season.note, "ended");
  assert.equal(status.facts[0].key, "season", "it must be the FIRST fact — it explains all the others");
}));

test("a current and a future season are distinguished", withWorld({}, async (w) => {
  const during = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: null });
  assert.equal(factFor(during, "season").level, "ok");
  assert.equal(factFor(during, "season").note, "current");

  const before = new Date(Date.parse(`${w.pattern.season.from}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
  const early = collectStatus(w.db, { pattern: w.pattern, today: before, backupDir: null });
  assert.equal(factFor(early, "season").note, "future");
  assert.equal(factFor(early, "season").level, "warn", "not yet started is a warning, not a fault");
}));

test("gap severity is proportional, not a raw count", withWorld({}, async (w) => {
  const all = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: null });
  assert.equal(factFor(all, "gaps").level, "bad", "everything unfilled is a problem");

  // Fill everything that CAN be filled. Note what is unreachable here: each timeslot carries two activities
  // and these volunteers are capable of one, so a single person can never take both — the double-booking rule
  // makes "no gaps at all" impossible in this world. The first version of this test asserted "ok" and failed
  // for exactly that reason, which is the rule working rather than the status page being wrong.
  for (const p of w.people) makeAvailableEverywhere(w.db, p, w.pattern.season.from);
  for (const row of w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                                  WHERE a.person_id IS NULL ORDER BY s.date`).all()) {
    for (const p of w.people) if (assignSlot(w.db, row.id, p, { expectPersonId: null }).ok) break;
  }
  const filled = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: null });
  assert.ok(factFor(filled, "gaps").value < factFor(all, "gaps").value, "the count must fall");
  assert.notEqual(factFor(filled, "gaps").level, "bad", "and the verdict must soften with it");

  // And the thresholds themselves, on the numbers rather than through a world that cannot reach every state:
  // proportional, so 30 unfilled out of 30 is a fault and 30 out of 3000 is not.
  const ratioLevel = (gaps, upcoming) =>
    upcoming === 0 || gaps === 0 ? "ok" : gaps / upcoming > 0.5 ? "bad" : gaps / upcoming > 0.2 ? "warn" : "ok";
  assert.equal(ratioLevel(30, 30), "bad");
  assert.equal(ratioLevel(10, 30), "warn");
  assert.equal(ratioLevel(1, 30), "ok");
  assert.equal(ratioLevel(0, 0), "ok", "an empty month is not a fault");
}));

test("silence is counted, and a failed notification is an alarm while a queued one is not", withWorld({}, async (w) => {
  const s1 = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: null });
  assert.equal(factFor(s1, "silent").value, 3, "nobody has answered yet");

  makeAvailableEverywhere(w.db, w.people[0], w.pattern.season.from);
  const s2 = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: null });
  assert.equal(factFor(s2, "silent").value, 2);

  const insert = (status) => w.db.prepare(`INSERT INTO notifications (kind, person_id, period, channel, body, status, created_at)
                                            VALUES ('slot_open', NULL, NULL, 'mattermost', 'x', ?, ?)`)
    .run(status, new Date().toISOString());
  insert("queued"); insert("queued"); insert("failed");
  const s3 = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: null });
  assert.equal(factFor(s3, "failed").level, "bad", "a message that could not be sent needs attention");
  assert.equal(factFor(s3, "queued").value, 2);
  assert.equal(factFor(s3, "queued").level, "ok", "with no webhook configured, queueing is the design");
}));

// The fact this page most needed and did not have. The nudge job never ran once in production for most of this
// project's life and no screen could have said so, because a job with nobody to nudge and a job that is dead
// both produce silence. These pin the readings, and the one that matters most is "ran, sent nothing" being
// HEALTHY — get that wrong and the page cries wolf at a perfectly-behaved instance every day.
test("the nudge job's own account of itself is reported, and doing nothing is not a fault", withWorld({}, async (w) => {
  const base = { pattern: w.pattern, today: w.pattern.season.from, backupDir: null };
  const at = Date.parse("2026-08-04T12:00:00Z");
  const jobsWith = (state) => ({ state: () => ({ everyMs: 6 * 3600_000, ...state }) });

  // Not wired at all: no line, the same way an invite-only deployment has no OIDC line. The other half of that
  // — it MUST be there on a real boot — is asserted in test/journey.test.mjs, which is where being forgotten
  // would actually be caught.
  assert.equal(factFor(collectStatus(w.db, base), "nudge"), undefined);

  // Just started and not yet ticked. The boot tick is five seconds in, so this is "not yet", not "broken".
  const young = factFor(collectStatus(w.db, { ...base, now: at,
    jobs: jobsWith({ startedAt: at - 10_000, lastRun: null }) }), "nudge");
  assert.equal(young.level, "ok", "ten seconds after boot, never-run is normal");

  // Up for an hour and still never run: the timer is not wired. This is the state that was invisible.
  const dead = factFor(collectStatus(w.db, { ...base, now: at,
    jobs: jobsWith({ startedAt: at - 3600_000, lastRun: null }) }), "nudge");
  assert.equal(dead.level, "bad", "an hour up with no run means the job is not running");
  assert.equal(dead.note, "never");

  // Ran, sent nothing. THE case that must read as healthy: everyone answered.
  const quiet = factFor(collectStatus(w.db, { ...base, now: at,
    jobs: jobsWith({ startedAt: at - 3600_000, lastRun: at - 600_000, lastSent: 0 }) }), "nudge");
  assert.equal(quiet.level, "ok", "nothing to send is success, not silence");
  assert.equal(quiet.value, 10, "and it reports how long ago, in minutes");
  assert.equal(quiet.detail, 0);

  // Two intervals without a run: stalled.
  const stalled = factFor(collectStatus(w.db, { ...base, now: at,
    jobs: jobsWith({ startedAt: at - 40 * 3600_000, lastRun: at - 13 * 3600_000, lastSent: 2 }) }), "nudge");
  assert.equal(stalled.level, "warn", "past two intervals the timer has stopped");

  // And a run that threw.
  const broke = factFor(collectStatus(w.db, { ...base, now: at,
    jobs: jobsWith({ startedAt: at - 3600_000, lastRun: at - 60_000, lastError: "boom" }) }), "nudge");
  assert.equal(broke.level, "bad");
  assert.equal(broke.note, "error");

  // Each reading must render as its own sentence — a fact that collects but never renders is not reported.
  const t = makeT("en");
  for (const [state, expect] of [
    [{ startedAt: at - 3600_000, lastRun: null }, /has not run once/],
    [{ startedAt: at - 3600_000, lastRun: at - 600_000, lastSent: 0 }, /last ran 10 minutes ago and sent 0/],
    [{ startedAt: at - 3600_000, lastRun: at - 60_000, lastError: "boom" }, /ran 1 minutes ago and failed/],
  ]) {
    const page = renderStatus({ t, session: { csrf: "x" }, roles: ["planner"], who: "P",
      status: collectStatus(w.db, { ...base, now: at, jobs: jobsWith(state) }) }).__raw;
    assert.match(page, expect);
  }
}));

// Straight at startJobs, because the readings above are only trustworthy if the job actually maintains that
// state — and the distinction it exists for is "ran and sent nothing" versus "never ran".
test("the job records that it ran even when there was nothing to do", withWorld({}, async (w) => {
  const quiet = { send: async () => ({ ok: true }) };
  const jobs = startJobs({ db: w.db, notifier: quiet, t: makeT("en"), seasonId: w.seasonId,
                           today: () => w.pattern.season.from, everyMs: 60_000, log: {} });
  try {
    assert.equal(jobs.state().lastRun, null, "nothing has run yet");
    await jobs.tick();
    assert.ok(jobs.state().lastRun !== null, "a tick must record that it happened");
  } finally { jobs.stop(); }

  // With no current season the tick returns early — and that must still count as a run, or a correctly-behaving
  // instance whose season has ended is indistinguishable from a dead timer.
  const none = startJobs({ db: w.db, notifier: quiet, t: makeT("en"), seasonId: () => null,
                           today: () => w.pattern.season.from, everyMs: 60_000, log: {} });
  try {
    await none.tick();
    assert.ok(none.state().lastRun !== null, "looking and finding no season is still the job having run");
    assert.equal(none.state().lastSent, 0);
  } finally { none.stop(); }
}));

test("backup age is judged, and no backups at all is a fault", withWorld({}, async (w) => {
  const none = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: null });
  assert.equal(factFor(none, "backup").level, "bad");
  assert.equal(factFor(none, "backup").note, "none");

  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-st-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "4water-2026-08-03T010000Z.sqlite"), "x");
    writeFileSync(path.join(dir, "not-a-backup.txt"), "x");
    const fresh = collectStatus(w.db, { pattern: w.pattern, today: w.pattern.season.from, backupDir: dir });
    const f = factFor(fresh, "backup");
    assert.equal(f.level, "ok", "a backup written moments ago is healthy");
    assert.equal(f.detail, 1, "and only real backup files are counted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

// The outbox carries volunteers' names and the text of messages about them, so it is planner-only for the same
// reason /status is — and reachable, since a page nobody can find is the gap it was written to close.
test("the outbox is planner-gated, linked from status, and readable", withWorld({}, async (w) => {
  assert.equal((await w.get("/outbox")).status, 303, "signed out goes to sign-in");
  const volunteer = await w.signIn(w.people[1]);
  assert.equal((await w.get("/outbox", volunteer)).status, 403,
    "messages name other volunteers; this is not a volunteer-facing page");

  const planner = await w.signIn(w.people[0]);
  w.db.prepare(`INSERT INTO notifications (kind, person_id, channel, body, status, created_at)
                VALUES ('availability_nudge', ?, 'outbox', 'Please tell us when you can help', 'queued', '2026-05-20T10:00:00Z')`)
    .run(w.people[1]);

  const r = await w.get("/outbox", planner);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /Please tell us when you can help/, "the message text must actually be readable");
  assert.match(body, /Availability reminder/, "and its kind must render as words, not as outbox.kind.availability_nudge");
  assert.ok(!/outbox\.[a-z]/i.test(body), "an untranslated key rendered on the page");

  // A bad status in the query string must not break the page or become a SQL fragment.
  assert.equal((await w.get("/outbox?status=nonsense", planner)).status, 200);
  assert.equal((await w.get("/outbox?status=queued", planner)).status, 200);

  // And it is reachable: /status links to it, because the counts there are useless without the text.
  assert.match(await (await w.get("/status", planner)).text(), /href="\/outbox"/,
    "a page nobody can navigate to is the gap this closed");
}));

test("the status page is planner-gated and every fact renders as a sentence", withWorld({}, async (w) => {
  assert.equal((await w.get("/status")).status, 303);
  const volunteer = await w.signIn(w.people[1]);
  assert.equal((await w.get("/status", volunteer)).status, 403, "the roster's health is not public");

  const planner = await w.signIn(w.people[0]);
  const r = await w.get("/status", planner);
  assert.equal(r.status, 200);
  const body = await r.text();
  // Every fact must become prose. A bare key rendering means a fact was added without a sentence for it.
  for (const key of ["season", "gaps", "silent", "failed", "queued", "backup"]) {
    assert.ok(!new RegExp(`<span>${key}</span>`).test(body), `fact "${key}" rendered as its key, with no sentence`);
  }
  assert.match(body, /slots in the next month|vagter i den næste måned/);
  assert.match(body, /href="\/planner\?gaps=1"/, "and it should link to the thing you would do about it");
}));

test("the profile and status links appear in the navigation for the right people", withWorld({}, async (w) => {
  const volunteer = await w.signIn(w.people[1]);
  const vNav = await (await w.get("/", volunteer)).text();
  assert.match(vNav, /href="\/me"/, "everyone gets their own page");
  assert.ok(!/href="\/status"/.test(vNav), "but not the operational status");

  const planner = await w.signIn(w.people[0]);
  const pNav = await (await w.get("/", planner)).text();
  assert.match(pNav, /href="\/status"/);
}));

// ---- how sign-in finds the identity provider (increment S) ---------------------------------------------
// A discovery failure falls back to NextCloud's endpoint layout rather than locking everyone out. That is the
// right behaviour AND completely invisible, which is the shape of defect this project keeps finding. So the
// fallback has to be reportable, and reported.
test("the status page says whether sign-in read the provider's endpoint list", withWorld({}, async (w) => {
  const base = { pattern: w.pattern, today: w.today, backupDir: null };

  // Not configured: nothing to say, and an invite-only deployment should not see an OIDC line at all.
  assert.equal(factFor(collectStatus(w.db, base), "oidc"), undefined,
    "an invite-only deployment has no identity provider to report on");

  const ok = factFor(collectStatus(w.db, { ...base, oidc: { enabled: true, source: "discovery" } }), "oidc");
  assert.equal(ok.level, "ok");
  assert.equal(ok.note, "discovery");

  const degraded = factFor(collectStatus(w.db, {
    ...base, oidc: { enabled: true, source: "fallback", error: "discovery: /.well-known returned 404" },
  }), "oidc");
  assert.equal(degraded.level, "warn", "guessing endpoints is a warning, not normal operation");
  assert.match(degraded.detail, /404/, "and it must carry the reason, or nobody can fix it");

  // And it reaches the rendered page, with the reason — a fact that collects but never renders is not
  // reported. Rendered directly rather than over HTTP, because makeWorld configures no identity provider and
  // the page is RIGHT to omit the line there; the first assertion above is what covers that case.
  const t = makeT("en");
  const page = renderStatus({
    t, session: { csrf: "x" }, roles: ["planner"], who: "P",
    status: { facts: [{ key: "oidc", level: "warn", note: "fallback", detail: "returned 404" }] },
  }).__raw;
  // Not the apostrophe: strings are escaped on output, so "NextCloud's" arrives as "NextCloud&#39;s". That is
  // the escaping working, and matching on the raw apostrophe would be asserting the opposite.
  assert.match(page, /guessing NextCloud.{0,6}s usual addresses/, "the OIDC line must render");
  assert.match(page, /returned 404/, "with the reason, or nobody can fix it");
  assert.match(page, /class="status warn"/, "and carry the warning level a reader can see");
}));

// A queued message means two very different things depending on whether a webhook exists, and the old wording
// asserted one of them unconditionally: "(no webhook is configured)". notify.mjs writes the row as queued
// BEFORE calling the webhook, so a process killed between the two — a container restart, a reboot — leaves
// queued rows on an instance whose webhook is perfectly fine. The operator would then go and check a setting
// that was never the problem.
test("the queued-messages line follows the configuration, instead of asserting it", withWorld({}, async (w) => {
  const base = { pattern: w.pattern, today: w.today, backupDir: null };
  const queue = (channel) => w.db.prepare(`INSERT INTO notifications (kind, person_id, channel, body, status, created_at)
                                           VALUES ('slot_open', NULL, ?, 'x', 'queued', '2026-05-20T10:00:00Z')`).run(channel);
  const t = makeT("en");
  const render = (notify) => renderStatus({
    t, session: { csrf: "x" }, roles: ["planner"], who: "P",
    status: collectStatus(w.db, { ...base, notify }),
  }).__raw;

  // No webhook: queueing is by design, so it stays a note and says why.
  queue("outbox");
  const outbox = render({ channel: "outbox" });
  assert.match(outbox, /no chat webhook is configured/);
  assert.match(outbox, /class="status ok"/, "queueing by design is not a warning");

  // A webhook IS configured and rows are still queued: the honest reading is an interrupted send, and the page
  // must not claim the opposite of the configuration it can see.
  const withHook = render({ channel: "mattermost" });
  assert.ok(!/no chat webhook is configured/.test(withHook),
    "telling an operator there is no webhook while one is configured sends them to fix the wrong thing");
  assert.match(withHook, /never confirmed as sent/);
  assert.match(withHook, /class="status warn"/, "an interrupted send deserves a warning, not a note");

  // With nothing queued, neither wording is an alarm.
  w.db.prepare("DELETE FROM notifications").run();
  assert.match(render({ channel: "mattermost" }), /class="status ok"/);
}));
