// The tests that were missing, and whose absence let two lockout bugs ship as "done".
//
// Everything else in this suite builds its world through tools/testkit.mjs, which seeds a season and creates
// people. Production did neither: `node src/server.mjs` migrated an empty database and served a working-
// looking app with no season, no activities, no sessions and no way for anyone to sign in. The harness was
// doing the setup the real boot path skipped — so nothing failed.
//
// These tests use the REAL entry point and a REAL empty file, and touch testkit nowhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, loadPattern, roleSlotsFor } from "../src/config.mjs";
import { migrate } from "../src/db.mjs";
import { bootstrapAdmin } from "../tools/bootstrap.mjs";
import { redeemInvite, rolesOf } from "../src/auth.mjs";
import { writeSeasonSpanningToday } from "../tools/season-fixture.mjs";

const freshDir = () => mkdtempSync(path.join(os.tmpdir(), "4water-first-"));
const cleanup = (d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} };

function bootReal(dir, port, extra = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    env: { ...process.env, FOURWATER_DB: path.join(dir, "app.db"), PORT: String(port),
           FOURWATER_SECRET: "g".repeat(48), NODE_ENV: "production", HOST: "127.0.0.1", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, out: () => out };
}
const waitHealthy = async (port, child) => {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) return false;
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch {}
  }
  return false;
};

// The likeliest misconfiguration of this whole deployment: the named volume not mounted, so the directory
// FOURWATER_DB points into does not exist. SQLite creates the FILE but never the directory holding it.
//
// Measured before the fix: exit 1, `Error: unable to open database file`, a stack trace naming db.mjs — and no
// mention of the path it tried or the variable that set it. Nothing an operator reading a container log can act
// on, in an app that already names the version it found for a wrong Node and names host:port for a busy one.
test("an unopenable database says which path and which variable, without a stack trace", async () => {
  const dir = freshDir();
  try {
    const missing = path.join(dir, "no-such-directory", "app.db");
    const { child, out } = bootReal(dir, 8395, { FOURWATER_DB: missing });
    const code = await new Promise((r) => child.once("exit", r));
    assert.equal(code, 1, `expected a clean refusal, got ${code} — output:\n${out()}`);

    const text = out();
    assert.ok(text.includes(missing), `the message must name the path it tried:\n${text}`);
    assert.match(text, /FOURWATER_DB/, "and the variable that set it, so an operator knows where to look");
    assert.match(text, /volume/i, "and the likely cause, since this is what an unmounted volume looks like");

    // No stack trace: an operator reading a container log has no use for a line number in a file they will not
    // open, and a stack buries the sentence that would have helped. Same treatment a failed bind already got.
    assert.ok(!/\bat openDb\b|db\.mjs:\d+/.test(text), `the refusal must not be a stack trace:\n${text}`);
  } finally { cleanup(dir); }
});

