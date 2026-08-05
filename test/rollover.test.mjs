// Increment P. Rollover is the cutover in spec section 7 made safe: an admin confirms a pre-filled form
// instead of editing dates by hand in JSON, which is how a volunteer breaks the config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { makeWorld } from "../tools/testkit.mjs";
import { proposeNextSeason } from "../src/admin.mjs";
import { ROOT, loadPattern, validatePattern } from "../src/config.mjs";
import { setAvailabilityDay, assignSlot, score } from "../src/queries.mjs";

const withAdmin = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin"] }, ...opts });
  try { await fn(w); } finally { w.close(); }
};
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

// ---- the proposal -------------------------------------------------------------------------------------
test("a half-year season rolls to the end of the next half, not to the same day count", () => {
  const base = loadPattern();
  const h1 = proposeNextSeason({ ...base, season: { key: "2026-Q1Q2", from: "2026-01-01", to: "2026-06-30" } });
  assert.deepEqual({ key: h1.key, from: h1.from, to: h1.to }, { key: "2026-Q3Q4", from: "2026-07-01", to: "2026-12-31" });
  // Copying the 180-day length gave 2026-12-28, quietly dropping the last sessions of a season that plainly
  // means "the rest of the year". Snapping is the fix, and this is the assertion that pins it.
  assert.equal(h1.snapped, true);

  const h2 = proposeNextSeason({ ...base, season: { key: "2026-Q3Q4", from: "2026-07-01", to: "2026-12-31" } });
  assert.deepEqual({ key: h2.key, from: h2.from, to: h2.to }, { key: "2027-Q1Q2", from: "2027-01-01", to: "2027-06-30" },
    "and it must cross the year boundary");
});

test("an unrecognised season shape keeps its length and gets a date-based key", () => {
  const base = loadPattern();
  const odd = proposeNextSeason({ ...base, season: { key: "spring-term", from: "2026-02-01", to: "2026-04-30" } });
  assert.equal(odd.snapped, false, "guessing a half-year from an unknown shape would be wrong");
  assert.equal(odd.from, "2026-05-01");
  assert.equal(odd.to, "2026-07-28", "same 88-day length");
  assert.equal(odd.key, "2026-05-01--2026-07-28", "ugly but unambiguous beats a wrong guess");
});

test("whatever is proposed must be a config the app can actually load", () => {
  const base = loadPattern();
  for (const season of [
    { key: "2026-Q1Q2", from: "2026-01-01", to: "2026-06-30" },
    { key: "2026-Q3Q4", from: "2026-07-01", to: "2026-12-31" },
    { key: "one-off", from: "2026-03-15", to: "2026-03-16" },
  ]) {
    const next = proposeNextSeason({ ...base, season });
    assert.ok(validatePattern({ ...base, season: { key: next.key, from: next.from, to: next.to } }),
      `proposal from ${season.key} does not validate`);
    assert.ok(next.from > season.to, "the next season must start after this one ends");
    assert.ok(next.to >= next.from);
  }
});

// ---- rolling over for real ----------------------------------------------------------------------------
test("rolling over starts an empty season and carries people and capabilities", withAdmin({}, async (w) => {
  // Give the current season real content, so "carried over" and "reset" are distinguishable.
  setAvailabilityDay(w.db, w.people[1], w.pattern.season.from, true);
  const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  assignSlot(w.db, slot, w.people[1], { expectPersonId: null });
  const capsBefore = w.db.prepare("SELECT COUNT(*) n FROM capabilities").get().n;
  assert.ok(capsBefore > 0);

  const next = proposeNextSeason(w.pattern);
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const r = await w.post("/admin/season", admin, new URLSearchParams({
    csrf: token, seasonKey: next.key, seasonFrom: next.from, seasonTo: next.to, cutoffDays: "2",
  }));
  assert.equal(reasonOf(r), "saved");

  // The new season exists with its own sessions...
  const created = w.db.prepare("SELECT id FROM seasons WHERE key=?").get(next.key);
  assert.ok(created, "the new season should be materialised");
  const fresh = w.db.prepare("SELECT COUNT(*) n FROM sessions WHERE season_id=?").get(created.id).n;
  assert.ok(fresh > 0, "and have dates to schedule");

  // ...and it starts UNPLANNED — which means the slots exist and nobody is in them.
  //
  // This used to assert that the count was ZERO, with a comment explaining that openEverySession "is not part
  // of a rollover". That comment was not recording a decision; it was recording a BUG, and this test was what
  // held it in place. A new season with no slots cannot be planned at all — empty shift exchange, nothing for
  // the planner to assign, auto-roster reporting nothing to propose. Asserting the absence of those rows was
  // asserting that the feature does not work.
  const rows = w.db.prepare(`SELECT COUNT(*) n FROM assignments a JOIN sessions s ON s.id=a.session_id
                              WHERE s.season_id=?`).get(created.id).n;
  const taken = w.db.prepare(`SELECT COUNT(*) n FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.season_id=? AND a.person_id IS NOT NULL`).get(created.id).n;
  assert.ok(rows > 0, "a new season must open its slots, or there is nothing to plan");
  assert.equal(taken, 0, "and nobody is assigned to any of them yet — that is what unplanned means");

  // People and capabilities are not season-scoped, so they simply survive.
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM capabilities").get().n, capsBefore);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM people").get().n, 3);

  // Score is per-season, so it resets for the new one while the old season keeps its history.
  assert.equal(score(w.db, w.people[1], created.id), 0, "Score starts from zero in a new season");
  assert.equal(score(w.db, w.people[1], w.seasonId), 1, "and the previous season still remembers");
}));

