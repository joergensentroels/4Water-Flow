// The sibling of test/csrf-audit.test.mjs, and written for the same reason it gives: "I had tested several by
// hand — which is not the same claim." Role checks were in that position. Every route states its own rule, as
// the argument to gate()/postGate() inside its handler, and several of those rules had a test; none of them had
// a check that ALL of them do, so a route added later could arrive with no rule and nothing would notice.
//
// Nothing was wrong when this was written. The full matrix was measured first — 43 routes as anonymous, plain
// volunteer, planner and admin — and every one already behaved as its handler said it would. This exists to keep
// that true, and to turn the eight routes reachable without signing in from an accident of parsing into a list
// somebody decided.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, REQUIRED_ROLES } from "../src/config.mjs";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";

// Reachable without a session, each for a stated reason. A route parsed as ungated and absent from here fails:
// that is the point of the list — it cannot be extended by accident, only by a decision.
const PUBLIC = new Map([
  ["GET /healthz", "liveness for a container orchestrator, which has no session"],
  ["GET /privacy", "the privacy notice has to be readable before deciding to sign in"],
  ["GET /signin", "the sign-in page itself"],
  ["POST /auth/dev", "the dev sign-in, refused outright under NODE_ENV=production by assertDevAllowed"],
  ["GET /auth/oidc", "starts the redirect to the provider; there is no session yet by definition"],
  ["GET /auth/callback", "returns from the provider carrying the state and code, still with no session"],
  ["GET /invite/:token", "an invitation is how somebody who has no account gets one"],
  ["GET /calendar/:token.ics", "authenticated by an unguessable rotatable token instead of a session, because a "
    + "calendar client cannot sign in. NOT the same thing as ungated, and the only entry here that is a "
    + "different authentication mechanism rather than an absence of one"],
]);

// Each handler's rule is the second argument to its gate: a role name, nothing (any signed-in person), or no
// gate call at all (public). Read from the source rather than restated here, so the two cannot drift — a
// restated list is the shape of check this project has already found unable to notice its own gaps.
function declaredRules() {
  const src = readFileSync(path.join(ROOT, "src", "server.mjs"), "utf8");
  const rules = new Map();
  const parts = src.split(/\bapp\.(get|post)\(\s*"([^"]+)"/);
  for (let i = 1; i < parts.length; i += 3) {
    const body = parts[i + 2] ?? "";
    const m = /\b(postGate|gate)\(\s*\{[^}]*\}\s*(?:,\s*("([^"]*)"|null))?\s*\)/.exec(body);
    rules.set(`${parts[i].toUpperCase()} ${parts[i + 1]}`, !m ? "public" : m[3] ?? "signed-in");
  }
  return rules;
}

// Routes needing a role from OUTSIDE the two prefixes below. Everything else is settled by the path, which is
// the point: the expectation has to come from somewhere other than the handler, or the audit only proves the
// handler agrees with itself. Weakening `gate(x, "admin")` to `gate(x)` changes the declaration and the runtime
// together and every consistency check stays green — this is what notices.
const ROLE_BY_PATH = new Map([
  ["GET /outbox", "planner"],     // what the app has sent on volunteers' behalf; not a volunteer's business
  ["GET /status", "planner"],     // operational state, including the notification backlog
]);

// `/planner/season.csv` and the rest fall out of the prefix, so they are not listed and cannot be forgotten.
const expectedRule = (key) => {
  if (ROLE_BY_PATH.has(key)) return ROLE_BY_PATH.get(key);
  const p = key.split(" ")[1];
  if (p === "/admin" || p.startsWith("/admin/")) return "admin";
  if (p === "/planner" || p.startsWith("/planner/")) return "planner";
  return null;                    // no expectation from the path; the declaration stands on its own
};

const fill = (pattern) => pattern.replace(/:(\w+)/g, () => "1");

