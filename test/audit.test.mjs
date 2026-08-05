// The audit trail, and the check that keeps it honest.
//
// A hand-kept list of "things we remembered to log" is the defect shape this project has removed three times. So
// AUDITED in src/audit.mjs is the decision, NOT_AUDITED holds the exceptions with a reason each, and this test
// holds both against the app's own route table: a POST in neither list fails, and a route that claims to log but
// does not call the writer fails too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
import { AUDITED, NOT_AUDITED, listAudit, countAudit, recordAudit } from "../src/audit.mjs";
import { makeWorld, csrfFromCookie, makeAvailableEverywhere } from "../tools/testkit.mjs";
import { pruneAudit, retentionConfig, erasePerson } from "../src/retention.mjs";

test("every POST that changes the plan, a person or the config is accounted for", async () => {
  const w = await makeWorld({ volunteers: 1 });
  try {
    const posts = w.routes().filter((r) => r.method === "POST").map((r) => r.pattern);
    assert.ok(posts.length >= 20, `expected many POST routes, saw ${posts.length}`);

    const unaccounted = posts.filter((p) => !(p in AUDITED) && !(p in NOT_AUDITED));
    assert.deepEqual(unaccounted, [],
      "these POSTs are in neither AUDITED nor NOT_AUDITED. Decide: does this change the plan, another person's " +
      "record, or the configuration? Then add it to one list, with a reason if it is an exception:\n  " +
      unaccounted.join("\n  "));

    const both = posts.filter((p) => p in AUDITED && p in NOT_AUDITED);
    assert.deepEqual(both, [], `listed as audited AND not audited: ${both}`);

    // Both directions: an entry naming a route that no longer exists is stale bookkeeping that reads as coverage.
    const gone = [...Object.keys(AUDITED), ...Object.keys(NOT_AUDITED)].filter((p) => !posts.includes(p));
    assert.deepEqual(gone, [], `listed but not a route any more — remove: ${gone}`);

    for (const [route, why] of Object.entries(NOT_AUDITED)) {
      assert.ok(why.length >= 40, `${route}: record WHY it is exempt, not just that it is`);
    }
  } finally { w.close(); }
});

// Minimal parameters that make a route ACT rather than bounce off its own validation. Seventeen of the twenty
// audited routes record something from a bare POST; these three validate an input first and redirect without
// logging, which is correct — a malformed request changed nothing, so there is nothing to record. Supplying the
// input is what turns "the route refused me" into "the route did the thing and wrote it down".
const ACTING_FORM = {
  "/admin/invite": { email: "invited@example.invalid", name: "Invited Person" },
  "/admin/weekly/add": { time: "19:00", dayOfWeek: "3", activities: "salsa" },
  "/admin/holiday": { date: "2026-12-25", on: "1" },
};

// THE RUNTIME VERSION OF THE TEST BELOW, and the reason both exist.
//
// The static one greps each handler's body for `logAudit(`. That is a proxy: the text being present is not the call
// happening. Measured — wrapping the `/board/:id/claim` call as `if (false) logAudit(...)` left the ENTIRE suite
// green, so a route could silently stop recording and the gate named for exactly that would still pass. (No figure
// here: test/docs.test.mjs forbids a test count in a source comment, and it caught the first draft of this
// paragraph, which had one.) The audit log is
// the "what changed, when, who" the privacy notice promises, so a route that quietly stops writing to it is an
// accountability defect, not a cosmetic one.
//
// This drives each audited route over HTTP and requires a row to appear with an actor on it. Fully derived from
// AUDITED — no list of routes to probe, so a new audited route is covered the moment it is added to the decision.
test("every audited route actually writes a row, with an actor, when it acts", async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"] } });
  try {
    const admin = await w.signIn(w.people[0]);
    const token = csrfFromCookie(admin);
    const routes = Object.keys(AUDITED);
    assert.ok(routes.length >= 15, `AUDITED lists only ${routes.length} routes — this test is barely looking`);

    const silent = [];
    const actorless = [];
    for (const pattern of routes) {
      const path = pattern.replace(/:(\w+)/g, () => "1");
      const before = countAudit(w.db);
      await w.post(path, admin, new URLSearchParams({ csrf: token, ...(ACTING_FORM[pattern] ?? {}) }));
      const written = countAudit(w.db) - before;
      if (written === 0) { silent.push(pattern); continue; }
      const row = w.db.prepare(
        "SELECT action, actor_id AS actorId, actor_name AS actorName FROM audit ORDER BY id DESC LIMIT 1").get();
      // An audit row naming nobody answers "what changed" and not "who", which is half the point of having one.
      if (!row.actorName || row.actorId == null) actorless.push(`${pattern} -> ${row.action} (actor ${row.actorName})`);
    }

    assert.deepEqual(silent, [],
      `these routes are listed in AUDITED but wrote no audit row when driven over HTTP: ${silent.join(", ")}. ` +
      `Either the handler does not reach its logAudit call, or the route needs an entry in ACTING_FORM so that it ` +
      `acts instead of failing validation`);
    assert.deepEqual(actorless, [], `these routes recorded a row with no actor: ${actorless.join("; ")}`);
  } finally { w.close(); }
});