// The divergence this whole file exists because of, checked in the other direction too.
//
// Every other suite builds its world through the harness, and twice the harness did setup the boot path skipped.
// The mirror image is just as dangerous and harder to notice: the harness taking a DIFFERENT route to the same
// state. It was — the boot block calls `seedSeason`, and `makeWorld` called `seedStructure` plus a separate
// `openEverySession`, which is precisely the pair seedSeason exists to replace. Its comment says so: the fix for
// calling only the first "is not another reminder to call both: it is one function, so that calling half of it is
// no longer expressible." The harness went on expressing it.
//
// Nothing failed when that was changed — same file, same rows — which is the point. A step added to seedSeason
// later would reach production and miss every test built through the harness, and the suite would stay green.
//
// Both sides are read from the source rather than named here, so this cannot agree with a stale copy of itself.
test("the harness materialises a season through the same entry point the boot path uses", () => {
  const server = readFileSync(path.join(ROOT, "src", "server.mjs"), "utf8");
  const kit = readFileSync(path.join(ROOT, "tools", "testkit.mjs"), "utf8");
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "");

  const bootBlock = strip(server).slice(strip(server).indexOf("import.meta.url"));
  assert.ok(bootBlock.length > 500, "the boot block was not located — this check is not looking at anything");

  const seedersIn = (text) => [...new Set([...text.matchAll(/\b(seedSeason|seedStructure)\s*\(/g)].map((m) => m[1]))];
  const boot = seedersIn(bootBlock);
  assert.deepEqual(boot, ["seedSeason"],
    `the boot path seeds with ${boot.join(", ") || "nothing"} — if that changed, the harness must change with it`);

  const harness = seedersIn(strip(kit));
  assert.ok(harness.includes("seedSeason"),
    `tools/testkit.mjs seeds with ${harness.join(", ")} and not seedSeason, so every test builds its world by a ` +
    `route production does not take. That is how the harness and the boot path drift apart, which has already ` +
    `shipped two defects in this project.`);

  // seedStructure alone is still allowed in the harness, for the `openSessions: false` world — a season with no
  // slots is the shape of the defect that shipped and tests need to be able to build it deliberately. What must
  // not happen is the DEFAULT path taking it.
  assert.match(strip(kit), /openSessions\s*\?\s*\r?\n?\s*seedSeason\(/,
    "the harness's default world must be the seedSeason one, with seedStructure reserved for the no-slots case");
});

test("a brand-new deployment seeds its season, not an empty shell", async () => {
  const dir = freshDir();
  const port = 8161;
  const b = bootReal(dir, port);
  try {
    assert.ok(await waitHealthy(port, b.child), `never became healthy:\n${b.out()}`);
    const db = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
    try {
      const pattern = loadPattern();
      const counts = {};
      for (const t of ["seasons", "activities", "timeslots", "sessions", "roles"]) {
        counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      }
      assert.equal(counts.seasons, 1, `a fresh boot must have a season, got ${JSON.stringify(counts)}`);
      assert.equal(counts.activities, pattern.activities.length);
      assert.equal(counts.timeslots, pattern.weekly.length);
      assert.ok(counts.sessions > 0, "and actual sessions to schedule");
      assert.equal(counts.roles, pattern.roles.length);

      // POPULATED IS NOT THE SAME AS OPERABLE, and this is where that distinction was missed for the second
      // time. The earlier version of this test stopped at "sessions > 0". A boot that created 102 sessions and
      // zero assignment rows passed it — and produced a deployment where the shift exchange had nothing to
      // claim, the planner nothing to assign, auto-roster nothing to propose, and /status reported "0 of 0
      // slots unfilled", which reads as healthy.
      const slots = db.prepare("SELECT COUNT(*) n FROM assignments").get().n;
      assert.ok(slots > 0, "a fresh boot must open the slots, or nothing on the plan can ever be staffed");
      const naked = db.prepare(`SELECT COUNT(*) n FROM sessions s
                                 WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.session_id = s.id)`).get().n;
      assert.equal(naked, 0, `${naked} session(s) have no slots at all`);

      // And the count matches what the pattern asks for, per session — "at least one" would pass a season that
      // opened a leader slot for every class and never a follower.
      const byKey = new Map(pattern.activities.map((a) => [a.key, a]));
      const wrong = db.prepare(`SELECT act.key, s.date,
                                       (SELECT COUNT(*) FROM assignments a WHERE a.session_id=s.id) AS slots
                                  FROM sessions s JOIN activities act ON act.id=s.activity_id`).all()
        .filter((r) => r.slots !== roleSlotsFor(byKey.get(r.key)).length);
      assert.deepEqual(wrong, [], "a session with the wrong number of slots is half-staffed with nothing to show why");
    } finally { db.close(); }
  } finally { b.child.kill(); await new Promise((r) => b.child.once("exit", r)); cleanup(dir); }
});

test("a deployment with no administrator says so loudly instead of pretending to work", async () => {
  const dir = freshDir();
  const port = 8162;
  const b = bootReal(dir, port);
  try {
    assert.ok(await waitHealthy(port, b.child), `never became healthy:\n${b.out()}`);
    // Give the warning a moment to flush after the listen line.
    await new Promise((r) => setTimeout(r, 200));
    const out = b.out();
    assert.match(out, /no administrator yet/i, `a locked-out deployment must announce itself. Output was:\n${out}`);
    assert.match(out, /tools\/bootstrap\.mjs/, "and name the command that fixes it");
  } finally { b.child.kill(); await new Promise((r) => b.child.once("exit", r)); cleanup(dir); }
});

test("re-seeding on every boot is idempotent — no duplicate sessions", async () => {
  const dir = freshDir();
  const port = 8163;
  let first;
  const a = bootReal(dir, port);
  try {
    assert.ok(await waitHealthy(port, a.child));
    const db = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
    first = db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
    db.close();
  } finally { a.child.kill(); await new Promise((r) => a.child.once("exit", r)); }

  const c = bootReal(dir, port);
  try {
    assert.ok(await waitHealthy(port, c.child), `second boot failed:\n${c.out()}`);
    const db = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, first,
      "booting twice must not duplicate the season");
    db.close();
    assert.ok(!/seeded \d+ new session/.test(c.out().split("listening")[1] ?? ""), "and should not claim to have seeded again");
  } finally { c.child.kill(); await new Promise((r) => c.child.once("exit", r)); cleanup(dir); }
});

