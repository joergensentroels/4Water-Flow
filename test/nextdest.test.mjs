// Where you land after signing in — and why that is a security test as much as a usability one.
//
// Increment AI put a link in every notification. That created a journey nobody had ever walked: a volunteer taps
// "Open the shift exchange: https://…/board" in Mattermost, on a phone with no session. Measured end to end before
// this existed: 303 to /signin, sign in, 303 to `/`. **They tapped a link to the shift exchange and arrived at the
// home page.** Nothing on either screen remembered where they had been going, so the last step of "meets people
// where they already are" was: go and find it yourself.
//
// Every part worked. The link was correct, sign-in worked, the board worked. Class I — every statement true, the
// composition false — and only walking it finds it.
//
// Carrying a destination through sign-in is also the textbook open redirect, so the mechanism is an ALLOWLIST: a
// destination is acceptable only if the router would serve a GET for it. That is why the attack table below is not
// an attempt to enumerate every trick — `//evil`, `%2F%2Fevil`, `/board/../admin` and the ones nobody has thought
// of are all refused for the same reason, by not being routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db.mjs";
import { loadPattern } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { buildApp } from "../src/server.mjs";

const ENV = { FOURWATER_SECRET: "x".repeat(48), FOURWATER_AUTH: "dev", NODE_ENV: "test" };