// The list above says what SHOULD be logged. This says the handler actually calls the writer — the two are
// different claims, and the gap between them is where a route quietly stops recording.
//
// Kept alongside the runtime test rather than replaced by it: this one fails when a route is added to AUDITED with
// no writer call at all, which is the likelier mistake and gets a clearer message. The runtime test is what proves
// the call happens.
test("every audited route's handler calls the audit writer", () => {
  const src = readFileSync(path.join(ROOT, "src", "server.mjs"), "utf8");
  const parts = src.split(/\bapp\.(get|post)\(\s*"([^"]+)"/);
  const calls = new Map();
  for (let i = 1; i < parts.length; i += 3) {
    if (parts[i] !== "post") continue;
    calls.set(parts[i + 1], /\blogAudit\(/.test(parts[i + 2] ?? ""));
  }
  assert.ok(parts.length > 20, "the route split found almost nothing — this check is not looking at anything");

  const silent = Object.keys(AUDITED).filter((r) => calls.get(r) !== true);
  assert.deepEqual(silent, [],
    "these routes are listed as audited but their handler never calls logAudit:\n  " + silent.join("\n  "));

  const chatty = Object.keys(NOT_AUDITED).filter((r) => calls.get(r) === true);
  assert.deepEqual(chatty, [],
    "these routes are listed as NOT audited but do call logAudit — one of the two is wrong:\n  " + chatty.join("\n  "));
});

test("a planner unassigning somebody is attributable afterwards", async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["planner"] } });
  try {
    for (const p of w.people) makeAvailableEverywhere(w.db, p);
    const slot = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.date >= ? ORDER BY s.date LIMIT 1`).get(w.today).id;
    w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(w.people[1], slot);

    const planner = await w.signIn(w.people[0]);
    const before = countAudit(w.db);
    await w.post("/planner/unassign", planner, new URLSearchParams({
      csrf: csrfFromCookie(planner), assignmentId: String(slot), expect: String(w.people[1]),
    }));

    assert.equal(countAudit(w.db), before + 1, "the unassign left no audit row");
    const row = listAudit(w.db)[0];
    assert.equal(row.action, "planner.unassign");
    assert.equal(row.actorId, w.people[0], "the actor must be the planner who did it, not the person affected");
    assert.ok(row.actorName && row.actorName !== "system", `the actor's name must be recorded, got ${row.actorName}`);
    assert.ok(row.at > "2000-01-01", "an audit row needs a timestamp");
  } finally { w.close(); }
});

