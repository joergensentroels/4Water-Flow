// Increment M's other half. Increment A's definition of done said "CSRF missing or wrong is rejected on
// EVERY POST", and I had tested several by hand — which is not the same claim. This walks the routes the app
// actually registers, so a POST added later cannot quietly arrive without the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";

// The deliberate exceptions, named here so each is a decision rather than an oversight. Both run BEFORE any
// session exists, so there is no token to carry, and both are authorized by something else instead.
//
//   /auth/dev             gated by assertDevAllowed(), which throws under NODE_ENV=production; test/deploy.test.mjs
//                         proves it issues no session there.
//   /invite/:token/accept possession of the invitation token IS the authorization — anyone who could forge this
//                         POST could just follow the link. It is a POST precisely so that a link scanner or
//                         prefetcher, which only issues GETs, cannot spend somebody's invitation for them.
const NO_SESSION_YET = new Set(["/auth/dev", "/invite/:token/accept"]);

// Plausible values for path parameters, so a route with :id is actually exercised rather than 404ing before
// the CSRF check can run.
const fill = (pattern, w) => pattern.replace(/:(\w+)/g, () => "1");

test("every registered POST route refuses a missing and a wrong CSRF token", async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] } });
  try {
    const posts = w.routes().filter((r) => r.method === "POST");
    assert.ok(posts.length >= 12, `expected the app to register many POST routes, saw ${posts.length}`);

    const admin = await w.signIn(w.people[0]);   // an admin, so no route is refused merely for lack of a role

    // A VALID TOKEN FROM ANOTHER SESSION, which is the only one of the four cases below that reaches the comparison.
    //
    // `checkCsrf` returns false on a length mismatch before comparing anything, and a real token is 22 characters
    // (16 random bytes, base64url). "definitely-not-the-token" is 24, "" is 0, and missing is not a string — so the
    // three original cases are all answered by the length guard alone. Measured, not reasoned: replacing the
    // comparison with `return true` fails exactly one test in the whole suite, the unit test in auth.test.mjs, and
    // nothing in this file. This audit was green against an implementation that accepted any 22-character token.
    //
    // That unit test proves the PRIMITIVE compares two tokens. It says nothing about whether a ROUTE hands that
    // primitive the session belonging to this request — and a browser CSRF is precisely the attacker supplying the
    // form, and therefore the token, while the browser supplies the victim's cookie. So the case that matters is
    // one session's cookie with another session's token: same length, correctly formed, genuinely issued, wrong
    // session. Nothing submitted that before.
    const otherToken = csrfFromCookie(await w.signIn(w.people[1]));
    const adminToken = csrfFromCookie(admin);
    assert.equal(otherToken.length, adminToken.length,
      "the two tokens differ in length, so the length guard would answer this case and it would prove nothing");
    assert.notEqual(otherToken, adminToken, "both sessions minted the same token — not a real pair");

    const audited = [];
    for (const route of posts) {
      if (NO_SESSION_YET.has(route.pattern)) continue;
      const path = fill(route.pattern, w);

      for (const [label, body] of [
        ["missing", new URLSearchParams({})],
        ["empty", new URLSearchParams({ csrf: "" })],
        ["wrong", new URLSearchParams({ csrf: "definitely-not-the-token" })],
        ["valid but from another session", new URLSearchParams({ csrf: otherToken })],
      ]) {
        const r = await w.post(path, admin, body);
        assert.equal(r.status, 403, `${route.pattern} accepted a ${label} CSRF token (status ${r.status})`);
      }

      // And prove the route is reachable WITH a good token, so the 403s above are the guard talking and not
      // simply a route that refuses everything.
      const ok = await w.post(path, admin, new URLSearchParams({ csrf: adminToken }));
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
  "/invite/:token/accept": "Same credential as the page above, and this is the half that writes — so a caller " +
                           "guessing tokens must be slowed down here even more than on the page that only looks.",
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

// This used to assert the list held exactly one route, so that "a growing exception list is how a CSRF guard
// becomes optional". A second route genuinely needed to be here — invitation acceptance, which has no session and
// therefore no token — and bumping a 1 to a 2 would have retired the guard rather than satisfied it.
//
// So the count is derived instead. The exception is allowed for exactly one reason, "there is no session yet", and
// the source already says which routes those are: the ones whose handler calls no gate. Both directions, so the
// list can neither grow past that reason nor keep an entry that has since acquired a gate.
test("the CSRF exception list is exactly the POSTs that have no session to carry a token", async () => {
  const w = await makeWorld({});
  try {
    const src = readFileSync(path.join(ROOT, "src", "server.mjs"), "utf8");
    const ungated = new Set();
    const parts = src.split(/\bapp\.(get|post)\(\s*"([^"]+)"/);
    for (let i = 1; i < parts.length; i += 3) {
      if (parts[i] !== "post") continue;
      if (!/\b(postGate|gate)\(\s*\{/.test(parts[i + 2] ?? "")) ungated.add(parts[i + 1]);
    }
    assert.ok(parts.length > 20, "the route split found almost nothing — this check is not looking at anything");

    const patterns = w.routes().filter((r) => r.method === "POST").map((r) => r.pattern);
    for (const skipped of NO_SESSION_YET) {
      assert.ok(patterns.includes(skipped), `the exception list names ${skipped}, which is not a route any more`);
    }
    assert.deepEqual([...NO_SESSION_YET].sort(), [...ungated].sort(),
      "every POST reachable without a session must be named here — and nothing else may be. An entry that has " +
      "since gained a gate is a CSRF check being skipped for no reason.");
  } finally { w.close(); }
});