// The rollover moved the pages and left the BACKGROUND JOBS behind, which is the half nothing looked at.
//
// buildApp keeps a mutable `cfg` so an admin's config edit is picked up without a restart. The boot block built
// the nudge job's season getter as a closure over the pattern it loaded at startup — a different variable, never
// reassigned. Measured through this same route before the fix: rolling 2026-Q1Q2 to 2026-Q3Q4 seeded 106 sessions
// into the new season, the pages followed, and the jobs' getter still returned the OLD season's id. Both
// notification features then work a season entirely in the past, so nobody is nudged and nobody is reminded until
// somebody restarts — and /status shows a recent run having sent 0, which is what a healthy quiet instance looks
// like. Season rollover is the one operation this app was built to support.
//
// The control is the point of this test: it holds BOTH getters, the fixed one and the frozen one, and asserts they
// now disagree. Without the frozen half it would pass on an app that never reloads anything.
test("a rollover moves the season the background jobs work on, not just the pages", async () => {
  const reloads = [];
  const w = await makeWorld({
    volunteers: 3, roles: { 0: ["admin"] },
    onPatternChange: (next) => reloads.push(next),
  });
  try {
    // Exactly the boot block's wiring: a mutable holder the callback updates, and a getter over it.
    let live = w.pattern;
    const jobsSeasonId = () => w.db.prepare("SELECT id FROM seasons WHERE key = ?").get(live.season.key)?.id ?? null;
    // And the frozen version, which is what the code used to do.
    const frozen = w.pattern;
    const staleSeasonId = () => w.db.prepare("SELECT id FROM seasons WHERE key = ?").get(frozen.season.key)?.id ?? null;
    const before = jobsSeasonId();
    assert.ok(before, "precondition: the jobs can see the current season to begin with");

    const next = proposeNextSeason(w.pattern);
    const admin = await w.signIn(w.people[0]);
    const { token } = await w.csrfFrom("/admin", admin);
    const r = await w.post("/admin/season", admin, new URLSearchParams({
      csrf: token, seasonKey: next.key, seasonFrom: next.from, seasonTo: next.to,
    }));
    assert.equal(reasonOf(r), "saved");

    // The hook fired, once, with the pattern that was actually written.
    assert.equal(reloads.length, 1, "a config edit must announce itself, or anything holding the old one is stale");
    assert.equal(reloads.at(-1).season.key, next.key);

    // Keep the holder in step exactly as the boot block does, then check what the jobs would now query.
    live = reloads.at(-1);
    const created = w.db.prepare("SELECT id FROM seasons WHERE key=?").get(next.key);
    assert.ok(created, "the new season should be materialised");
    assert.equal(jobsSeasonId(), created.id, "the nudge and the shift reminders must follow the season over");
    assert.notEqual(jobsSeasonId(), before, "and must not still be pointed at the season that just ended");

    // THE CONTROL: the frozen getter is still on the old season. If this ever stops being true, this test has
    // stopped distinguishing the fix from the bug.
    assert.equal(staleSeasonId(), before,
      "a getter closed over the booted pattern must still be stale — that is the defect this reproduces");
  } finally { w.close(); }
});