// ---- the bootstrap command ------------------------------------------------------------------------------
test("bootstrap creates the first admin and hands back a working sign-in link", () => {
  const dir = freshDir();
  try {
    const db = new DatabaseSync(path.join(dir, "app.db"));
    migrate(db);
    const r = bootstrapAdmin(db, { email: "chair@4water.org", name: "The Chair", baseUrl: "https://plan-cph.4water.org" });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.alreadyAdmin, false);
    assert.deepEqual(rolesOf(db, r.personId).sort(), ["admin", "planner"], "a one-person setup must be able to do both jobs");
    assert.match(r.inviteUrl, /^https:\/\/plan-cph\.4water\.org\/invite\/[\w-]+$/);

    // The link actually works, and only once.
    const redeemed = redeemInvite(db, r.inviteToken, { name: "The Chair" });
    assert.equal(redeemed.ok, true);
    assert.deepEqual(redeemInvite(db, r.inviteToken, {}), { ok: false, reason: "already_used" });
    db.close();
  } finally { cleanup(dir); }
});

test("bootstrap is idempotent and never duplicates a person", () => {
  const dir = freshDir();
  try {
    const db = new DatabaseSync(path.join(dir, "app.db"));
    migrate(db);
    const first = bootstrapAdmin(db, { email: "chair@4water.org", name: "The Chair" });
    const second = bootstrapAdmin(db, { email: "chair@4water.org", name: "Different Name" });
    assert.equal(second.personId, first.personId, "the same address must not create a second person");
    assert.equal(second.created, false);
    assert.equal(second.alreadyAdmin, true, "and it should say the role was already there");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, 1);
    db.close();
  } finally { cleanup(dir); }
});

// Creating an administrator is an identity operation. It must not decide what season exists.
//
// It used to call seedStructure "to guarantee the roles exist", which also seeded a whole season — activities,
// timeslots and every session in it — from whatever config/pattern.json happened to hold. tools/demo.mjs calls
// bootstrapAdmin, so demo.db ended up with 4water's real 2026-Q1Q2 season sitting beside the demo one, and 99
// of its sessions had no slots because openEverySession is scoped to a single season. On a live system the same
// line would have written a phantom season into production.
test("creating the first administrator does not invent a season", () => {
  const dir = freshDir();
  try {
    const db = new DatabaseSync(path.join(dir, "app.db"));
    migrate(db);
    const r = bootstrapAdmin(db, { email: "chair@4water.org", name: "The Chair" });
    assert.equal(r.ok, true);

    const n = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    assert.equal(n("roles"), loadPattern().roles.length, "the roles it needs must exist");
    for (const t of ["seasons", "activities", "timeslots", "sessions", "assignments"]) {
      assert.equal(n(t), 0, `bootstrap must not create ${t} — it is an identity operation, not a seeding one`);
    }
    db.close();
  } finally { cleanup(dir); }
});