// The GDPR bargain, and the reason it is a bargain: the audit keeps its answer to "who", erasure takes away
// "which human". If either side took everything, the other would be pointless.
// ⚠ TWO ADMINS in the fixture, and that is the whole reason this test now covers what it claims to.
//
// It had one, so the erased person WAS the last administrator, `remove` hit the last-admin guard, and the loop
// `continue`d — the mode was never exercised. Under it, the pseudonymisation did nothing at all: the people row is
// deleted first, `PRAGMA foreign_keys = ON`, and `audit.actor_id ... ON DELETE SET NULL` had already nulled the id
// the UPDATE matches on. A hard erasure left the person's full name in the log and reported `auditRenamed: 0`.
//
// A skipped branch inside a loop reads exactly like a covered one. The guard was doing its job; the fixture made
// the test agree with it and call that a pass.
test("erasure pseudonymises the actor in the audit but keeps the rows", async () => {
  for (const mode of ["anonymise", "remove"]) {
    const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"], 1: ["admin"] } });
    try {
      const actor = w.people[0];
      recordAudit(w.db, { actorId: actor, actorName: "Alice Planner", action: "planner.unassign", subject: "assignment:1" });
      recordAudit(w.db, { actorId: actor, actorName: "Alice Planner", action: "admin.role", subject: "person:2" });
      const before = countAudit(w.db);
      assert.equal(before, 2, "the fixture must write audit rows, or this test proves nothing");

      const r = erasePerson(w.db, actor, { mode, today: w.today });
      // NOT tolerated any more. `if (!r.ok) continue` is what let `remove` skip itself for three commits: the
      // fixture had one admin, the guard refused, and the loop moved on reporting a pass. There is a second admin
      // now, so a refusal here means something is wrong rather than that the case does not apply.
      assert.ok(r.ok, `erase ${mode} was refused (${r.reason}) — the fixture has two admins, so it must succeed`);

      assert.equal(countAudit(w.db), before, `${mode}: audit rows were deleted — the trail must survive erasure`);
      const names = new Set(listAudit(w.db).map((x) => x.actorName));
      assert.ok(!names.has("Alice Planner"), `${mode}: the erased person is still named in the audit: ${[...names]}`);
      assert.ok([...names].every((n) => n === `#${actor}`), `${mode}: expected the #id label, got ${[...names]}`);
      assert.equal(r.auditRenamed, 2, `${mode}: erasePerson must report how many audit rows it pseudonymised`);
    } finally { w.close(); }
  }
});

// The test above passed over a broken bargain for three commits, and this is the half it could not see: it read
// `actor_name` only, so a detail naming the same person by their EMAIL ADDRESS was invisible to it. Confirmed by
// probe before being fixed — invite an address, erase the person, and the row still said `invited x@example.org`
// beside a deleted people row and an invitations row scrubbed to 'erased'.
//
// A check that verifies one column of a two-column claim reads exactly like a check that verifies the claim.
test("erasure removes the person's address from audit details too, not only the actor name", async () => {
  for (const mode of ["anonymise", "remove"]) {
    const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin", "planner"] } });
    try {
      const admin = await w.signIn(w.people[0]);
      const EMAIL = "gone@example.org";
      // Through the route, not by calling recordAudit: the defect was in what a handler chose to write, and a
      // fixture writing its own rows would test the fixture's choice instead.
      const res = await w.post("/admin/invite", admin, new URLSearchParams({ csrf: csrfFromCookie(admin), email: EMAIL }));
      assert.ok(res.status < 400, `inviting failed: ${res.status}`);
      const inviteRow = listAudit(w.db).find((r) => r.action === "admin.invite");
      assert.ok(inviteRow, "the invite must be audited, or there is nothing here to leak");

      // The address must not be in the row in the first place. This is the fix; the sweep below is for history.
      assert.ok(!(inviteRow.detail ?? "").includes(EMAIL) && !(inviteRow.subject ?? "").includes(EMAIL),
        `the invited address is stored in the audit row itself: subject=${inviteRow.subject} detail=${inviteRow.detail}`);

      // Now a row written the OLD way, which every existing deployment has, and erasure must reach it.
      const pid = w.db.prepare("INSERT INTO people (name, contact, status) VALUES (?,?,'active') RETURNING id")
        .get("Gone Person", EMAIL).id;
      recordAudit(w.db, { actorId: w.people[0], actorName: "Alice", action: "admin.invite", detail: `invited ${EMAIL}` });
      assert.equal(listAudit(w.db).filter((r) => (r.detail ?? "").includes(EMAIL)).length, 1,
        "the fixture must actually plant the address, or the assertion below passes over nothing");

      const r = erasePerson(w.db, pid, { mode, today: w.today });
      assert.ok(r.ok, `erase ${mode} failed: ${r.reason}`);
      assert.equal(listAudit(w.db).filter((x) => (x.detail ?? "").includes(EMAIL)).length, 0,
        `${mode}: the erased person's address is still in an audit detail`);
      assert.equal(r.auditScrubbed, 1, `${mode}: erasePerson must report how many details it swept`);
      // Swept, not deleted — the row is what makes it an audit trail.
      assert.ok(listAudit(w.db).some((x) => (x.detail ?? "").includes(`#${pid}`)),
        `${mode}: the detail should now point at #${pid} rather than being blanked or dropped`);
    } finally { w.close(); }
  }
});

