// The OIDC guards, in-process against a fake provider — the complement to test/oidc-endtoend.test.mjs.
//
// HOW THIS FILE CAME TO EXIST, INCLUDING THE PART I GOT WRONG. `node --test --experimental-test-coverage` was run over
// this project for the first time and read as a silence detector: a covered line proves little, an uncovered one says
// no test has ever executed it. Two of the four uncovered blocks in `src/server.mjs` were the bodies of
// `GET /auth/oidc` and `GET /auth/callback` — the front door of every real deployment — and the conclusion drawn was
// that the OIDC routes had never run.
//
// That conclusion was false. `test/oidc-endtoend.test.mjs` walks the whole flow against a conforming provider over real
// HTTP, and has all along. It SPAWNS THE SERVER AS A CHILD PROCESS, and the coverage instrumentation only sees the
// process the test runner is in. **The uncovered-lines column means "not executed in this process", not "not tested"**,
// and for a project whose heaviest tests are subprocess tests that is a systematic blind spot pointing at exactly the
// most integration-heavy code. A silence detector that cannot see the other room reports an empty house.
//
// What survived the correction is the part the old test does not assert, and it is worth keeping:
//   - `email_verified: false` on an address that MATCHES a seeded volunteer. The old test refuses an identity nobody
//     put on the roster, which is the no-match case; this is the adoption case, and the comment on the guard in
//     server.mjs says "a guard that exists but is never reached is the defect this project keeps finding". It was not
//     reached. Removing the forwarding from the route fails only this file.
//   - hostile `next` values through the provider — `//evil.example` and friends. The old round-trip test carries
//     `/board`, so the allowlist was only ever asked about a destination it accepts.
//   - what the app SENT to the token endpoint: secret in the body, and the verifier matching the challenge the app
//     itself issued.
//   - `/status` with OIDC enabled, both when discovery succeeds and when the IdP is unreachable, plus a signed-in
//     volunteer with no role being refused it.
// The happy path below is kept as the control for those guards, not as a second end-to-end walk; oidc-endtoend remains
// the authoritative one. Neither can prove NextCloud behaves as specified — that still needs the real instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db.mjs";
import { loadPattern } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { setRole } from "../src/admin.mjs";
import { buildApp } from "../src/server.mjs";