// The same property from the other end: whatever the demo builds, it must be ONE season. This is the assertion
// that would have caught it, because the symptom was visible only as a count nobody was checking.
test("the demo database contains exactly one season, and every one of its sessions has slots", async () => {
  const dir = freshDir();
  try {
    const { buildDemo, demoPattern } = await import("../tools/demo.mjs");
    const db = new DatabaseSync(path.join(dir, "demo.db"));
    const pattern = demoPattern();
    const r = buildDemo(db, { pattern });

    assert.equal(db.prepare("SELECT COUNT(*) n FROM seasons").get().n, 1,
      "a second season here means something seeded a pattern the demo did not choose");
    const orphans = db.prepare(`SELECT COUNT(*) n FROM sessions s
                                 WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.session_id = s.id)`).get().n;
    assert.equal(orphans, 0, "every session must have at least one slot, or it can never be staffed");

    // And the slot count matches what the pattern asks for, per session — not merely "at least one".
    const { roleSlotsFor } = await import("../src/config.mjs");
    const byKey = new Map(pattern.activities.map((a) => [a.key, a]));
    const wrong = db.prepare(`SELECT act.key, s.id, s.date,
                                     (SELECT COUNT(*) FROM assignments a WHERE a.session_id=s.id) AS slots
                                FROM sessions s JOIN activities act ON act.id=s.activity_id
                               WHERE s.season_id=?`).all(r.seasonId)
      .filter((row) => row.slots !== roleSlotsFor(byKey.get(row.key)).length);
    assert.deepEqual(wrong, [], "a session with the wrong number of slots is half-staffed with nothing to show why");
    db.close();
  } finally { cleanup(dir); }
});

test("bootstrap refuses a value that is not an email", () => {
  const dir = freshDir();
  try {
    const db = new DatabaseSync(path.join(dir, "app.db"));
    migrate(db);
    assert.deepEqual(bootstrapAdmin(db, { email: "" }), { ok: false, reason: "bad_email" });
    assert.deepEqual(bootstrapAdmin(db, { email: "not-an-email" }), { ok: false, reason: "bad_email" });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, 0, "a refusal must create nothing");
    db.close();
  } finally { cleanup(dir); }
});

test("end to end: fresh database, bootstrap, sign in, reach the admin screen", async () => {
  const dir = freshDir();
  const port = 8164;
  // Bootstrap BEFORE booting, the order the runbook gives.
  const db = new DatabaseSync(path.join(dir, "app.db"));
  migrate(db);
  const r = bootstrapAdmin(db, { email: "chair@4water.org", name: "The Chair" });
  db.close();

  const b = bootReal(dir, port);
  try {
    assert.ok(await waitHealthy(port, b.child), `never became healthy:\n${b.out()}`);
    assert.ok(!/no administrator yet/i.test(b.out()), "with an admin present the warning must not appear");

    // Open the link exactly as a browser would: a page offering the invitation, and no session yet.
    const offer = await fetch(`http://127.0.0.1:${port}/invite/${r.inviteToken}`, { redirect: "manual" });
    assert.equal(offer.status, 200, "the emailed link shows the invitation rather than spending it");
    assert.ok(!offer.headers.get("set-cookie"), "so a scanner that fetched it gets no account");

    // Then accept it, which is the POST the page's button submits.
    const redeem = await fetch(`http://127.0.0.1:${port}/invite/${r.inviteToken}/accept`,
      { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    assert.equal(redeem.status, 303);
    assert.equal(redeem.headers.get("location"), "/availability");
    const cookie = (redeem.headers.getSetCookie?.() ?? [redeem.headers.get("set-cookie")])[0].split(";")[0];

    // And that session really is an administrator.
    const admin = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie } });
    assert.equal(admin.status, 200, "the bootstrapped account must reach the admin screen");
    const body = await admin.text();
    assert.match(body, /Administration/);
    assert.match(body, /The Chair/, "and see itself on the roster");

    // The plan has real sessions in it, proving boot seeding and sign-in work together.
    const plan = await (await fetch(`http://127.0.0.1:${port}/plan`, { headers: { cookie } })).text();
    assert.ok(!/There are no activities in this season/.test(plan), "a bootstrapped deployment must not look empty");
  } finally { b.child.kill(); await new Promise((r2) => b.child.once("exit", r2)); cleanup(dir); }
});

