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
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
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
                                  patternFile = null, onPatternChange = null } = {}) {
  const pattern = loadPattern();
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const { seasonId } = seedStructure(db, pattern);

  const people = seedPeople(db, seasonId, Array.from({ length: volunteers }, (_, i) => ({
    name: `Volunteer ${i + 1}`,
    contact: `v${i + 1}@example.org`,
    can: [pattern.activities[0].key],
  })));
  if (openSessions) openEverySession(db, seasonId);

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