// The context is taken so cleanup is REGISTERED, not called at the end of the happy path. The first version
// closed the server on the last line of each test — so the moment an assertion failed, a listening socket leaked
// and `node --test` never exited. Found by mutating the code this file guards: the suite did not go red, it hung,
// which is worse than a wrong answer because it looks like a broken machine rather than a broken test.
async function world(t) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const people = seedPeople(db, seasonId, [
    { name: "Volunteer 1", contact: "v1@example.org", can: [pattern.activities[0].key] },
  ]);
  openEverySession(db, seasonId);
  const app = buildApp({ db, pattern, env: ENV });
  const base = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${s.address().port}`, s }));
  });
  t.after(() => { base.s.close(); db.close(); });
  return { db, app, person: people[0], url: base.url };
}

// Sign in the dev way with an explicit destination, and report where the app sends you.
const signInWanting = async (w, next) => {
  const fields = new URLSearchParams({ personId: String(w.person) });
  if (next !== undefined) fields.set("next", next);
  const r = await fetch(`${w.url}/auth/dev`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fields.toString(),
  });
  return r.headers.get("location");
};

test("a signed-out request for a page carries that page through sign-in and back", async (t) => {
  const w = await world(t);

  // The hop the notification link produces.
  const first = await fetch(`${w.url}/board`, { redirect: "manual" });
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/signin?next=%2Fboard",
    "the 401 redirect must remember the page they were trying to reach");

  // The sign-in page must hand that destination to whichever provider they use.
  const page = await (await fetch(`${w.url}/signin?next=%2Fboard`)).text();
  assert.match(page, /<input type="hidden" name="next" value="\/board">/,
    "the dev form must carry it, or the POST cannot honour it");

  // And the round trip lands on the board, not the home page. Posted as a BROWSER posts — every hidden field the
  // page rendered, not just the one field this test is thinking about. The first version of this probe submitted
  // only personId, saw `/`, and would have reported the fix as broken.
  const fields = new URLSearchParams({ personId: String(w.person) });
  for (const m of page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.set(m[1], m[2]);
  const done = await fetch(`${w.url}/auth/dev`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: fields.toString(),
  });
  assert.equal(done.headers.get("location"), "/board",
    "a volunteer who tapped a link to the shift exchange must arrive at the shift exchange");
});

test("and an already-signed-in volunteer following the same link goes straight there", async (t) => {
  const w = await world(t);
  const signedIn = await fetch(`${w.url}/auth/dev`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ personId: String(w.person) }).toString(),
  });
  const cookie = (signedIn.headers.getSetCookie?.() ?? [signedIn.headers.get("set-cookie")])[0].split(";")[0];
  // A stale /signin?next=… link, tapped on a phone that already has a session. Sending them to the sign-in form
  // would be asking them to sign in again; sending them home would lose the destination twice over.
  const r = await fetch(`${w.url}/signin?next=%2Favailability`, { headers: { cookie }, redirect: "manual" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/availability");
});

// ---- the allowlist ---------------------------------------------------------------------------------------
//
// THE POSITIVE CONTROL COMES FIRST AND IS PART OF THE SAME TEST. "Every attempt landed on /" and "the mechanism
// does nothing at all" produce identical output, and a table of eighteen refusals is exactly the kind of evidence
// that reads as thorough while proving nothing. So this asserts a real destination IS honoured in the same breath.
test("no destination can be steered outside this app, and a real one still works", async (t) => {
  const w = await world(t);

  assert.equal(await signInWanting(w, "/board"), "/board",
    "the control: if this does not hold, every refusal below is vacuous");
  assert.equal(await signInWanting(w, "/availability"), "/availability", "and it is not special-cased to one path");

  const attempts = [
    "//evil.example",              // protocol-relative — the classic
    "https://evil.example",        // absolute
    "http://evil.example/x",
    "///evil.example",             // three slashes, which some parsers collapse
    "/\\evil.example",             // backslash, which some browsers normalise to /
    "\\\\evil.example",
    "%2F%2Fevil.example",          // percent-encoded authority
    "/board/../admin",             // traversal to a route they may not be allowed
    "/../etc/passwd",
    "/board%00",                   // NUL, in case something downstream truncates
    "/board ",                     // trailing space
    "javascript:alert(1)",         // scheme that is not a fetch at all
    "/no-such-route",              // a path this app does not serve
    "/signin",                     // a loop back into the form
    "/auth/oidc",                  // a loop that would start a second round trip on the first one's state
    "/signout",                    // signing them out at the end of signing in
    "",
  ];
  const leaked = [];
  for (const a of attempts) {
    const got = await signInWanting(w, a);
    if (got !== "/") leaked.push(`next=${JSON.stringify(a)} landed on ${got}`);
  }
  assert.deepEqual(leaked, [],
    "these destinations were honoured and should not have been. Anything that is not a GET route this app serves " +
    "must fall back to the home page:\n  " + leaked.join("\n  "));

  // A query string is dropped rather than the whole destination being refused — the path is the useful part and
  // carrying arbitrary query through a sign-in widens the surface for no benefit.
  assert.equal(await signInWanting(w, "/board?r=claimed"), "/board");
  // And a missing field is not an error, because most sign-ins have no destination at all.
  assert.equal(await signInWanting(w, undefined), "/");
});

test("the sign-in page never renders an off-site address, however it was asked to", async (t) => {
  const w = await world(t);
  for (const bad of ["//evil.example", "https://evil.example", "%2F%2Fevil.example"]) {
    const page = await (await fetch(`${w.url}/signin?next=${encodeURIComponent(bad)}`)).text();
    assert.ok(!page.includes("evil.example"), `${bad} reached the page: an attacker-supplied host on a sign-in form`);
    assert.ok(!/name="next"/.test(page), `${bad} was carried into the form as a destination`);
  }
  // The control again: a legitimate destination MUST reach the page, or the assertions above pass on a page that
  // never renders a destination at all.
  const good = await (await fetch(`${w.url}/signin?next=%2Fboard`)).text();
  assert.match(good, /name="next" value="\/board"/, "a valid destination must be rendered, or this test is blind");
});

// canServe is what makes the allowlist an allowlist. If it answered true for everything the refusals above would
// all still pass — they would just be passing because NEXT_LOOPS caught the two auth paths and nothing else was
// tried. So it gets its own assertions, in both directions.
test("the router will only vouch for routes it actually registered", async (t) => {
  const w = await world(t);
  assert.equal(w.app.canServe("GET", "/board"), true);
  assert.equal(w.app.canServe("GET", "/availability"), true);
  assert.equal(w.app.canServe("GET", "/no-such-route"), false);
  assert.equal(w.app.canServe("GET", "//evil.example"), false);
  // Method-aware: a POST-only path is not somewhere to send a browser after sign-in.
  assert.equal(w.app.canServe("GET", "/auth/dev"), false, "/auth/dev is a POST; a GET redirect to it would 405");
  assert.equal(w.app.canServe("POST", "/auth/dev"), true, "and the method check must not be vacuously false");
  // A parameterised route still matches, which is what lets /session/:id be a destination.
  assert.equal(w.app.canServe("GET", "/session/7"), true);
});