// ---- the notifier and the nudge timer are WIRED (increment X) ------------------------------------------
// Same generator as the missing slots, and it went unnoticed the same way: makeNotifier and startJobs were
// called only from tests. buildApp defaults notifier to null and announceOpenSlot opens with
// `if (!notifier) return`, so on a real deployment no announcement ever fired and the nudge never ran once —
// while seventeen tests proved the machinery worked, because testkit passed a notifier production did not.
//
// This test therefore refuses to construct a notifier. It boots the real entry point and checks that an action
// which is supposed to announce actually leaves a row behind.
test("a real deployment actually writes notifications", async () => {
  const dir = freshDir();
  const port = 8165;
  const dbPath = path.join(dir, "app.db");
  // A season containing today, because the shipped one ends in June and an empty planner horizon would make
  // this pass for the wrong reason. Written into this test's own directory: it used to point at
  // demo-pattern.json in the repository root, which .gitignore excludes, so this test could not run on a fresh
  // clone either. See tools/season-fixture.mjs.
  const patternFile = path.join(dir, "pattern.json");
  writeSeasonSpanningToday(patternFile, { key: "firstrun" });
  const b = bootReal(dir, port, {
    FOURWATER_PATTERN: patternFile,
    FOURWATER_AUTH: "dev", NODE_ENV: "development",
  });
  try {
    assert.ok(await waitHealthy(port, b.child), `never became healthy:\n${b.out()}`);
    await new Promise((r) => setTimeout(r, 150));
    assert.match(b.out(), /notifications:/, "boot must say where notifications go, or nobody can tell they are off");

    // A volunteer on a slot, written directly: the roster is curated, so there is no sign-up path to drive.
    let personId, slotId;
    {
      const db = new DatabaseSync(dbPath);
      const act = db.prepare("SELECT id FROM activities LIMIT 1").get().id;
      personId = Number(db.prepare(`INSERT INTO people (name, contact, preferred_role, auth_provider)
                                    VALUES ('Notify One','n1@example.org','b','oidc')`).run().lastInsertRowid);
      db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) VALUES (?,?)").run(personId, act);
      for (const role of ["volunteer", "planner"]) {
        const rid = db.prepare("SELECT id FROM roles WHERE name=?").get(role)?.id;
        if (rid) db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(personId, rid);
      }
      slotId = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                            WHERE a.person_id IS NULL AND s.activity_id=? LIMIT 1`).get(act).id;
      db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(personId, slotId);
      db.close();
    }

    const login = await fetch(`http://127.0.0.1:${port}/auth/dev`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ personId: String(personId) }), redirect: "manual",
    });
    const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")])
      .filter(Boolean).map((c) => c.split(";")[0]).join("; ");
    assert.ok(cookie, `dev sign-in failed: ${login.status}`);

    const page = await (await fetch(`http://127.0.0.1:${port}/planner`, { headers: { cookie } })).text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf, "no CSRF token on the planner");

    // Freeing a slot puts it back on the shift exchange, which is what announces.
    const r = await fetch(`http://127.0.0.1:${port}/planner/unassign`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ assignmentId: String(slotId), expect: String(personId), csrf }),
      redirect: "manual",
    });
    assert.equal(new URL(r.headers.get("location"), "http://x").searchParams.get("r"), "unassigned",
      "the slot must actually have been freed, or this proves nothing");

    // The announcement is fired and not awaited, so poll rather than sleep a fixed amount.
    let rows = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 50));
      const db = new DatabaseSync(dbPath, { readOnly: true });
      rows = db.prepare("SELECT kind, status, body FROM notifications").all();
      db.close();
    }
    assert.ok(rows.length > 0, "freeing a slot on a real deployment must write a notification, not silently nothing");
    assert.equal(rows[0].kind, "slot_open");
    // With no webhook configured the channel is the outbox and the row is queued — written, not lost.
    assert.equal(rows[0].status, "queued");
    assert.ok(rows[0].body.length > 0, "and it must have a body a planner could copy into the group chat");
  } finally { b.child.kill(); await new Promise((r) => b.child.once("exit", r)); cleanup(dir); }
});

