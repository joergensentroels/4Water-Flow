// Increment M's other half. Increment A's definition of done said "CSRF missing or wrong is rejected on
// EVERY POST", and I had tested several by hand — which is not the same claim. This walks the routes the app
// actually registers, so a POST added later cannot quietly arrive without the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
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
