// Increment H. The risks here are an org locking itself out, and an admin saving a config the next boot
// refuses to load. Both are tested directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { validatePattern, loadPattern } from "../src/config.mjs";
import { setRole, setCapability, setPersonStatus, savePattern, patternFromForm, addActivityToForm, peopleWithDetail } from "../src/admin.mjs";
import { rolesOf } from "../src/auth.mjs";

const withAdmin = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin"], 1: ["planner"] }, ...opts });
  try { await fn(w); } finally { w.close(); }
};
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

// ---- access -------------------------------------------------------------------------------------------
test("admin pages are admin-only; a planner is not an admin", withAdmin({}, async (w) => {
  assert.equal((await w.get("/admin")).status, 303);

  const planner = await w.signIn(w.people[1]);
  assert.equal((await w.get("/admin", planner)).status, 403, "planner is a different job, not a lesser admin");

  const admin = await w.signIn(w.people[0]);
  assert.equal((await w.get("/admin", admin)).status, 200);
}));

test("every admin POST refuses a non-admin", withAdmin({}, async (w) => {
  const planner = await w.signIn(w.people[1]);
  const csrf = csrfFromCookie(planner);
  for (const path of ["/admin/invite", "/admin/invite/revoke", "/admin/role", "/admin/capability", "/admin/status", "/admin/season", "/admin/activity"]) {
    const r = await w.post(path, planner, new URLSearchParams({ csrf }));
    assert.equal(r.status, 403, `${path} must be admin-only`);
  }
}));

// ---- the lockout guard --------------------------------------------------------------------------------
test("the last admin cannot remove their own admin role", withAdmin({}, async (w) => {
  assert.deepEqual(setRole(w.db, w.people[0], "admin", false), { ok: false, reason: "last_admin" },
    "an org that can lock itself out has to be rescued by whoever holds shell access");
  assert.ok(rolesOf(w.db, w.people[0]).includes("admin"));

  // With a second admin in place, stepping down is fine.
  assert.equal(setRole(w.db, w.people[2], "admin", true).ok, true);
  assert.equal(setRole(w.db, w.people[0], "admin", false).ok, true);
  assert.ok(!rolesOf(w.db, w.people[0]).includes("admin"));
}));

test("an inactive admin does not count toward the lockout guard", withAdmin({}, async (w) => {
  setRole(w.db, w.people[2], "admin", true);
  setPersonStatus(w.db, w.people[2], "inactive");
  assert.deepEqual(setRole(w.db, w.people[0], "admin", false), { ok: false, reason: "last_admin" },
    "an admin who cannot sign in is not a spare admin");
}));

// ---- roles and capabilities ---------------------------------------------------------------------------
test("roles and capabilities can be granted and removed through the screen", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const key = w.pattern.activities[1].key;

  assert.equal(reasonOf(await w.post("/admin/role", admin, new URLSearchParams({ csrf: token, personId: String(w.people[2]), role: "planner", on: "1" }))), "saved");
  assert.ok(rolesOf(w.db, w.people[2]).includes("planner"));

  assert.equal(reasonOf(await w.post("/admin/capability", admin, new URLSearchParams({ csrf: token, personId: String(w.people[2]), key, on: "1" }))), "saved");
  const p = peopleWithDetail(w.db).find((x) => x.id === w.people[2]);
  assert.ok(p.can.includes(key));

  assert.equal(reasonOf(await w.post("/admin/capability", admin, new URLSearchParams({ csrf: token, personId: String(w.people[2]), key, on: "0" }))), "saved");
  assert.ok(!peopleWithDetail(w.db).find((x) => x.id === w.people[2]).can.includes(key));
}));

