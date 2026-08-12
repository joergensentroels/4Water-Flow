// Increment P. Rollover is the cutover in spec section 7 made safe: an admin confirms a pre-filled form
// instead of editing dates by hand in JSON, which is how a volunteer breaks the config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
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
  // RUNTIME dependencies stay at zero, and that is the property worth protecting: a deployer clones this, runs
  // node, and is done — no install step, no lockfile, nothing between them and the app.
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    "a RUNTIME dependency appearing here is the story, not a detail — the app must run from a clone with no install");

  // devDependencies are allowed one at a time, each with the reason it earns its place. An allowlist rather than a
  // free hand: the rule was never "no packages", it was "nothing between a deployer and running this", and a
  // test-only package does not sit there. Anything unlisted still fails.
  const DEV_ALLOWED = {
    "axe-core": "the accessibility gate in test/a11y.test.mjs. A hand-written UX pass over these screens got three "
      + "of seven findings wrong and missed four unlabelled date inputs entirely — 'does every input have an "
      + "accessible name' is not a judgement call and should not be checked by one.",
    jsdom: "gives axe-core a DOM to walk. It has no layout engine, so colour-contrast is checked separately in a "
      + "real browser; tools/a11y.mjs names every rule it therefore cannot run.",
  };
  const unexplained = Object.keys(pkg.devDependencies || {}).filter((d) => !(d in DEV_ALLOWED));
  assert.deepEqual(unexplained, [],
    `every devDependency needs its reason in DEV_ALLOWED — these have none: ${unexplained.join(", ")}`);
  // And the image must never install them. .dockerignore keeps the tools out; the Dockerfile installs nothing.
  // COMMENTS STRIPPED FIRST. The Dockerfile's own comment says "There is no `npm install` here because there is
  // nothing to install" — and the first version of this assertion matched that sentence and failed on a file that
  // was already correct. Same trap the CI-workflow check above documents.
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.ok(!/npm\s+(ci|install)/.test(dockerfile),
    "the Dockerfile must not install anything — devDependencies are for the suite, not for the deployment");
  assert.match(pkg.engines.node, /22\.5|2[2-9]/, "node:sqlite needs >= 22.5");
  for (const s of ["test", "start", "demo", "backup", "bootstrap"]) {
    assert.ok(pkg.scripts[s], `npm run ${s} should exist — it is what the runbook tells people to type`);
  }
  assert.equal(pkg.license, "AGPL-3.0-or-later");
  assert.ok(pkg.version && pkg.version !== "0.0.0");
});

