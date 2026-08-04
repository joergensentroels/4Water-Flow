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
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, loadPattern, roleSlotsFor } from "../src/config.mjs";
import { migrate } from "../src/db.mjs";
import { bootstrapAdmin } from "../tools/bootstrap.mjs";
import { redeemInvite, rolesOf } from "../src/auth.mjs";

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

    // Redeem the link exactly as a browser would.
    const redeem = await fetch(`http://127.0.0.1:${port}/invite/${r.inviteToken}`, { redirect: "manual" });
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