// ---- and the second run, which is the one that broke ------------------------------------------------------------
//
// The test above asserts exactly one season, which is the right property — and it builds the demo ONCE in an empty
// directory, so it could never reach the case that failed. CONTRIBUTING tells a maintainer to run `node tools/demo.mjs`
// to look at the app; do that, come back another day, and run it again.
//
// `demoSeason` is anchored on today, so its key moves daily. Reset deleted the people and left the previous season's
// sessions; seedSeason then made the new season and skipped every session, because seeding only ever adds and those
// dates and timeslots were taken. Measured on the database the crash left behind: `demo-2026-06-24` with 117 sessions,
// `demo-2026-06-25` with none — and then a TypeError from reading `.date` of undefined, four lines later, with nothing
// naming the cause.
test("the demo can be rebuilt on a later day, which is how anybody actually uses it", async () => {
  const dir = freshDir();
  try {
    const { buildDemo, demoPattern } = await import("../tools/demo.mjs");
    const db = new DatabaseSync(path.join(dir, "demo.db"));
    const day1 = new Date("2026-03-10T12:00:00Z");
    const day2 = new Date("2026-03-11T12:00:00Z");          // one day later: overlapping dates, a different key

    const first = buildDemo(db, { pattern: demoPattern(undefined, day1) });
    assert.ok(first.seasonId, "the first build must work — it always did");
    const peopleAfterFirst = db.prepare("SELECT COUNT(*) n FROM people").get().n;
    assert.ok(peopleAfterFirst > 0);

    // The fixture's own control: the two patterns must genuinely differ in key and overlap in dates, or this test is
    // just the one above run twice.
    const p1 = demoPattern(undefined, day1), p2 = demoPattern(undefined, day2);
    assert.notEqual(p1.season.key, p2.season.key, "the key must move, or nothing new is being asked");
    assert.ok(p2.season.from <= p1.season.to && p1.season.from <= p2.season.to,
      "the seasons must overlap, because the overlap is what made every session insert a skip");

    const second = buildDemo(db, { pattern: p2 });
    assert.ok(second.seasonId, "the second build must work too");

    // One season, and it is the new one, with sessions in it.
    const seasons = db.prepare("SELECT key FROM seasons").all().map((r) => r.key);
    assert.deepEqual(seasons, [p2.season.key], `expected only ${p2.season.key}, found ${seasons.join(", ")}`);
    const sessions = db.prepare("SELECT COUNT(*) n FROM sessions WHERE season_id=?").get(second.seasonId).n;
    assert.ok(sessions > 0, "a season with no sessions is not a demo, it is a database to throw away");
    // People are re-seeded, not duplicated — the property the reset existed for in the first place.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, peopleAfterFirst,
      "the second run must replace the people, not add another twelve");
    // And the state the crash occurred in: somebody free all day with one hour blocked.
    assert.ok(db.prepare("SELECT COUNT(*) n FROM availability_hour").get().n > 0,
      "the blocked-hour case is the line that died; it must have been built");
    db.close();
  } finally { cleanup(dir); }
});