test("every registered route's access rule is one the source states, and the parse found all of them", () => {
  const rules = declaredRules();
  for (const rule of new Set(rules.values())) {
    assert.ok(rule === "public" || rule === "signed-in" || REQUIRED_ROLES.includes(rule),
      `a handler gates on "${rule}", which is not a role this app has — requireRole would refuse everyone`);
  }
  for (const [key, rule] of rules) {
    if (rule === "public") {
      assert.ok(PUBLIC.has(key), `${key} is reachable without signing in and is not in the list of routes meant to be`);
    } else {
      assert.ok(!PUBLIC.has(key), `${key} gates on "${rule}" but is listed as public — one of the two is stale`);
    }
    const want = expectedRule(key);
    if (want !== null) {
      assert.equal(rule, want, `${key} should gate on "${want}" — by its path, or by the named exception above — ` +
        `but its handler gates on "${rule}"`);
    }
  }
  for (const key of ROLE_BY_PATH.keys()) {
    assert.ok(rules.has(key), `${key} has a role stated for it here but is no longer a route — remove the entry`);
  }
});

test("the parse sees exactly the routes the app registers, in both directions", async () => {
  const w = await makeWorld({ volunteers: 1 });
  try {
    const rules = declaredRules();
    const registered = w.routes().map((r) => `${r.method} ${r.pattern}`);
    // Both directions: a route the parse missed is unaudited, and a rule with no route is a stale entry that
    // would otherwise sit here looking like coverage.
    const unparsed = registered.filter((k) => !rules.has(k));
    const unregistered = [...rules.keys()].filter((k) => !registered.includes(k));
    assert.deepEqual(unparsed, [], `registered but not found by the parse — these are unaudited: ${unparsed}`);
    assert.deepEqual(unregistered, [], `parsed but not registered — the parse is matching something else: ${unregistered}`);
    for (const key of PUBLIC.keys()) {
      assert.ok(registered.includes(key), `${key} is listed as public but no longer exists — remove it`);
    }
    assert.ok(registered.length >= 40, `expected the app to register many routes, saw ${registered.length}`);
  } finally { w.close(); }
});

test("the running server refuses everyone the declared rule excludes, and admits who it includes", async () => {
  const w = await makeWorld({ volunteers: 4, roles: { 0: ["admin"], 1: ["planner"] } });
  try {
    const who = { anon: null, volunteer: await w.signIn(w.people[2]),
                  planner: await w.signIn(w.people[1]), admin: await w.signIn(w.people[0]) };
    const hit = async (r, label) => {
      const cookie = who[label];
      const res = r.method === "GET" ? await w.get(fill(r.pattern), cookie)
        : await w.post(fill(r.pattern), cookie, new URLSearchParams(cookie ? { csrf: csrfFromCookie(cookie) } : {}));
      return { status: res.status, signin: res.headers.get("location") === "/signin" };
    };

    const rules = declaredRules();
    for (const r of w.routes()) {
      const key = `${r.method} ${r.pattern}`;
      const rule = rules.get(key);
      if (rule === "public") continue;   // covered by the two tests above; hitting these adds only rate-limiter noise

      const anon = await hit(r, "anon");
      assert.ok(anon.signin, `${key} gates on "${rule}" but an anonymous request got ${anon.status} instead of a bounce to /signin`);

      // Who must be refused, and — the control that makes the refusals mean something — who must not be. A route
      // that refuses everybody would satisfy every assertion above while being entirely broken.
      const excluded = rule === "admin" ? ["volunteer", "planner"] : rule === "planner" ? ["volunteer"] : [];
      for (const label of excluded) {
        const got = await hit(r, label);
        assert.equal(got.status, 403, `${key} gates on "${rule}" but a ${label} got ${got.status}`);
      }
      const allowed = rule === "signed-in" ? "volunteer" : rule;
      const ok = await hit(r, allowed);
      assert.notEqual(ok.status, 403, `${key} refuses a ${allowed}, which "${rule}" is supposed to admit — ` +
        `so the 403s above are the route refusing everyone, not the role check working`);
    }
  } finally { w.close(); }
});
