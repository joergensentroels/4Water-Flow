// Increment M's other half. Increment A's definition of done said "CSRF missing or wrong is rejected on
// EVERY POST", and I had tested several by hand — which is not the same claim. This walks the routes the app
// actually registers, so a POST added later cannot quietly arrive without the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";

// The one deliberate exception, named here so it is a decision rather than an oversight. /auth/dev runs
// BEFORE any session exists, so there is no token to carry; it is gated instead by assertDevAllowed(), which
// throws under NODE_ENV=production, and test/deploy.test.mjs proves it issues no session there.
const NO_SESSION_YET = new Set(["/auth/dev"]);

// Plausible values for path parameters, so a route with :id is actually exercised rather than 404ing before
// the CSRF check can run.
const fill = (pattern, w) => pattern.replace(/:(\w+)/g, () => "1");

test("every registered POST route refuses a missing and a wrong CSRF token", async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] } });
  try {
    const posts = w.routes().filter((r) => r.method === "POST");
    assert.ok(posts.length >= 12, `expected the app to register many POST routes, saw ${posts.length}`);

    const admin = await w.signIn(w.people[0]);   // an admin, so no route is refused merely for lack of a role
    const audited = [];
    for (const route of posts) {
      if (NO_SESSION_YET.has(route.pattern)) continue;
      const path = fill(route.pattern, w);

      for (const [label, body] of [
        ["missing", new URLSearchParams({})],
        ["empty", new URLSearchParams({ csrf: "" })],
        ["wrong", new URLSearchParams({ csrf: "definitely-not-the-token" })],
      ]) {
        const r = await w.post(path, admin, body);
        assert.equal(r.status, 403, `${route.pattern} accepted a ${label} CSRF token (status ${r.status})`);
      }

      // And prove the route is reachable WITH a good token, so the 403s above are the guard talking and not
      // simply a route that refuses everything.
      const ok = await w.post(path, admin, new URLSearchParams({ csrf: csrfFromCookie(admin) }));
      assert.notEqual(ok.status, 403, `${route.pattern} refuses even a valid token — the audit above proved nothing`);
      audited.push(route.pattern);
    }
    assert.ok(audited.length >= 12, `only audited ${audited.length} routes: ${audited.join(", ")}`);
  } finally { w.close(); }
});

// ---- the other audit: which routes are throttled ------------------------------------------------------
//
// `ratelimit.mjs` opened with "Throttling for the TWO endpoints anyone can reach without a session", and
// buildApp said the same. There are three. The calendar feed was added later, wired to the same limiter, and
// nobody updated either sentence — so the document describing a security control's scope understated it, and that
// is a large part of why the calendar path's throttle had no test until somebody went looking route by route.
//
// A count in prose is the problem. This enumerates instead, from the source, and requires the set to match: add a
// fourth unauthenticated endpoint without recording it here and this fails; take the throttle off one of these
// three and it fails too. Same shape as the CSRF exception list above and as PLANNER_WRITE_HONOURS — the decision
// has to be written down somewhere a test can read.
const THROTTLED = {
  "/auth/callback": "OIDC state comes back in a URL an attacker can supply; a wrong one is a failed sign-in.",
  "/invite/:token": "The invite token IS the credential, and the route is reachable by anyone with the link.",
  "/calendar/:token.ics": "The feed URL is the credential — a calendar client cannot present a cookie — and it " +
                          "is the one of the three that is polled repeatedly by real software.",
};

test("exactly the unauthenticated secret-in-the-URL routes are throttled, and each is written down", () => {
  const src = readFileSync(path.join(ROOT, "src", "server.mjs"), "utf8");

  // Split on route registrations and keep the ones whose body touches the limiter. Reading the source rather than
  // the route table because `blocked`/`fail` are calls inside a handler, which no introspection exposes.
  const found = new Set();
  const parts = src.split(/app\.(?:get|post)\("/);
  for (const part of parts.slice(1)) {
    const pattern = part.slice(0, part.indexOf('"'));
    // Up to the next registration, which is where this handler ends.
    if (/limiter\.(?:blocked|fail)\(/.test(part)) found.add(pattern);
  }
  assert.ok(parts.length > 20, "the route split found almost nothing — this check is not looking at anything");

  assert.deepEqual([...found].sort(), Object.keys(THROTTLED).sort(),
    "the set of throttled routes has changed. Either a new endpoint reachable without a session needs an entry " +
    "here, or one of these has lost its guard — and the second is the one that matters.");

  for (const [route, why] of Object.entries(THROTTLED)) {
    assert.ok(why.length >= 40, `${route}: record WHY it needs throttling, not just that it does`);
  }

  // And neither document may put a number on it again, since that is what went stale.
  for (const f of ["src/ratelimit.mjs", "src/server.mjs"]) {
    const text = readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/\b(two|three|2|3)\s+endpoints\b/i.test(text),
      `${f} counts the throttled endpoints in prose. Name them or say "the endpoints reachable without a ` +
      `session" — a count is what was wrong for an entire increment.`);
  }
});

test("the exception list is exactly one route, and it is the one that cannot have a token", async () => {
  const w = await makeWorld({});
  try {
    const patterns = w.routes().filter((r) => r.method === "POST").map((r) => r.pattern);
    for (const skipped of NO_SESSION_YET) {
      assert.ok(patterns.includes(skipped), `the exception list names ${skipped}, which is not a route any more`);
    }
    assert.equal(NO_SESSION_YET.size, 1, "a growing exception list is how a CSRF guard becomes optional");
  } finally { w.close(); }
});