test("CI runs the suite, the fresh-deployment check, and the backup restore", () => {
  const raw = readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  // COMMENTS STRIPPED FOR EVERY ASSERTION, not just one of them. This test used to read the raw file for six checks
  // and strip comments for the seventh, and the divergence cost exactly what it looks like it would: the workflow's
  // suite step was changed from `node --test` to `npm test`, a comment was added explaining why, and
  // `assert.match(ci, /node --test/, "the suite must run")` went on passing — satisfied by the comment, with the
  // phrase appearing nowhere in anything CI executes. That is the same defect this project has now paid for about a
  // dozen times: a check that reads source text can be silenced by prose about the thing it checks. Here the fix was
  // already present in the same function, on one line, and had not been applied to its siblings.
  const ci = raw.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

  // The suite command is compared to package.json rather than to a literal, because the two drifting apart IS the
  // defect this assertion exists to catch. `npm test` runs tools/precheck.mjs first; CI ran `node --test` and skipped
  // it, and precheck exists because a single unterminated template literal once left a quarter of the test files unrun
  // with the suite going unreliable rather than red. The gate was running the weaker of the two available commands.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /precheck/, "npm test must still be the command that parses everything first");
  // The suite step pipes through `tee` now, so the command is no longer the whole line: CI echoes a failure into an
  // annotation as well as the log, because reading the log needs a signed-in session with admin rights and reading
  // an annotation does not. This workflow was red for its entire existence with nobody able to see why. So the
  // command is matched as INVOKED — a redirection or pipeline may follow — rather than having to end the line.
  const escaped = pkg.scripts.test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const runsTheSuite = (yaml) =>
    new RegExp(`(?:^\\s*run:\\s*|^\\s*)(?:npm test|${escaped})(?=\\s*(?:2>&1|\\||$))`, "m").test(yaml);
  assert.ok(runsTheSuite(ci),
    `CI must run the same command a developer runs (\`npm test\`, or literally \`${pkg.scripts.test}\`) — running a `
    + "subset means the gate is weaker than the local check, which is the wrong way round");
  // The control, because the assertion above was deliberately loosened. A loosened check that now passes on the
  // very workflow it was written to reject is worse than no check, and nothing else here would notice.
  assert.ok(!runsTheSuite(ci.replace(/npm test/g, "node --test")),
    "the check must still fail on a workflow whose suite step is `node --test` — that is the defect it exists for");

  assert.match(ci, /22\.14/, "the version the Dockerfile pins is the one that matters");
  assert.match(ci, /healthz/, "and a fresh deployment must be proven to come up");
  assert.match(ci, /verifyBackup|integrity/, "and a backup proven to restore");
  // The bug that shipped was seeding-on-boot. CI has to check the thing the harness hides.
  assert.match(ci, /seeded no sessions|COUNT\(\*\) n FROM sessions/, "CI must catch an inert deployment");
  // An assertion that never runs is invisible to a green suite, so the gate has to ask. See tools/deadassert.mjs.
  assert.match(ci, /deadassert/, "CI must check that no assertion in the suite is one that never executes");
  // Same reason, other tool: a check satisfied by prose about the thing it checks is this project's most
  // repeated defect, and the sweep for it only counts if the gate runs it.
  assert.match(ci, /proseproof/, "CI must check that no check in the suite is satisfied by a comment");
  // CI installs the test-only packages, and only those. This assertion used to forbid an install outright, which
  // was the right rule while devDependencies were empty and the wrong one the moment the accessibility gate needed
  // axe-core. What it protects now is the distinction that actually matters: the SUITE may install, a DEPLOYMENT
  // may not. The Dockerfile check in the package.json test above holds the other half.
  assert.match(ci, /npm ci\b/, "CI must install the test-only packages, or test/a11y.test.mjs cannot load");
  assert.ok(!/npm install\b/.test(ci),
    "use `npm ci` and not `npm install` — CI must build from the lockfile, not resolve versions afresh");
});

test("the licence tells the board the choice is theirs", () => {
  const l = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  assert.match(l, /AGPL/);
  assert.match(l, /4water/);
  assert.match(l, /board/i, "a licence picked by the developer without saying so is a decision taken quietly");
});

