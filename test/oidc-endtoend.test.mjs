// The OIDC flow over REAL HTTP, against a real provider, with real redirects.
//
// docs/OIDC.md has said from the start that this is the one part never executed against anything: written to
// spec and unit-tested with an injected `fetch`, so the SHAPE of each request was verified and nothing about
// the flow was. I have repeated "never verified end to end" several times as though it were a fact about the
// world rather than about the tooling I had reached for. It is not: a provider is a few hundred lines, and the
// half of the protocol this app is responsible for can be exercised completely.
//
// WHAT THIS PROVES: the app fetches the discovery document and uses the endpoints it publishes; the redirect it
// builds carries PKCE and a state; the callback exchanges the code with the matching verifier over the wire; the
// userinfo response maps onto a person; and the three refusals — unknown subject, tampered state, replayed
// callback — hold against real requests rather than mocked ones.
//
// WHAT THIS DOES NOT PROVE, and the checklist in docs/OIDC.md still has to be run: that NextCloud's OIDC app
// behaves like this provider. A conforming implementation is not the same as the one you have. Its endpoint
// paths, its claim names, whether it returns `preferred_username` or `name`, whether it honours PKCE at all —
// all of that is a property of their server. This provider is written to the spec, which means it is a test of
// this app and not of theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT } from "../src/config.mjs";
import { migrate } from "../src/db.mjs";
import { writeSeasonSpanningToday } from "../tools/season-fixture.mjs";

const IDP_PORT = 8296;
const APP_PORT = 8297;
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const CLIENT_ID = "4water-flow";
const CLIENT_SECRET = "shhh-not-a-real-secret";

// A minimal OpenID Connect provider: discovery, authorize, token, userinfo. Enough of the spec to be honest,
// and it VERIFIES the parts the app is responsible for rather than rubber-stamping them — the code exchange
// checks the PKCE verifier against the challenge, the client secret, and that a code is used only once.
function startIdp({ subject = "nc-user-1", email = "vol@4water.org", name = "Volunteer One" } = {}) {
  const codes = new Map();          // code -> { challenge, used }
  const seen = { discovery: 0, authorize: 0, token: 0, userinfo: 0, lastTokenBody: null };

  const server = createServer((req, res) => {
    const url = new URL(req.url, IDP);
    const json = (obj, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === "/.well-known/openid-configuration") {
      seen.discovery++;
      // Endpoints under a subpath, deliberately not the /apps/oidc/* the app used to hardcode: if it ignored
      // discovery and guessed, nothing here would answer.
      return json({
        issuer: IDP,
        authorization_endpoint: `${IDP}/index.php/apps/oidc/authorize`,
        token_endpoint: `${IDP}/index.php/apps/oidc/token`,
        userinfo_endpoint: `${IDP}/index.php/apps/oidc/userinfo`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (url.pathname === "/index.php/apps/oidc/authorize") {
      seen.authorize++;
      seen.authorizeQuery = Object.fromEntries(url.searchParams);
      const code = randomBytes(12).toString("hex");
      codes.set(code, { challenge: url.searchParams.get("code_challenge"), used: false });
      // Straight back to the app, as a provider does once the user has consented.
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(303, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === "/index.php/apps/oidc/token") {
      seen.token++;
      let body = "";
      req.on("data", (d) => { body += d; });
      return req.on("end", () => {
        seen.lastTokenBody = body;
        const form = new URLSearchParams(body);
        if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
          return json({ error: "invalid_client" }, 401);
        }
        const entry = codes.get(form.get("code"));
        if (!entry) return json({ error: "invalid_grant" }, 400);
        if (entry.used) return json({ error: "invalid_grant", reason: "code reuse" }, 400);
        // The point of PKCE: the verifier must hash to the challenge sent at authorize time.
        const expect = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (expect !== entry.challenge) return json({ error: "invalid_grant", reason: "pkce mismatch" }, 400);
        entry.used = true;
        return json({ access_token: "at-" + randomBytes(8).toString("hex"), token_type: "Bearer", expires_in: 3600 });
      });
    }

    if (url.pathname === "/index.php/apps/oidc/userinfo") {
      seen.userinfo++;
      if (!String(req.headers.authorization ?? "").startsWith("Bearer at-")) return json({ error: "invalid_token" }, 401);
      return json({ sub: subject, name, email });
    }

    res.writeHead(404).end();
  });
  return { server, seen };
}

const listen = (server, port) => new Promise((r) => server.listen(port, "127.0.0.1", r));
const close = (server) => new Promise((r) => server.close(r));

function startApp(dir, extra = {}) {
  // A season containing today, in this test's own directory. It used to point at demo-pattern.json in the
  // repository root, which .gitignore excludes — so like the journey and first-run tests, this one could not
  // run on a fresh clone. See tools/season-fixture.mjs.
  const patternFile = path.join(dir, "pattern.json");
  writeSeasonSpanningToday(patternFile, { key: "oidc" });
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env,
           FOURWATER_DB: path.join(dir, "app.db"),
           FOURWATER_PATTERN: patternFile,
           FOURWATER_SECRET: "o".repeat(48),
           PORT: String(APP_PORT), HOST: "127.0.0.1",
           OIDC_ISSUER: IDP,
           OIDC_CLIENT_ID: CLIENT_ID,
           OIDC_CLIENT_SECRET: CLIENT_SECRET,
           OIDC_REDIRECT_URI: `${APP}/auth/callback`,
           // NOT production: over plain http a Secure cookie would never come back, and the session that
           // carries the state and the verifier lives in that cookie. The dev sign-in stays off either way —
           // FOURWATER_AUTH is unset, so this exercises OIDC as the only door.
           NODE_ENV: "development",
           ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, out: () => out };
}

const healthy = async (child) => {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) return false;
    try { if ((await fetch(`${APP}/healthz`)).ok) return true; } catch {}
  }
  return false;
};
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")])
  .filter(Boolean).map((c) => c.split(";")[0]).join("; ");

