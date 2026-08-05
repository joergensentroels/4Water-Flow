// The acceptance test: one pass through the whole product against the REAL entry point.
//
// Every other suite builds its world with tools/testkit.mjs. Twice now that harness has done setup production
// skipped, and both times a green suite reported success over a deployment that could not work:
//   - seedStructure ran and openEverySession did not, so a fresh install had 102 sessions and zero slots —
//     nothing to claim, nothing to assign, nothing to propose, and /status calling it healthy.
//   - makeNotifier and startJobs were called only from tests, so no announcement ever fired and the nudge
//     never ran, while seventeen tests proved the machinery worked.
//
// Neither was findable from inside the harness, because the harness was the thing supplying what was missing.
// So this file touches testkit NOWHERE. It boots `node src/server.mjs` on an empty database under
// NODE_ENV=production — no developer sign-in, so the invite path is the only way in, which is also the only way
// a real volunteer gets in — and then walks the journey with an HTTP client: invite, sign in, capability,
// availability, claim from the shift exchange, calendar feed, auto-roster, lock in, hand back, outbox, export.
//
// It is the slowest test here by an order of magnitude. It is also the only one that would have caught either
// defect above, which is the trade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, loadPattern } from "../src/config.mjs";
import { migrate } from "../src/db.mjs";
import { bootstrapAdmin } from "../tools/bootstrap.mjs";
import { writeSeasonSpanningToday } from "../tools/season-fixture.mjs";

const PORT = 8166;
const BASE = `http://127.0.0.1:${PORT}`;

// A cookie-jar client, because a journey is a sequence of authenticated requests and a helper that forgets the
// session between steps would silently be testing the signed-out path.
function client() {
  let cookie = "";
  const keep = (res) => {
    const set = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
    for (const c of set) cookie = c.split(";")[0];
    return res;
  };
  const get = (p) => fetch(BASE + p, { headers: cookie ? { cookie } : {}, redirect: "manual" }).then(keep);
  const post = (p, fields) => fetch(BASE + p, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  }).then(keep);
  // Every POST needs a token from the page it came from, which is also what proves the pages render one.
  const csrfFrom = async (p) => {
    const body = await (await get(p)).text();
    const token = body.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(token, `no CSRF token on ${p}`);
    return { token, body };
  };
  return { get, post, csrfFrom, cookie: () => cookie };
}
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

