// Per-test isolation. Lives in tools/ rather than test/ because Node's test runner treats every file under
// a test/ directory as a test file, and a helper with no tests in it just adds noise to the report.
//
// Why per-test and not per-file: the first version of the availability suite shared one database, and a
// test asserting "this request wrote nothing for person 0" failed because an EARLIER test had legitimately
// written rows for person 0. The assertion was measuring accumulated history, not the behaviour under test.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrate } from "../src/db.mjs";
import { loadPattern } from "../src/config.mjs";
import { seedSeason, seedStructure, seedPeople } from "../src/seed.mjs";
import { buildApp } from "../src/server.mjs";

export const TEST_ENV = { FOURWATER_SECRET: "s".repeat(48), FOURWATER_AUTH: "dev", NODE_ENV: "test" };

let worldCounter = 0;   // gives each world its own scratch config path without needing a clock or randomness

// Give every world the same shape: a seeded season plus named volunteers whose capabilities and
// availability the caller sets explicitly. Names are supplied here, never invented inside src/.
// Poll for a condition instead of sleeping a fixed amount. Needed because the board announces an open slot
// WITHOUT awaiting it — a slow webhook must not delay the volunteer's redirect — so the notification lands a
// few microtasks after the response.
export async function waitFor(fn, { timeoutMs = 2000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function makeWorld({ volunteers = 2, openSessions = true, roles = {}, today, notifier = null,
                                 capableOfEverything = false,
                                  patternFile = null, onPatternChange = null } = {}) {
  const pattern = loadPattern();
  const db = new DatabaseSync(":memory:");
  migrate(db);

  // `seedSeason` — the SAME entry point the real boot path uses — rather than seedStructure plus a separate
  // openEverySession. Those two halves are exactly what seedSeason was created to replace: its comment says the
  // fix for calling only the first "is not another reminder to call both: it is one function, so that calling half
  // of it is no longer expressible." The harness went on expressing it, which is how a helper diverges from
  // production in the one file whose divergence has already shipped two defects.
  //
  // Nothing changes for a passing test today — same file, same rows — and that is the point: the divergence was
  // latent. A step added to seedSeason later would reach production and miss every test built through here, which
  // is the same failure as the notifier the harness supplied and the boot path did not, only pointing the other
  // way.
  //
  // It also passes `pattern` through. The old call was `openEverySession(db, seasonId)` with no pattern, so it
  // re-read config/pattern.json from disk — the hazard seed.mjs's own header warns about, harmless only because
  // the harness happens to load the same file.
  const { seasonId } = openSessions
    ? seedSeason(db, pattern)
    // Structure WITHOUT slots is a legitimate world to want: it is the shape of the defect that shipped, and
    // test/firstrun.test.mjs and test/journey.test.mjs both need to be able to build it deliberately.
    : seedStructure(db, pattern);

  const people = seedPeople(db, seasonId, Array.from({ length: volunteers }, (_, i) => ({
    name: `Volunteer ${i + 1}`,
    contact: `v${i + 1}@example.org`,
    // One activity by default, which is what most tests want: it makes "not capable" reachable without setup.
    // `capableOfEverything` is for the tests whose SUBJECT is filling the plan — with one capability each, every
    // slot for every other activity is unfillable by construction, so "fill everything that can be filled" leaves
    // a proportion that depends on how many activities the shipped config happens to schedule. That coupling made
    // test/profile.test.mjs's gap-severity assertion sit one slot from its threshold, and correcting the weekly
    // rhythm to match the export's stated pattern tipped it. A fixture should not be sensitive to a department's
    // real timetable.
    can: capableOfEverything ? pattern.activities.map((a) => a.key) : [pattern.activities[0].key],
  })));

  // roles: { 0: ["planner"], 1: [] } — index into `people`.
  for (const [idx, names] of Object.entries(roles)) {
    for (const name of names) {
      const roleId = db.prepare("SELECT id FROM roles WHERE name = ?").get(name)?.id;
      if (roleId) db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(people[Number(idx)], roleId);
    }
  }

  // Default the clock to the day the season starts. The configured season is HISTORICAL (Q1Q2 2026), so a
  // real "today" makes every upcoming-slot list empty and every such test vacuously green.
  const clock = today ?? pattern.season.from;
  // `notifier` may be a factory, because a notifier needs the database this function is what creates. Without
  // that the caller has to rebuild the entire world by hand just to attach one.
  const wired = typeof notifier === "function" ? notifier(db) : notifier;
  let built;   // kept so tests can introspect the registered routes

  // Admin config edits write a FILE. Point them at a scratch copy per world, or a test run silently rewrites
  // the repository's own config/pattern.json.
  const scratch = patternFile ?? path.join(os.tmpdir(), `4water-pattern-${process.pid}-${++worldCounter}.json`);
  writeFileSync(scratch, JSON.stringify(pattern, null, 2) + "\n", "utf8");

  // Passed through so a test can watch config reloads the way the boot block does. The boot block builds the
  // nudge job's season getter over a mutable holder that this callback updates; without a way to exercise that,
  // the only test of it would be reading the code.
  built = buildApp({ db, pattern, env: TEST_ENV, notifier: wired, patternFile: scratch, onPatternChange,
                     today: () => clock });
  const server = built.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = makeClient(base);
  return {
    db, pattern, seasonId, people, base, server, today: clock, notifier: wired, patternFile: scratch,
    routes: () => built.routes(), ...client,
    close: () => {
      server.close();
      db.close();
      if (!patternFile) { try { rmSync(scratch); } catch {} }   // only clean up what we created
    },
  };
}

// Mark a person available on every session date, so a board actually has something on it.
export function makeAvailableEverywhere(db, personId, fromDate = "0000-00-00") {
  const set = db.prepare(`INSERT INTO availability_day (person_id, date, available) VALUES (?,?,1)
                          ON CONFLICT (person_id, date) DO UPDATE SET available = 1`);
  for (const { date } of db.prepare("SELECT DISTINCT date FROM sessions WHERE date >= ? ORDER BY date").all(fromDate)) {
    set.run(personId, date);
  }
}

// Count statement executions so an N+1 can be asserted against rather than eyeballed. Wraps prepare() and
// tallies every all/get/run on the returned statement.
export function countQueries(db) {
  const counter = { n: 0 };
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    return new Proxy(stmt, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v === "function" && ["all", "get", "run"].includes(prop)) {
          return (...args) => { counter.n++; return v.apply(target, args); };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  counter.restore = () => { db.prepare = realPrepare; };
  return counter;
}

function makeClient(base) {
  const get = (path, cookie) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const post = (path, cookie, body) =>
    fetch(`${base}${path}`, { method: "POST", headers: cookie ? { cookie } : {}, body, redirect: "manual" });

  const signIn = async (personId) => {
    const r = await fetch(`${base}/auth/dev`, { method: "POST", redirect: "manual", body: new URLSearchParams({ personId: String(personId) }) });
    if (r.status !== 303) throw new Error(`dev sign-in returned ${r.status}`);
    const set = r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie")];
    return set[0].split(";")[0];
  };

  // Fetch a page and pull its CSRF token, because every POST needs one and hardcoding a token in a test
  // would test nothing.
  const csrfFrom = async (path, cookie) => {
    const body = await (await get(path, cookie)).text();
    const token = body.match(/name="csrf" value="([^"]+)"/)?.[1];
    if (!token) throw new Error(`no CSRF token on ${path}`);
    return { token, body };
  };

  // Follow one redirect and return the destination's body — the flash message for an action lives on the
  // page you are sent to, not on a fresh fetch of the same path.
  const follow = async (res, cookie) => {
    const to = res.headers.get("location");
    if (!to) throw new Error(`expected a redirect, got ${res.status}`);
    return { to, body: await (await get(to, cookie)).text() };
  };

  return { get, post, signIn, csrfFrom, follow };
}

// Read the CSRF token straight out of the signed session cookie. Needed because a page with no forms has no
// CSRF field — an ineligible volunteer's board is legitimately empty — and a test that has to find a form
// first cannot exercise those cases. The payload is base64url JSON; no verification, this is a test reading
// its own cookie.
export function csrfFromCookie(cookie) {
  const value = decodeURIComponent(cookie.split("=").slice(1).join("="));
  const payload = JSON.parse(Buffer.from(value.slice(0, value.lastIndexOf(".")), "base64url").toString("utf8"));
  if (!payload.csrf) throw new Error("session cookie carried no csrf");
  return payload.csrf;
}

// Each slot renders three radios sharing one name (can / cannot / no answer), so a raw match list repeats
// every slot three times.
export const slotsIn = (html) =>
  [...new Set([...html.matchAll(/name="slot:(\d{4}-\d{2}-\d{2}):(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`))]
    .map((k) => { const [date, hour] = k.split(":"); return { date, hour, key: `slot:${date}:${hour}` }; });

// Hold the event loop open for the duration of a test, and the reason is specific rather than defensive.
//
// src/outbound.mjs UNREFS its timeout on purpose — "a pending timeout must never be the reason the process stays
// alive" — and that is right: in production a real fetch holds a SOCKET, which is ref'd, so the timeout still fires.
// It is only when a test injects a transport that opens nothing (`new Promise(() => {})`) that the unref'd timer is
// the sole pending work. Node 22.14's test runner then sees the loop resolve and cancels the test at ~2ms with
// "Promise resolution is still pending but the event loop has already resolved" — and every test after it in that
// file cascades. Node 24 holds the loop and passes, so the suite was green on the developer's machine and red on the
// version the Dockerfile pins, for its entire existence.
//
// Isolated in both directions on both runtimes: on 22.14 a ref'd timer beside a never-settling promise PASSES and
// the same thing unref'd is cancelled; on 24.18 all of it passes. So this is the harness holding one ref'd handle,
// not the product changing to suit a stub. Wrap only tests that inject a never-settling transport — using it
// everywhere would mask a genuinely hanging test, which is a thing a suite should still be able to catch.
export const withLoopAlive = (fn) => async (...args) => {
  const keep = setInterval(() => {}, 1000);
  try { return await fn(...args); } finally { clearInterval(keep); }
};
