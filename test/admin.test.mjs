// Increment H. The risks here are an org locking itself out, and an admin saving a config the next boot
// refuses to load. Both are tested directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { validatePattern, loadPattern } from "../src/config.mjs";
import { setRole, setCapability, setPersonStatus, savePattern, patternFromForm, addActivityToForm, peopleWithDetail } from "../src/admin.mjs";
import { rolesOf, hasRole } from "../src/auth.mjs";
import { erasePerson } from "../src/retention.mjs";

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

// This test's reasoning used to say "an admin who cannot sign in is not a spare admin". That premise is FALSE,
// and measuring it is what turned up the two defects below. `status='inactive'` is honoured by the eligibility
// gates and the roster — it stops somebody being offered or assigned anything — and by nothing else. It does not
// revoke a role, `rolesOf` and `hasRole` do not filter on it, and `linkIdentity` will sign an inactive person
// straight back in. So an inactive admin retains full administrative access.
//
// Excluding them from the tally is still right, for a different reason: an org that has marked somebody inactive
// is not relying on them, and counting them as a spare would let it believe it has redundancy it is not actually
// using. What is NOT right is concluding they are harmless — see RUNBOOK on handing over.
test("an inactive admin is not counted as a spare, though they can still sign in", withAdmin({}, async (w) => {
  setRole(w.db, w.people[2], "admin", true);
  setPersonStatus(w.db, w.people[2], "inactive");
  assert.deepEqual(setRole(w.db, w.people[0], "admin", false), { ok: false, reason: "last_admin" },
    "an org that has stood somebody down is not relying on them as its second administrator");

  // The measured half, so the comment above cannot quietly become wrong: inactive revokes nothing.
  assert.ok(rolesOf(w.db, w.people[2]).includes("admin"),
    "marking somebody inactive does not remove their roles");
  assert.equal(hasRole(w.db, w.people[2], "admin"), true,
    "and it does not revoke the privilege either — this is why RUNBOOK says to remove the role explicitly");
}));

// The other end of that asymmetry, and a real refusal of a real right. The tally counts ACTIVE admins; the
// "is this person an admin" test had no status filter. So with one active admin plus a former admin stood down,
// the guard refused to erase the former admin — reporting `last_admin` when nothing was at risk. Measured before
// the fix: `{ ok: false, reason: "last_admin" }` for their own erasure request, and the same for tidying up the
// stale role that was still granting them access.
test("a former admin who has been stood down can be erased, and their stale role removed", withAdmin({}, async (w) => {
  setRole(w.db, w.people[2], "admin", true);
  setPersonStatus(w.db, w.people[2], "inactive");
  const activeAdmins = () => w.db.prepare(`SELECT COUNT(*) n FROM person_roles pr JOIN roles r ON r.id=pr.role_id
    JOIN people p ON p.id=pr.person_id WHERE r.name='admin' AND p.status='active'`).get().n;
  assert.equal(activeAdmins(), 1, "precondition: one active admin, so nothing is at risk of lockout");

  assert.deepEqual(setRole(w.db, w.people[2], "admin", false), { ok: true },
    "removing a stood-down admin's stale role is the safe tidy-up, not a lockout risk");

  setRole(w.db, w.people[2], "admin", true);   // put it back, and try the erasure with the role still in place
  setPersonStatus(w.db, w.people[2], "inactive");
  assert.equal(erasePerson(w.db, w.people[2], { mode: "remove" }).ok, true,
    "a former administrator's right to erasure must not be refused to protect an admin seat they no longer hold");

  // The control: the guard still does its actual job.
  assert.deepEqual(erasePerson(w.db, w.people[0], { mode: "remove" }), { ok: false, reason: "last_admin" },
    "the genuinely last ACTIVE admin must still be un-erasable");
  assert.deepEqual(setRole(w.db, w.people[0], "admin", false), { ok: false, reason: "last_admin" });
}));