test("removing a capability leaves existing assignments alone", withAdmin({}, async (w) => {
  const actKey = w.pattern.activities[0].key;
  const slot = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                             JOIN activities act ON act.id=s.activity_id
                             WHERE act.key=? AND a.person_id IS NULL LIMIT 1`).get(actKey).id;
  w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(w.people[2], slot);

  setCapability(w.db, w.people[2], actKey, false);
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(slot).person_id, w.people[2],
    "removing a capability means 'no more of these', not 'erase what they already agreed to'");
}));

test("unknown roles, activities and people are refused rather than silently ignored", withAdmin({}, async (w) => {
  assert.deepEqual(setRole(w.db, w.people[2], "wizard", true), { ok: false, reason: "no_such_role" });
  assert.deepEqual(setRole(w.db, 999999, "planner", true), { ok: false, reason: "no_such_person" });
  assert.deepEqual(setCapability(w.db, w.people[2], "not_a_thing", true), { ok: false, reason: "no_such_activity" });
  assert.deepEqual(setPersonStatus(w.db, w.people[2], "banished"), { ok: false, reason: "bad_status" });
}));

// ---- invitations --------------------------------------------------------------------------------------
test("creating an invite shows the link exactly once, and it works", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const r = await w.post("/admin/invite", admin, new URLSearchParams({ csrf: token, email: "newcomer@example.org" }));
  assert.equal(reasonOf(r), "invited");

  const { body } = await w.follow(r, admin);
  const link = body.match(/<code>(http[^<]+)<\/code>/)?.[1];
  assert.ok(link, "the link must be shown after creation — it is never recoverable afterwards");

  // Second view does not repeat it.
  const again = await (await w.get("/admin", admin)).text();
  assert.ok(!/<code>http/.test(again), "the raw token must not linger on the page");

  // And the stored form is a hash, not the token.
  const stored = w.db.prepare("SELECT token FROM invitations").get().token;
  assert.ok(!link.includes(stored));
  assert.match(stored, /^[0-9a-f]{64}$/);

  // Redeeming it signs the newcomer in and lands them on the screen they need.
  const inviteToken = new URL(link).pathname.split("/").pop();
  const redeem = await w.get(`/invite/${inviteToken}`);
  assert.equal(redeem.status, 303);
  assert.equal(redeem.headers.get("location"), "/availability", "a new volunteer's first task is their availability");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM people WHERE contact=?").get("newcomer@example.org").n, 1);
}));

test("a revoked invite cannot be redeemed afterwards", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const created = await w.post("/admin/invite", admin, new URLSearchParams({ csrf: token, email: "gone@example.org" }));
  const link = (await w.follow(created, admin)).body.match(/<code>(http[^<]+)<\/code>/)[1];
  const id = w.db.prepare("SELECT id FROM invitations WHERE email=?").get("gone@example.org").id;

  assert.equal(reasonOf(await w.post("/admin/invite/revoke", admin, new URLSearchParams({ csrf: token, id: String(id) }))), "revoked");

  const inviteToken = new URL(link).pathname.split("/").pop();
  const redeem = await w.get(`/invite/${inviteToken}`);
  assert.equal(redeem.headers.get("location"), "/signin?unknown=1");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM people WHERE contact=?").get("gone@example.org").n, 0);
}));

// ---- config editing -----------------------------------------------------------------------------------
test("the validator rejects every way of breaking the config", () => {
  const good = loadPattern();
  const bad = [
    [{ ...good, activities: [] }, /at least one activity/],
    [{ ...good, weekly: [] }, /at least one weekly/],
    [{ ...good, season: { key: "x", from: "2026-06-01", to: "2026-01-01" } }, /ends before it starts/],
    [{ ...good, season: { key: "x", from: "01-01-2026", to: "2026-06-30" } }, /yyyy-mm-dd/],
    [{ ...good, weekly: [{ dayOfWeek: 9, hour: 19, activities: [good.activities[0].key] }] }, /dayOfWeek must be 0\.\.6/],
    [{ ...good, weekly: [{ dayOfWeek: 3, hour: 99, activities: [good.activities[0].key] }] }, /hour must be 0\.\.23/],
    [{ ...good, weekly: [{ dayOfWeek: 3, hour: 19, activities: ["ghost"] }] }, /unknown activity "ghost"/],
    [{ ...good, activities: [{ key: "Bad Key", label: "x" }, ...good.activities] }, /lowercase letters/],
    [{ ...good, activities: [...good.activities, good.activities[0]] }, /duplicate activity key/],
    [{ ...good, roles: ["admin"] }, /must include volunteer/],
  ];
  for (const [obj, re] of bad) assert.throws(() => validatePattern(obj), re, `should have rejected: ${JSON.stringify(obj).slice(0, 80)}`);
  assert.ok(validatePattern(good));
});

test("an invalid edit is refused and the file on disk is left untouched", withAdmin({}, async (w) => {
  const before = readFileSync(w.patternFile, "utf8");
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);

  const r = await w.post("/admin/season", admin, new URLSearchParams({
    csrf: token, seasonKey: "broken", seasonFrom: "2026-12-01", seasonTo: "2026-01-01",
  }));
  assert.equal(reasonOf(r), "invalid");
  assert.equal(readFileSync(w.patternFile, "utf8"), before,
    "validate BEFORE writing — validating afterwards means the bad file is already on disk");

  const { body } = await w.follow(r, admin);
  assert.match(body, /Could not save|Kunne ikke gemme/);
  assert.match(body, /ends before it starts/, "the admin needs to know WHAT was wrong");
}));

test("a valid season edit is written, reloaded in-process, and takes effect without a restart", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);

  const r = await w.post("/admin/season", admin, new URLSearchParams({
    csrf: token, seasonKey: "2027-Q1Q2", seasonFrom: "2027-01-01", seasonTo: "2027-06-30", cutoffDays: "5",
  }));
  assert.equal(reasonOf(r), "saved");

  // On disk...
  const onDisk = JSON.parse(readFileSync(w.patternFile, "utf8"));
  assert.equal(onDisk.season.key, "2027-Q1Q2");
  assert.equal(onDisk.board.cutoffDays, 5);
  assert.ok(validatePattern(onDisk), "whatever is written must still load");

  // ...and live in the running process: the new season exists and has sessions.
  const season = w.db.prepare("SELECT id FROM seasons WHERE key=?").get("2027-Q1Q2");
  assert.ok(season, "the new season should have been materialised");
  assert.ok(w.db.prepare("SELECT COUNT(*) n FROM sessions WHERE season_id=?").get(season.id).n > 0);

  // The admin page now shows the new season without the process being restarted.
  const body = await (await w.get("/admin", admin)).text();
  assert.match(body, /2027-Q1Q2/);
}));

test("adding an activity materialises it without deleting anything", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const sessionsBefore = w.db.prepare("SELECT COUNT(*) n FROM sessions").get().n;

  const r = await w.post("/admin/activity", admin, new URLSearchParams({
    csrf: token, key: "kids_class", label: "Kids class",
  }));
  assert.equal(reasonOf(r), "saved");
  assert.ok(w.db.prepare("SELECT id FROM activities WHERE key=?").get("kids_class"), "the activity should exist");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, sessionsBefore,
    "a new activity is not in any weekly pattern yet, so it generates no sessions");

  const onDisk = JSON.parse(readFileSync(w.patternFile, "utf8"));
  assert.ok(onDisk.activities.some((a) => a.key === "kids_class"));
  assert.ok(validatePattern(onDisk));
}));

test("a rejected activity key does not reach the file", withAdmin({}, async (w) => {
  const before = readFileSync(w.patternFile, "utf8");
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const r = await w.post("/admin/activity", admin, new URLSearchParams({ csrf: token, key: "Not Valid", label: "x" }));
  assert.equal(reasonOf(r), "invalid");
  assert.equal(readFileSync(w.patternFile, "utf8"), before);
}));

test("savePattern writes atomically and leaves no temp file behind", withAdmin({}, async (w) => {
  const next = patternFromForm(w.pattern, { seasonKey: "tmp-test", seasonFrom: "2028-01-01", seasonTo: "2028-02-01" });
  const r = savePattern(w.db, next, { file: w.patternFile });
  assert.equal(r.ok, true);
  assert.throws(() => readFileSync(`${w.patternFile}.tmp`, "utf8"), /ENOENT/, "the temp file should have been renamed away");
  assert.equal(JSON.parse(readFileSync(w.patternFile, "utf8")).season.key, "tmp-test");
}));

test("addActivityToForm and patternFromForm do not mutate the pattern they are given", withAdmin({}, async (w) => {
  const snapshot = JSON.stringify(w.pattern);
  addActivityToForm(w.pattern, { key: "x_thing", label: "X" });
  patternFromForm(w.pattern, { seasonKey: "other", seasonFrom: "2029-01-01", seasonTo: "2029-02-01" });
  assert.equal(JSON.stringify(w.pattern), snapshot, "a failed save must not have half-applied itself in memory");
}));