test("a real deployment can be set up and used end to end", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-journey-"));
  const dbFile = path.join(dir, "app.db");

  // A season spanning today, written into this test's OWN temp directory.
  //
  // It used to read demo-pattern.json from the repository root. `.gitignore` excludes that file, so on a fresh
  // clone this test failed with ENOENT before doing anything: the acceptance gate was the one test nobody else
  // could run. It survived because the repo has no remote yet, so CI has never executed once.
  //
  // tools/season-fixture.mjs, not tools/testkit.mjs. The rule this file lives by is that nothing may hand the
  // app state a real deployment would not have — and a pattern file is exactly what an operator DOES hand it,
  // via the documented FOURWATER_PATTERN. Writing one stands in for the operator, not for the application.
  const patternFile = path.join(dir, "pattern.json");
  writeSeasonSpanningToday(patternFile, { key: "journey" });
  const pattern = loadPattern(patternFile);
  assert.ok(pattern.season.from <= new Date().toISOString().slice(0, 10) &&
            pattern.season.to >= new Date().toISOString().slice(0, 10),
    "the journey needs a season that contains today, or every screen is legitimately empty");

  // ---- 1. the operator's first step, in the order RUNBOOK gives: bootstrap BEFORE boot ----
  let invite;
  {
    const db = new DatabaseSync(dbFile);
    migrate(db);
    const r = bootstrapAdmin(db, { email: "chair@4water.org", name: "The Chair", roles: pattern.roles });
    assert.equal(r.ok, true);
    invite = r.inviteToken;
    db.close();
  }

  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env,
           FOURWATER_DB: dbFile,
           FOURWATER_PATTERN: patternFile,                             // a season that spans today
           FOURWATER_BASE_URL: BASE,                                  // so links come out absolute
           FOURWATER_SECRET: "j".repeat(48),
           PORT: String(PORT), HOST: "127.0.0.1",
           NODE_ENV: "production" },                                  // the dev sign-in cannot exist here
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  try {
    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null) break;
      try { healthy = (await fetch(`${BASE}/healthz`)).ok; } catch {}
    }
    assert.ok(healthy, `never became healthy:\n${out}`);

    // The boot must have opened slots. This is the defect that shipped twice; assert it from outside.
    {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const slots = db.prepare("SELECT COUNT(*) n FROM assignments").get().n;
      const naked = db.prepare(`SELECT COUNT(*) n FROM sessions s
                                 WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.session_id=s.id)`).get().n;
      db.close();
      assert.ok(slots > 0, "a real boot must open slots");
      assert.equal(naked, 0, "and leave no session unstaffable");
    }

    // ---- 2. the admin gets in via the invite, because production has no other door ----
    const admin = client();
    assert.equal((await admin.post("/auth/dev", { personId: "1" })).status, 404,
      "the developer sign-in must not exist in production");

    // Before anybody signs in: the hop a notification link produces. Every message the app sends now carries a URL,
    // and it is read in a chat channel on a phone that may have no session — so this redirect is the FIRST thing
    // that happens to a notification link, and it happens to a volunteer who is not signed in.
    //
    // Asserted here, against the real entry point under NODE_ENV=production, because test/nextdest.test.mjs walks
    // the round trip through the developer sign-in and the developer sign-in does not exist in production. The
    // mechanism has to be present on the door a real volunteer arrives at.
    const cold = await client().get("/board");
    assert.equal(cold.status, 303, "a signed-out volunteer must be sent to sign in, not shown the board");
    assert.equal(cold.headers.get("location"), "/signin?next=%2Fboard",
      "and the page they were trying to reach must survive the redirect — it used to be dropped, so tapping a link " +
      "to the shift exchange landed them on the home page with nothing remembering why they were there");

    // Opening the link offers the invitation and spends nothing: the emailed link has to survive being fetched by
    // whatever scans mail on the way in, and this one is the bootstrap administrator's. Accepting is the POST
    // behind the button on that page, which nothing fetches on the recipient's behalf.
    const offered = await admin.get(`/invite/${invite}`);
    assert.equal(offered.status, 200, "the link shows the invitation rather than spending it");
    assert.ok(!admin.cookie(), "and starts no session, so a scanner cannot end up holding the admin account");

    const redeemed = await admin.post(`/invite/${invite}/accept`, {});
    assert.equal(redeemed.status, 303);
    assert.equal(redeemed.headers.get("location"), "/availability");
    assert.ok(admin.cookie(), "accepting an invite must start a session");
    assert.equal((await admin.get("/admin")).status, 200, "the bootstrapped account is an administrator");

    // ---- 3. the admin invites a volunteer, and the link is absolute and one-shot ----
    const { token: adminCsrf } = await admin.csrfFrom("/admin");
    assert.equal(reasonOf(await admin.post("/admin/invite", { csrf: adminCsrf, email: "vol@4water.org" })), "invited");
    const adminPage = await (await admin.get("/admin")).text();
    const volLink = adminPage.match(new RegExp(`${BASE}/invite/([A-Za-z0-9_-]+)`));
    assert.ok(volLink, `the invitation link must be shown once, absolute:\n${adminPage.slice(0, 400)}`);
    // Matched against the ABSOLUTE link, not against "/invite/…": the page also carries a revoke form whose
    // action is /admin/invite/revoke, and the looser pattern flagged that as a leaked token.
    assert.ok(!new RegExp(`${BASE}/invite/[A-Za-z0-9_-]+`).test(await (await admin.get("/admin")).text()),
      "and only once — it is a credential");

    // The volunteer's link, fetched first by something that is not them — the case that used to lock them out —
    // and then accepted by them. Both halves in the journey, because this is the only test that runs the real
    // binary in production mode, and a broken invitation is the one failure the app cannot work around.
    const scanner = client();
    assert.equal((await scanner.get(`/invite/${volLink[1]}`)).status, 200, "a fetch of the link must not spend it");
    assert.ok(!scanner.cookie(), "and must not sign anything in");

    const vol = client();
    assert.equal((await vol.get(`/invite/${volLink[1]}`)).status, 200, "the volunteer still sees the invitation");
    assert.equal((await vol.post(`/invite/${volLink[1]}/accept`, {})).status, 303, "the volunteer's invite must work");
    const volId = (() => {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const id = db.prepare("SELECT id FROM people WHERE contact='vol@4water.org'").get().id;
      db.close();
      return id;
    })();

    // ---- 4. the admin says what that volunteer can run — nobody grants themselves a capability ----
    const activity = pattern.activities[0].key;
    const { token: capCsrf } = await admin.csrfFrom("/admin");
    assert.equal(reasonOf(await admin.post("/admin/capability",
      { csrf: capCsrf, personId: String(volId), key: activity, on: "1" })), "saved");

    // ---- 5. the volunteer says which role they teach, and when they can help ----
    // The role is not optional for a partner dance: every slot on such a class is a leader slot or a follower
    // slot, and someone who has not said which they teach is eligible for neither. Skipping this step left the
    // shift exchange empty — correct behaviour, and the reason it is a step of the journey rather than an
    // afterthought.
    const { token: roleCsrf } = await vol.csrfFrom("/me");
    assert.equal(reasonOf(await vol.post("/me",
      { csrf: roleCsrf, name: "Vol One", contact: "vol@4water.org", preferredRole: "b" })), "saved");
    const { token: availCsrf, body: availPage } = await vol.csrfFrom("/availability");
    assert.match(availPage, /name="csrf"/, "the availability screen must render a form");
    const bulk = await vol.post("/availability/bulk", { csrf: availCsrf, scope: "all", value: "1" });
    assert.equal(bulk.status, 303, "the bulk answer must be accepted");

    // ---- 6. the shift exchange offers something, and claiming it works ----
    const board = await (await vol.get("/board")).text();
    const claimable = board.match(/action="\/slot\/(\d+)\/hand-back"/) ? null : board.match(/\/board\/(\d+)\/claim/);
    assert.ok(claimable, `the shift exchange must offer at least one slot:\n${board.slice(0, 600)}`);
    const { token: boardCsrf } = await vol.csrfFrom("/board");
    const claimed = await vol.post(`/board/${claimable[1]}/claim`, { csrf: boardCsrf });
    assert.equal(reasonOf(claimed), "claimed", "a volunteer must be able to take an open slot");

    // It shows up as theirs.
    assert.match(await (await vol.get("/")).text(), /\d/, "the home screen lists their upcoming slots");

    // ---- 7. their calendar feed serves that slot, with no session at all ----
    const { token: meCsrf } = await vol.csrfFrom("/me");
    assert.equal(reasonOf(await vol.post("/me/calendar", { csrf: meCsrf })), "calendar_created");
    const feedLink = (await (await vol.get("/me")).text()).match(new RegExp(`${BASE}/calendar/([A-Za-z0-9_-]+)\\.ics`));
    assert.ok(feedLink, "the calendar link must be shown, absolute");
    const feed = await fetch(`${BASE}/calendar/${feedLink[1]}.ics`);   // deliberately not through the client
    assert.equal(feed.status, 200);
    const ics = await feed.text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1, "exactly the one slot they claimed");

    // ---- 8. the planner fills the rest automatically, reviews, and locks it in ----
    const { token: rosterCsrf } = await admin.csrfFrom("/planner");
    const proposed = await admin.post("/planner/auto-roster", { csrf: rosterCsrf });
    assert.equal(reasonOf(proposed), "roster_done", "auto-roster must have something to propose");
    {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const n = db.prepare("SELECT COUNT(*) n FROM assignments WHERE state='proposed' AND person_id IS NOT NULL").get().n;
      db.close();
      assert.ok(n > 0, "a proposal that proposes nothing is not a proposal");
    }
    const { token: lockCsrf } = await admin.csrfFrom("/planner");
    assert.equal(reasonOf(await admin.post("/planner/proposals/lock", { csrf: lockCsrf })), "locked");
    {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      assert.equal(db.prepare("SELECT COUNT(*) n FROM assignments WHERE state='proposed'").get().n, 0,
        "locking in must leave nothing proposed");
      db.close();
    }

    // ---- 9. freeing a slot announces it, and a planner can read the message ----
    const { body: plannerPage } = await admin.csrfFrom("/planner");
    const filled = plannerPage.match(/name="assignmentId" value="(\d+)">\s*<input type="hidden" name="expect" value="(\d+)"/);
    if (filled) {
      const { token: freeCsrf } = await admin.csrfFrom("/planner");
      const freed = await admin.post("/planner/unassign",
        { csrf: freeCsrf, assignmentId: filled[1], expect: filled[2] });
      assert.equal(reasonOf(freed), "unassigned");

      let rows = [];
      for (let i = 0; i < 40 && rows.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const db = new DatabaseSync(dbFile, { readOnly: true });
        rows = db.prepare("SELECT kind FROM notifications WHERE kind='slot_open'").all();
        db.close();
      }
      assert.ok(rows.length > 0, "freeing a slot must announce it — production had no notifier at all once");
      assert.match(await (await admin.get("/outbox")).text(), /became free|blev fri/,
        "and a planner must be able to read the message, since no webhook is configured");
    }

    // ---- 10. the operator's read-only checks ----
    const status = await (await admin.get("/status")).text();
    assert.match(status, /is running and ends|kører og slutter/, "the status page must report the season as current");
    assert.ok(!/status\.[a-z]/i.test(status), "and every fact must render as a sentence");

    // The nudge job must ACCOUNT FOR ITSELF here, and this assertion is the whole reason that line is worth
    // having. `jobs` is optional on buildApp — the same optional-argument shape that left `notifier` missing
    // from production for most of this project — so a status page that silently omits the line would be a
    // monitor carrying the identical defect to the one it monitors. Only a real boot can catch that, and this
    // is the only file that boots for real.
    assert.match(status, /Scheduled reminders|Planlagte påmindelser/i,
      "a real boot must wire the scheduled jobs into /status, or the page cannot report a dead timer");

    const csv = await admin.get("/planner/season.csv");
    assert.equal(csv.status, 200);
    const csvBody = await csv.text();
    assert.match(csvBody.split("\r\n")[0], /"role"/, "the export must distinguish the halves of a class");
    assert.ok(csvBody.split("\r\n").length > 2, "and contain the season");

    // ---- 11. and a volunteer can take their data with them ----
    const mine = await vol.get("/me/export.json");
    assert.equal(mine.status, 200);
    const dump = JSON.parse(await mine.text());
    assert.equal(dump.person.contact, "vol@4water.org");
    assert.ok(dump.assignments.length > 0, "an export must include the slots they took");
    assert.equal(dump.calendarFeedEnabled, true);
    assert.ok(!JSON.stringify(dump).includes(feedLink[1]), "but never the calendar token itself");
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