// ---- roles and capabilities ---------------------------------------------------------------------------
test("roles and capabilities can be granted and removed through the screen", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const key = w.pattern.activities[1].key;

  assert.equal(reasonOf(await w.post("/admin/role", admin, new URLSearchParams({ csrf: token, personId: String(w.people[2]), role: "planner", on: "1" }))), "saved");
  assert.ok(rolesOf(w.db, w.people[2]).includes("planner"));

  assert.equal(reasonOf(await w.post("/admin/capability", admin, new URLSearchParams({ csrf: token, personId: String(w.people[2]), key, on: "1" }))), "saved");
  // .rows now: peopleWithDetail returns the page plus its counts, because the screen has to say "25 of 200"
  // rather than quietly stopping at 25.
  const p = peopleWithDetail(w.db).rows.find((x) => x.id === w.people[2]);
  assert.ok(p.can.includes(key));

  assert.equal(reasonOf(await w.post("/admin/capability", admin, new URLSearchParams({ csrf: token, personId: String(w.people[2]), key, on: "0" }))), "saved");
  assert.ok(!peopleWithDetail(w.db).rows.find((x) => x.id === w.people[2]).can.includes(key));
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
  const link = body.match(/class="tokenbox">([^<]+)</)?.[1];
  assert.ok(link, "the link must be shown after creation — it is never recoverable afterwards");

  // RELATIVE here, because FOURWATER_BASE_URL is unset in the test environment — and that is the property.
  // This link used to be built from req.headers.host, which is attacker-influencable: an invite token grants a
  // SESSION, so a forged Host would render the link on somebody else's origin for an admin to email out in good
  // faith, and the volunteer would hand their invite to whoever owns that host. The app does not guess its own
  // public name; when nobody has configured it, the page shows the path and says to prefix the address.
  assert.match(link, /^\/invite\/[\w-]+$/, "no origin may be inferred from the request");
  assert.ok(!link.includes(new URL(w.base).host), "least of all the request's own Host");

  // Second view does not repeat it.
  const again = await (await w.get("/admin", admin)).text();
  assert.ok(!/class="tokenbox"/.test(again), "the raw token must not linger on the page");

  // And the stored form is a hash, not the token.
  const stored = w.db.prepare("SELECT token FROM invitations").get().token;
  assert.ok(!link.includes(stored));
  assert.match(stored, /^[0-9a-f]{64}$/);

  // Redeeming it signs the newcomer in and lands them on the screen they need.
  const inviteToken = link.split("/").pop();
  const redeem = await w.get(`/invite/${inviteToken}`);
  assert.equal(redeem.status, 303);
  assert.equal(redeem.headers.get("location"), "/availability", "a new volunteer's first task is their availability");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM people WHERE contact=?").get("newcomer@example.org").n, 1);
}));

test("a revoked invite cannot be redeemed afterwards", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const created = await w.post("/admin/invite", admin, new URLSearchParams({ csrf: token, email: "gone@example.org" }));
  const link = (await w.follow(created, admin)).body.match(/class="tokenbox">([^<]+)</)[1];
  const id = w.db.prepare("SELECT id FROM invitations WHERE email=?").get("gone@example.org").id;

  assert.equal(reasonOf(await w.post("/admin/invite/revoke", admin, new URLSearchParams({ csrf: token, id: String(id) }))), "revoked");

  const inviteToken = link.split("/").pop();
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

// ---- the roster is capped and searchable -----------------------------------------------------------------
// Measured at 200 volunteers — roughly what the multi-department plan implies — the admin screen rendered
// 953 KB. Each person carries twelve small forms, each with its own CSRF token, so 200 people is ~2,400 forms.
// Identical defect to the planner's whole-season view (534 KB, fixed with a four-week default), and unlooked-at
// here on a screen whose whole point is working from a phone. The difference that made it worse: the planner's
// big view is chosen by clicking "the whole season", and this was the default.
test("the roster is capped by default, searchable, and honest about what it is not showing", withAdmin({}, async (w) => {
  const { PEOPLE_PAGE } = await import("../src/admin.mjs");
  // Enough people to exceed a page.
  const ins = w.db.prepare("INSERT INTO people (name, contact, auth_provider) VALUES (?,?,'oidc')");
  for (let i = 0; i < PEOPLE_PAGE + 12; i++) ins.run(`Extra ${String(i).padStart(3, "0")}`, `x${i}@example.org`);
  const total = w.db.prepare("SELECT COUNT(*) n FROM people").get().n;

  const page = peopleWithDetail(w.db);
  assert.equal(page.shown, PEOPLE_PAGE, "the default must be capped");
  assert.equal(page.total, total);
  assert.equal(page.matching, total, "with no search term, everybody matches");

  // "all" really means all — the escape hatch has to work or the cap is a wall.
  assert.equal(peopleWithDetail(w.db, { limit: "all" }).shown, total);

  // Searching narrows, and the counts stay distinguishable: shown, matching and total are three numbers.
  const found = peopleWithDetail(w.db, { q: "Extra 00" });
  assert.ok(found.matching > 0 && found.matching < total, `search should narrow, got ${found.matching}/${total}`);
  assert.ok(found.rows.every((p) => p.name.includes("Extra 00")));
  assert.equal(found.total, total, "total still describes the whole roster");

  // Email is searchable too — an admin acting on an invitation has the address, not the name.
  assert.ok(peopleWithDetail(w.db, { q: "x3@example.org" }).matching >= 1);

  // A nonsense limit falls back to the page size rather than reaching a LIMIT clause.
  for (const bad of ["", "0", "-5", "banana", null]) {
    assert.ok(peopleWithDetail(w.db, { limit: bad }).shown <= PEOPLE_PAGE, `limit=${bad} must not uncap the list`);
  }

  // Over HTTP: the page says what it is not showing, and offers the way to see more. Silently stopping at 25
  // of 37 reads as "that is everybody", which is the same problem the outbox truncation notice solved.
  const admin = await w.signIn(w.people[0]);
  const body = await (await w.get("/admin", admin)).text();
  assert.match(body, new RegExp(`Showing ${PEOPLE_PAGE} of ${total}`), "it must admit the cap");
  assert.match(body, /name="q"/, "and offer a search");
  assert.match(body, /people=all/, "and a way to see everybody");

  // And the cap is real in the rendered page, not just in the query.
  const cards = (body.match(/href="\/admin\/person\/\d+\/export\.json"/g) ?? []).length;
  assert.equal(cards, PEOPLE_PAGE, `rendered ${cards} person cards, expected ${PEOPLE_PAGE}`);
}));