test("the whole OIDC flow works against a real provider over real HTTP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-oidc-"));
  const idp = startIdp();
  await listen(idp.server, IDP_PORT);

  // The roster is curated: OIDC never creates people. Pre-register the volunteer by email, which is the
  // documented path — their first sign-in adopts that record.
  {
    const db = new DatabaseSync(path.join(dir, "app.db"));
    migrate(db);
    db.prepare("INSERT INTO people (name, contact, auth_provider, auth_subject) VALUES ('Volunteer One','vol@4water.org','oidc',NULL)").run();
    db.close();
  }

  const app = startApp(dir);
  try {
    assert.ok(await healthy(app.child), `app never became healthy:\n${app.out()}`);

    // The sign-in page offers NextCloud, because all four settings are present.
    assert.match(await (await fetch(`${APP}/signin`)).text(), /NextCloud/);

    // 1. Start the flow. The app must have READ the discovery document and used the path it published.
    const begin = await fetch(`${APP}/auth/oidc`, { redirect: "manual" });
    assert.equal(begin.status, 303);
    const authorizeUrl = new URL(begin.headers.get("location"));
    const cookie = cookieOf(begin);
    assert.ok(cookie, "the state and verifier ride in the session cookie");

    assert.ok(idp.seen.discovery >= 1, "the app must fetch the discovery document");
    assert.equal(authorizeUrl.origin, IDP);
    assert.equal(authorizeUrl.pathname, "/index.php/apps/oidc/authorize",
      "the published path, not the /apps/oidc/* this used to hardcode");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorizeUrl.searchParams.get("code_challenge"), "PKCE challenge present");
    assert.ok(authorizeUrl.searchParams.get("state"), "state present");
    assert.equal(authorizeUrl.searchParams.get("client_id"), CLIENT_ID);
    assert.ok(!authorizeUrl.searchParams.get("code_challenge").includes(CLIENT_SECRET));

    // 2. The provider sends the user back with a code.
    const consent = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(consent.status, 303);
    const callbackUrl = new URL(consent.headers.get("location"));
    assert.equal(callbackUrl.origin, APP);
    assert.equal(callbackUrl.pathname, "/auth/callback");
    assert.ok(callbackUrl.searchParams.get("code"));

    // 3. The app exchanges it — over the wire, with the verifier the provider can check.
    const done = await fetch(callbackUrl, { headers: { cookie }, redirect: "manual" });
    assert.equal(done.status, 303, `callback failed. app output:\n${app.out()}`);
    assert.equal(done.headers.get("location"), "/", "a successful sign-in lands on the home screen");
    assert.equal(idp.seen.token, 1, "the token endpoint must have been called exactly once");
    assert.equal(idp.seen.userinfo, 1);
    assert.match(idp.seen.lastTokenBody, /grant_type=authorization_code/);
    assert.match(idp.seen.lastTokenBody, /code_verifier=/);

    // 4. And the session is real: a signed-in volunteer can reach their own screens.
    const session = cookieOf(done);
    const me = await fetch(`${APP}/me`, { headers: { cookie: session } });
    assert.equal(me.status, 200);
    assert.match(await me.text(), /Volunteer One/);

    // The pre-registered record was ADOPTED, not duplicated — the security property that stops anyone in the
    // NextCloud instance appearing on the roster.
    const db = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
    const rows = db.prepare("SELECT id, name, auth_subject FROM people").all();
    db.close();
    assert.equal(rows.length, 1, "OIDC must not create a second person");
    assert.equal(rows[0].auth_subject, "nc-user-1", "and must link the identity to the existing record");
  } finally {
    app.child.kill();
    await new Promise((r) => app.child.once("exit", r));
    await close(idp.server);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("an identity nobody put on the roster is refused, over real HTTP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-oidc-unknown-"));
  // A provider that authenticates somebody perfectly well — who is simply not a 4water volunteer.
  const idp = startIdp({ subject: "nc-stranger", email: "stranger@example.org", name: "A Stranger" });
  await listen(idp.server, IDP_PORT);
  { const db = new DatabaseSync(path.join(dir, "app.db")); migrate(db); db.close(); }

  const app = startApp(dir);
  try {
    assert.ok(await healthy(app.child), `app never became healthy:\n${app.out()}`);
    const begin = await fetch(`${APP}/auth/oidc`, { redirect: "manual" });
    const cookie = cookieOf(begin);
    const consent = await fetch(new URL(begin.headers.get("location")), { redirect: "manual" });
    const done = await fetch(new URL(consent.headers.get("location")), { headers: { cookie }, redirect: "manual" });

    // Authenticated by the provider, and still not let in. This is the deliberate property: anyone in 4water's
    // NextCloud could otherwise appear on the schedule.
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/signin?unknown=1");
    const db = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM people").get().n, 0, "no self-registration, at all");
    db.close();
  } finally {
    app.child.kill();
    await new Promise((r) => app.child.once("exit", r));
    await close(idp.server);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("a tampered state and a replayed code are both refused, over real HTTP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-oidc-attack-"));
  const idp = startIdp();
  await listen(idp.server, IDP_PORT);
  {
    const db = new DatabaseSync(path.join(dir, "app.db"));
    migrate(db);
    db.prepare("INSERT INTO people (name, contact, auth_provider, auth_subject) VALUES ('Volunteer One','vol@4water.org','oidc',NULL)").run();
    db.close();
  }

  const app = startApp(dir);
  try {
    assert.ok(await healthy(app.child), `app never became healthy:\n${app.out()}`);

    // --- a callback whose state does not match the session's ---
    const begin = await fetch(`${APP}/auth/oidc`, { redirect: "manual" });
    const cookie = cookieOf(begin);
    const consent = await fetch(new URL(begin.headers.get("location")), { redirect: "manual" });
    const good = new URL(consent.headers.get("location"));

    const tampered = new URL(good);
    tampered.searchParams.set("state", "x".repeat(good.searchParams.get("state").length));
    const rejected = await fetch(tampered, { headers: { cookie }, redirect: "manual" });
    assert.equal(rejected.status, 400, "a state that is not the one we issued is login-CSRF");
    assert.equal(idp.seen.token, 0, "and the code must never be exchanged");

    // --- no session cookie at all: nothing to compare the state against ---
    assert.equal((await fetch(good, { redirect: "manual" })).status, 400);
    assert.equal(idp.seen.token, 0);

    // --- the real one still works, then the same callback replayed does not ---
    const first = await fetch(good, { headers: { cookie }, redirect: "manual" });
    assert.equal(first.status, 303);
    assert.equal(first.headers.get("location"), "/");
    assert.equal(idp.seen.token, 1);

    // The state was consumed with the session, so a replay of the identical URL cannot sign in again. Whether it
    // is stopped by the state check or by the provider refusing to reuse the code, what must not happen is a
    // second successful session.
    const replay = await fetch(good, { headers: { cookie }, redirect: "manual" });
    assert.notEqual(replay.headers.get("location"), "/", `a replayed callback must not sign in again (${replay.status})`);
  } finally {
    app.child.kill();
    await new Promise((r) => app.child.once("exit", r));
    await close(idp.server);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