// The guard that stops the fix being worse than the defect. An empty needle matches every row, so a person with
// no contact on file would sweep the whole table and report a satisfyingly large number.
test("a person with no address on file sweeps nothing", async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] } });
  try {
    const pid = w.db.prepare("INSERT INTO people (name, contact, status) VALUES ('No Contact', NULL, 'active') RETURNING id").get().id;
    recordAudit(w.db, { actorName: "Alice", action: "admin.invite", detail: "invited somebody@example.org" });
    recordAudit(w.db, { actorName: "Alice", action: "planner.assign", detail: "to person:7" });

    const r = erasePerson(w.db, pid, { mode: "remove", today: w.today });
    assert.ok(r.ok, `erase failed: ${r.reason}`);
    assert.equal(r.auditScrubbed, 0, "nothing should have been swept");
    assert.deepEqual(listAudit(w.db).map((x) => x.detail).filter(Boolean).sort(),
      ["invited somebody@example.org", "to person:7"].sort(),
      "an erasure with no address must leave every detail exactly as it was");
  } finally { w.close(); }
});

// Not a list of details to inspect — a journey that performs the audited actions ABOUT a person and then reads the
// rows back. A new handler that writes somebody's name into a detail fails here without anybody remembering to
// add it to a list. Deliberately stricter than the sweep in erasePerson, which only removes the address: a test
// can afford a false alarm and a REPLACE over an audit trail cannot.
test("no audit detail carries a person's name or address", async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"] }, today: "2026-03-01" });
  try {
    for (const p of w.people) makeAvailableEverywhere(w.db, p);
    const admin = await w.signIn(w.people[0]);
    const post = (url, body) => w.post(url, admin, new URLSearchParams({ csrf: csrfFromCookie(admin), ...body }));

    const subject = w.people[1];
    const NAME = w.db.prepare("SELECT name FROM people WHERE id=?").get(subject).name;
    const EMAIL = "journey@example.org";
    w.db.prepare("UPDATE people SET contact=? WHERE id=?").run(EMAIL, subject);

    const slot = w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.date < ? AND a.person_id IS NULL LIMIT 1`).get(w.today)
              ?? w.db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.date < ? LIMIT 1`).get(w.today);
    assert.ok(slot, "the fixture needs a past slot to act on");

    await post("/admin/invite", { email: EMAIL });
    await post("/admin/role", { personId: String(subject), role: "planner", on: "1" });
    await post("/admin/capability", { personId: String(subject), key: "salsa", on: "1" });
    await post("/planner/assign", { assignmentId: String(slot.id), personId: String(subject) });
    await post("/planner/attendance", { assignmentId: String(slot.id), attended: "1" });
    await post("/admin/status", { personId: String(subject), status: "inactive" });

    const rows = listAudit(w.db);
    assert.ok(rows.length >= 5, `the journey must produce audit rows, got ${rows.length}`);
    const leaks = rows.filter((r) => `${r.subject ?? ""} ${r.detail ?? ""}`.includes(NAME)
                                  || `${r.subject ?? ""} ${r.detail ?? ""}`.includes(EMAIL));
    assert.deepEqual(leaks.map((r) => `${r.action}: ${r.subject} | ${r.detail}`), [],
      "these audit rows name a person directly. Refer to them as person:<id> or invitation:<id> instead, so that " +
      "erasing the person empties the reference without anything having to sweep this column");

    // The control: this check must be able to SEE a name in a detail, or its silence means nothing.
    recordAudit(w.db, { actorName: "Alice", action: "planner.assign", detail: `to ${NAME}` });
    assert.ok(listAudit(w.db).some((r) => (r.detail ?? "").includes(NAME)),
      "the detector cannot find a planted name — the assertion above proves nothing");
  } finally { w.close(); }
});

test("retention prunes the audit on its own window, which is longer than the notification one", async () => {
  const w = await makeWorld({ volunteers: 1 });
  try {
    const cfg = retentionConfig(w.pattern);
    assert.ok(cfg.auditDays > cfg.notificationDays,
      `the audit window (${cfg.auditDays}) must outlive the notification window (${cfg.notificationDays}) — the ` +
      `questions an audit answers arrive late`);

    const old = new Date(Date.now() - (cfg.auditDays + 5) * 86400000);
    const recent = new Date(Date.now() - 3 * 86400000);
    recordAudit(w.db, { actorName: "x", action: "planner.assign", at: old });
    recordAudit(w.db, { actorName: "x", action: "planner.assign", at: recent });

    const r = pruneAudit(w.db, { olderThanDays: cfg.auditDays });
    assert.equal(r.removed, 1, "exactly the row past the window should go");
    assert.equal(countAudit(w.db), 1, "and the recent one should stay");
  } finally { w.close(); }
});