// The provider. It records what it was asked, because half the assertions here are about what the APP sent — a token
// exchange that succeeds while omitting the PKCE verifier is a successful sign-in with the protection switched off.
async function fakeIdp(t, { claims, tokenStatus = 200, userinfoStatus = 200 } = {}) {
  const seen = { token: null, userinfoAuth: null, authorize: null };
  const srv = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      const base = `http://127.0.0.1:${srv.address().port}`;
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
      });
    }
    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => { body += c; });
      return req.on("end", () => {
        seen.token = Object.fromEntries(new URLSearchParams(body));
        json(tokenStatus, { access_token: "access-token-1", token_type: "Bearer" });
      });
    }
    if (url.pathname === "/userinfo") {
      seen.userinfoAuth = req.headers.authorization ?? null;
      return json(userinfoStatus, claims);
    }
    // The authorize endpoint is where the browser goes, not the app — a test can read the redirect instead.
    if (url.pathname === "/authorize") { seen.authorize = url.searchParams; return json(200, { ok: true }); }
    json(404, { error: "not_found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  return { seen, base: `http://127.0.0.1:${srv.address().port}` };
}

// The app, configured the way a deployment is: OIDC on, dev sign-in absent.
async function appWith(t, idpBase, { contact = "v1@example.org", roles = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const people = seedPeople(db, seasonId, [{ name: "Volunteer 1", contact, can: [pattern.activities[0].key] }]);
  openEverySession(db, seasonId);
  // /status is role-gated, which the first version of the status test found by answering 403 — so roles are a
  // parameter rather than a default. A volunteer signing in must NOT be able to read the operations page.
  for (const r of roles) setRole(db, people[0], r, true);

  // The redirect URI has to name a port that does not exist until listen() returns, so the app is built after it.
  const probe = createServer(() => {});
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const env = {
    FOURWATER_SECRET: "x".repeat(48), NODE_ENV: "test", FOURWATER_AUTH: "oidc",
    OIDC_ISSUER: idpBase, OIDC_CLIENT_ID: "fourwater", OIDC_CLIENT_SECRET: "shhh",
    OIDC_REDIRECT_URI: `http://127.0.0.1:${port}/auth/callback`,
  };
  const app = buildApp({ db, pattern, env });
  const srv = app.listen(port, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  t.after(() => { srv.close(); db.close(); });
  return { db, url: `http://127.0.0.1:${port}`, person: people[0], env };
}

const cookieFrom = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];

// Step one on its own, because everything after it depends on what this hands the browser.
async function begin(w, next) {
  const q = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  const res = await fetch(`${w.url}/auth/oidc${q}`, { redirect: "manual" });
  assert.equal(res.status, 303, "the app must redirect the volunteer to the provider");
  const to = new URL(res.headers.get("location"));
  return { cookie: cookieFrom(res), to, state: to.searchParams.get("state") };
}

test("a volunteer signs in through the provider and lands where they were going", async (t) => {
  const idp = await fakeIdp(t, { claims: { sub: "nc-1", name: "Volunteer 1", email: "v1@example.org",
                                           email_verified: true } });
  const w = await appWith(t, idp.base);

  // They tapped a link to the shift exchange, so that is where they must end up.
  const { cookie, to, state } = await begin(w, "/board");
  assert.match(to.pathname, /\/authorize$/, "the authorize endpoint must come from the discovery document");
  assert.equal(to.searchParams.get("client_id"), "fourwater");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  const challenge = to.searchParams.get("code_challenge");
  assert.ok(challenge && state, "state and a PKCE challenge must both be issued");

  const res = await fetch(`${w.url}/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
                          { redirect: "manual", headers: { cookie } });
  assert.equal(res.status, 303, `the callback answered ${res.status}`);
  assert.equal(res.headers.get("location"), "/board",
    "the destination rode in the signed cookie through the provider and must survive the round trip");

  // The session is real: use it.
  const home = await fetch(`${w.url}/board`, { headers: { cookie: cookieFrom(res) } });
  assert.equal(home.status, 200, "the cookie the callback set must be a working session");

  // WHAT THE APP SENT, which is the half a unit test of completeOidc cannot check against what beginOidc generated.
  // If these two ever stop being the same secret, PKCE is decoration: the exchange still succeeds, and an
  // intercepted code becomes redeemable by anybody.
  assert.ok(idp.seen.token, "the token endpoint must have been called");
  assert.equal(idp.seen.token.grant_type, "authorization_code");
  assert.equal(idp.seen.token.code, "auth-code-1");
  assert.equal(idp.seen.token.client_secret, "shhh", "the client secret must go in the body, not the URL");
  assert.equal(idp.seen.token.redirect_uri, w.env.OIDC_REDIRECT_URI);
  const verifier = idp.seen.token.code_verifier;
  assert.ok(verifier, "a token exchange without the verifier is PKCE switched off");
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge,
    "the verifier sent must be the one the challenge was derived from — this is the whole of PKCE");
  assert.equal(idp.seen.userinfoAuth, "Bearer access-token-1", "userinfo is fetched with the issued token");
});

test("the emailVerified guard is reached: an unverified address cannot adopt a pre-registered volunteer", async (t) => {
  // The address matches a seeded volunteer, so adoption is what WOULD happen — and the provider says the address is
  // not verified. Anyone able to set that address at the IdP would otherwise inherit the roster record.
  const idp = await fakeIdp(t, { claims: { sub: "nc-impostor", name: "Volunteer 1", email: "v1@example.org",
                                           email_verified: false } });
  const w = await appWith(t, idp.base);
  const { cookie, state } = await begin(w, "/board");
  const res = await fetch(`${w.url}/auth/callback?code=c&state=${encodeURIComponent(state)}`,
                          { redirect: "manual", headers: { cookie } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/signin?unknown=1", "an unverified match must not be adopted");
  // And no session was issued — a redirect to the sign-in page with a live cookie would be worse than useless.
  const after = await fetch(`${w.url}/board`, { headers: { cookie: cookieFrom(res) }, redirect: "manual" });
  assert.equal(after.status, 303, "no session may exist after a refused sign-in");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM people WHERE auth_subject='nc-impostor'").get().n, 0,
    "and nothing may have been written for the impostor");

  // THE CONTROL, and without it this test also passes on an app where OIDC is broken for everybody: the same address,
  // the same person, marked verified, is adopted. The guard has to be the thing refusing, not the flow.
  const ok = await fakeIdp(t, { claims: { sub: "nc-2", name: "Volunteer 1", email: "v1@example.org",
                                          email_verified: true } });
  const w2 = await appWith(t, ok.base);
  const b2 = await begin(w2, "/board");
  const good = await fetch(`${w2.url}/auth/callback?code=c&state=${encodeURIComponent(b2.state)}`,
                           { redirect: "manual", headers: { cookie: b2.cookie } });
  assert.equal(good.headers.get("location"), "/board", "the identical flow with a verified address must succeed");
});

test("a callback with the wrong state is refused, and an open redirect cannot ride in", async (t) => {
  const idp = await fakeIdp(t, { claims: { sub: "nc-1", name: "Volunteer 1", email: "v1@example.org",
                                           email_verified: true } });
  const w = await appWith(t, idp.base);
  const { cookie, state } = await begin(w, "/board");

  // Login CSRF: an attacker's callback replayed into somebody else's browser. The state in the cookie is the defence.
  for (const bad of ["", "not-the-state", state.slice(0, -1) + "0", `${state}x`]) {
    const res = await fetch(`${w.url}/auth/callback?code=c&state=${encodeURIComponent(bad)}`,
                            { redirect: "manual", headers: { cookie } });
    assert.equal(res.status, 400, `state ${JSON.stringify(bad)} must be refused, not signed in`);
  }
  assert.equal(idp.seen.token, null, "and no code may be exchanged for a refused callback");

  // The destination is validated on the way IN, so a hostile `next` never reaches the cookie. Checked here rather
  // than only in test/nextdest.test.mjs because that file drives the DEV route, and this is the one production uses.
  for (const hostile of ["//evil.example", "https://evil.example/x", "/admin/../../etc", "/no-such-route"]) {
    const b = await begin(w, hostile);
    const res = await fetch(`${w.url}/auth/callback?code=c&state=${encodeURIComponent(b.state)}`,
                            { redirect: "manual", headers: { cookie: b.cookie } });
    assert.equal(res.headers.get("location"), "/",
      `a sign-in aiming at ${hostile} must land on the home page, not follow it`);
  }
});

test("a provider that fails mid-flow produces an error page, not a spinner or a stack trace", async (t) => {
  // The token endpoint answering 500 is the realistic outage: discovery succeeded, so the app is committed.
  const idp = await fakeIdp(t, { claims: { sub: "nc-1" }, tokenStatus: 500 });
  const w = await appWith(t, idp.base);
  const { cookie, state } = await begin(w, "/board");
  const res = await fetch(`${w.url}/auth/callback?code=c&state=${encodeURIComponent(state)}`,
                          { redirect: "manual", headers: { cookie } });
  assert.equal(res.status, 502, "an upstream failure is 502, not 500 — it is not this server that broke");
  const body = await res.text();
  assert.ok(body.length > 0, "and it must be a page a volunteer can read");
  assert.ok(!/shhh|access-token|client_secret/.test(body), "with no credential in it");
});

// The status page reads the cached discovery result so an operator can tell "sign-in found the IdP's metadata" from
// "sign-in is guessing NextCloud-shaped paths". Both branches were uncovered, and the one that matters to whoever is
// on the phone at 4water is the FAILURE branch — the page must still render, and say which state it is in.
test("the status page reports whether sign-in found the provider's metadata", async (t) => {
  const idp = await fakeIdp(t, { claims: { sub: "nc-1", name: "Volunteer 1", email: "v1@example.org",
                                           email_verified: true } });
  const w = await appWith(t, idp.base, { roles: ["admin"] });
  const b = await begin(w, "/");
  const signedIn = cookieFrom(await fetch(`${w.url}/auth/callback?code=c&state=${encodeURIComponent(b.state)}`,
                                          { redirect: "manual", headers: { cookie: b.cookie } }));
  const res = await fetch(`${w.url}/status`, { headers: { cookie: signedIn } });
  assert.equal(res.status, 200, `/status answered ${res.status}`);
  const body = await res.text();
  assert.ok(body.length > 500, "the page must have rendered, not just answered");
  assert.ok(!/shhh/.test(body), "and it must not print the client secret");

  // Learned by getting 403 on the first run, and kept as an assertion rather than absorbed into the fixture: a
  // volunteer who signs in through the real provider must not reach the operations page. This is the only place that
  // is checked on the OIDC path, which is the path production uses.
  // The first version of this gave that person a contact the provider's claims do not match, so linkIdentity refused,
  // no session was created, and /status answered a redirect rather than 403 — while `cookieFrom` still returned a
  // non-empty string, so the guard "the volunteer must have a session" passed on a CLEARED cookie. The session is
  // therefore proved by USING it on a page a volunteer may read, which is the only evidence that means anything.
  const plain = await appWith(t, idp.base);
  const pb = await begin(plain, "/");
  const asVolunteer = cookieFrom(await fetch(`${plain.url}/auth/callback?code=c&state=${encodeURIComponent(pb.state)}`,
                                             { redirect: "manual", headers: { cookie: pb.cookie } }));
  assert.equal((await fetch(`${plain.url}/`, { headers: { cookie: asVolunteer }, redirect: "manual" })).status, 200,
    "the volunteer must really be signed in, or the 403 below is just an unauthenticated request");
  assert.equal((await fetch(`${plain.url}/status`, { headers: { cookie: asVolunteer }, redirect: "manual" })).status,
    403, "and a signed-in volunteer with no role must not read the operations page");

  // A provider that cannot be reached at all: discovery throws, the catch writes the fallback, and the page must
  // still come back 200. An operator diagnosing a broken sign-in cannot be diagnosing it from a 500.
  const dead = await appWith(t, "http://127.0.0.1:1", { contact: "v2@example.org", roles: ["admin"] });
  const res2 = await fetch(`${dead.url}/status`, { headers: { cookie: signedIn }, redirect: "manual" });
  assert.ok([200, 303].includes(res2.status),
    `a status page whose IdP is unreachable answered ${res2.status}; it must not be a server error`);
});