// ---- the version must not claim a name a tag has already given to a different commit -------------------------------
//
// Found by asking where v1.0.0-rc.1 actually points: at commit 37, with HEAD at 152. ONE HUNDRED AND FIFTEEN commits
// behind — every fix since, including the GDPR export gaps, the retention sweep that never ran, the two screens showing
// the past, and the demo that crashed on a second run. And package.json still said `1.0.0-rc.1`, so the tree claimed to
// BE rc.1 while rc.1 named something 115 commits older, and /status told an operator the same thing. The answer to "what
// version am I running" was a name that meant a different program.
//
// The rule is release hygiene rather than taste: after tagging, the version string must move, or every commit that
// follows misrepresents itself. Stated as the check that catches it — if a tag exists for this version and does not
// point at HEAD, the version was never bumped.
//
// Deliberately NOT a rule about tagging. Whether HEAD deserves a tag, and what to call it, is a judgement; whether the
// tree may claim a name that is already taken is not.
test("package.json does not claim a version some other commit already holds", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const tags = execSync("git tag -l", { cwd: ROOT, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(pkg.version, "package.json must state a version");

  const mine = tags.filter((t) => t === `v${pkg.version}` || t === pkg.version);
  if (mine.length === 0) return;   // no tag for this version yet: the ordinary state between releases

  const head = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  for (const tag of mine) {
    const at = execSync(`git rev-list -n 1 ${tag}`, { cwd: ROOT, encoding: "utf8" }).trim();
    const behind = execSync(`git rev-list --count ${tag}..HEAD`, { cwd: ROOT, encoding: "utf8" }).trim();
    // deadassert: dormant — no tag names the current version between releases, which is the ordinary state; the test below is what stays live
    assert.equal(at, head,
      `package.json says ${pkg.version} and the tag ${tag} points ${behind} commit(s) earlier. Whatever is here is not `
      + `what that name means. Bump the version — tagging HEAD is a separate decision.`);
  }
});

// The control for the test above, and it is the half that matters: the check must FIRE when the version is a taken
// name, not merely pass when it is a free one. Verified by reading the tag that caused this — v1.0.0-rc.1 exists, and a
// tree claiming that version while sitting anywhere else must fail.
test("and that check fires rather than merely passing on an untagged version", () => {
  const tags = execSync("git tag -l", { cwd: ROOT, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(tags.length > 0, "there must be at least one tag, or the test above is vacuous for a different reason");
  const head = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  const stale = tags.filter((t) => execSync(`git rev-list -n 1 ${t}`, { cwd: ROOT, encoding: "utf8" }).trim() !== head);
  assert.ok(stale.length > 0,
    "every tag points at HEAD, so the check above cannot currently distinguish a bumped version from a stale one — "
    + "which means it is passing for a reason unrelated to what it asserts");
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(!stale.some((t) => t === `v${pkg.version}` || t === pkg.version),
    `the version claims ${pkg.version}, which one of these tags already holds elsewhere: ${stale.join(", ")}`);
});

// ---- the local gate and CI must run the same checks ---------------------------------------------------------------
//
// CI already gained a check a developer did not have, in the other direction: it ran `node --test` while `npm test` ran
// the parse check first, and nobody had compared them. So the two lists are compared here rather than maintained.
//
// The hook exists because of one specific sequence: three commits in a row shipped with something the tools would have
// caught, including a message asserting "deadassert exits 0" that had never been run. Over those three the habit failed
// three times out of three and the instrument failed none — it was simply consulted afterwards. A pre-push hook is the
// last moment a mistake is still private.
test("the pre-push hook runs the same tools as CI, in both directions", () => {
  const hookPath = path.join(ROOT, ".githooks", "pre-push");
  assert.ok(existsSync(hookPath), "there must be a pre-push hook, or the local gate is whatever somebody remembers");
  const hook = readFileSync(hookPath, "utf8");
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8")
    .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  // Comments stripped from BOTH, for the reason the CI check above records: a mention in prose is not an invocation.
  const runnableHook = hook.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

  const toolsIn = (text) => [...new Set([...text.matchAll(/node tools\/([a-z-]+)\.mjs/g)].map((m) => m[1]))].sort();
  const inHook = toolsIn(runnableHook);
  const inCi = toolsIn(ci).filter((t) => t !== "backup");   // CI also proves a backup restores; that needs a live server
  assert.ok(inHook.length >= 2, `the hook invokes only ${inHook.join(", ") || "nothing"} — it is not a gate`);
  assert.deepEqual(inHook, inCi,
    `the hook runs [${inHook.join(", ")}] and CI runs [${inCi.join(", ")}]. Whichever list is shorter is the gate that `
    + "lets something through, and a developer discovering it on a push is the wrong way round");

  // And the suite itself, by the same command a developer runs — the drift that was already found once.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(runnableHook, /^\s*npm test\s*$/m, "the hook must run the whole suite, not a subset");
  assert.match(pkg.scripts.test, /precheck/, "and npm test must still be the command that parses everything first");
  // `set -e`, or a failing check prints its complaint and the push proceeds anyway.
  assert.match(runnableHook, /^set -e$/m, "without set -e the hook reports failures and lets the push through");
});