// A wiring check, because the boot block only runs when server.mjs is the main module and no test can reach it.
// Both features that shipped dead in production were dead for this exact reason: the wiring existed nowhere, and
// every test built its world through the harness instead. Asserting the wiring is present is the cheapest thing
// that would have caught either of them.
test("the boot block wires the config reload into the jobs, and does not close over the booted pattern", () => {
  const src = readFileSync(path.join(ROOT, "src", "server.mjs"), "utf8");
  const boot = src.slice(src.indexOf("import.meta.url === pathToFileURL"));
  assert.ok(boot.length > 500, "the boot block was not located — this check is not looking at anything");

  assert.match(boot, /onPatternChange:/,
    "the boot block must pass onPatternChange, or an admin's season change never reaches the nudge timer");
  assert.match(boot, /seasonId: currentSeasonId/, "and the jobs must take a getter rather than a fixed id");
  assert.ok(!/get\(boot\.season\.key\)/.test(boot),
    "the jobs' season getter must not read the booted pattern directly — that is what went stale");
});

test("the admin screen offers the rollover pre-filled, and the button names the season", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const body = await (await w.get("/admin", admin)).text();
  const next = proposeNextSeason(w.pattern);
  assert.match(body, new RegExp(`value="${next.key}"`), "the key should be pre-filled, not typed from memory");
  assert.match(body, new RegExp(`value="${next.from}"`));
  assert.match(body, new RegExp(`value="${next.to}"`));
  assert.match(body, new RegExp(`Create ${next.key}|Opret ${next.key}`), "the button must say what it will do");
  assert.match(body, /carry over|følger med/, "and what carries over versus resets");
}));

test("the rollover form is still validated — a corrected-but-broken date is refused", withAdmin({}, async (w) => {
  const before = readFileSync(w.patternFile, "utf8");
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const r = await w.post("/admin/season", admin, new URLSearchParams({
    csrf: token, seasonKey: "2027-Q1Q2", seasonFrom: "2027-06-30", seasonTo: "2027-01-01",
  }));
  assert.equal(reasonOf(r), "invalid", "editing the pre-filled dates must not bypass validation");
  assert.equal(readFileSync(w.patternFile, "utf8"), before);
}));

// ---- release engineering ------------------------------------------------------------------------------
test("the project ships the files a handover needs", () => {
  for (const f of ["LICENSE", "CONTRIBUTING.md", "RUNBOOK.md", "README.md", "PLAN.md",
                   "docs/OIDC.md", "docs/PRIVACY.md", ".github/workflows/test.yml",
                   ".env.example", ".gitignore", ".dockerignore", "Dockerfile", "compose.yml"]) {
    assert.ok(existsSync(path.join(ROOT, f)), `missing ${f} — somebody inheriting this will need it`);
  }
});

test("package.json describes something runnable, with no dependencies", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.ok(!pkg.dependencies, "a dependency appearing here is the story, not a detail");
  assert.ok(!pkg.devDependencies);
  assert.match(pkg.engines.node, /22\.5|2[2-9]/, "node:sqlite needs >= 22.5");
  for (const s of ["test", "start", "demo", "backup", "bootstrap"]) {
    assert.ok(pkg.scripts[s], `npm run ${s} should exist — it is what the runbook tells people to type`);
  }
  assert.equal(pkg.license, "AGPL-3.0-or-later");
  assert.ok(pkg.version && pkg.version !== "0.0.0");
});

test("CI runs the suite, the fresh-deployment check, and the backup restore", () => {
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(ci, /node --test/, "the suite must run");
  assert.match(ci, /22\.14/, "the version the Dockerfile pins is the one that matters");
  assert.match(ci, /healthz/, "and a fresh deployment must be proven to come up");
  assert.match(ci, /verifyBackup|integrity/, "and a backup proven to restore");
  // The bug that shipped was seeding-on-boot. CI has to check the thing the harness hides.
  assert.match(ci, /seeded no sessions|COUNT\(\*\) n FROM sessions/, "CI must catch an inert deployment");
  assert.ok(!/npm (install|ci)\b/.test(ci.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")),
    "there is nothing to install");
});

test("the licence tells the board the choice is theirs", () => {
  const l = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  assert.match(l, /AGPL/);
  assert.match(l, /4water/);
  assert.match(l, /board/i, "a licence picked by the developer without saying so is a decision taken quietly");
});
