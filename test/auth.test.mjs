// Increment A: sessions, CSRF, the auth seam, and the guards that keep the dev provider out of production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { migrate } from "../src/db.mjs";
import { loadPattern, ROOT } from "../src/config.mjs";
import { seedStructure, seedPeople } from "../src/seed.mjs";
import { sign, verify, parseCookies, cookieHeader, newCsrf, checkCsrf, sessionSecret, SESSION_MAX_AGE_S } from "../src/session.mjs";
import { assertDevAllowed, devSignIn, oidcConfig, beginOidc, checkState, completeOidc, linkIdentity,
         createInvite, redeemInvite, revokeInvite, rolesOf, requireRole,
         discoverOidc, validateEndpoint, clearDiscoveryCache, NEXTCLOUD_FALLBACK, DISCOVERY_TTL_MS } from "../src/auth.mjs";
import { OUTBOUND_TIMEOUT_MS } from "../src/outbound.mjs";

const SECRET = "x".repeat(48);
const db0 = () => { const db = new DatabaseSync(":memory:"); migrate(db); return db; };

// ---- sessions -----------------------------------------------------------------------------------------
test("a signed session round-trips", () => {
  const t = sign({ personId: 7, csrf: "abc" }, SECRET);
  assert.equal(verify(t, SECRET).personId, 7);
});

test("a tampered session is rejected — payload, signature, and shape", () => {
  const t = sign({ personId: 7 }, SECRET);
  const [body, sig] = t.split(".");

  // Re-encode a different payload and keep the old signature.
  const forged = Buffer.from(JSON.stringify({ personId: 1, exp: 2 ** 40 })).toString("base64url");
  assert.equal(verify(`${forged}.${sig}`, SECRET), null, "payload swap must fail");
  assert.equal(verify(`${body}.${sig.slice(0, -2)}AA`, SECRET), null, "signature edit must fail");
  assert.equal(verify(t, "y".repeat(48)), null, "another secret must fail");
  assert.equal(verify("nodot", SECRET), null);
  assert.equal(verify(undefined, SECRET), null);
  assert.equal(verify("", SECRET), null);
});

test("an expired session is rejected", () => {
  const past = Date.now() - (SESSION_MAX_AGE_S + 60) * 1000;
  const t = sign({ personId: 7 }, SECRET, past);
  assert.equal(verify(t, SECRET), null);
  // Still valid a second before it lapses, so the boundary is not off by a whole window.
  assert.ok(verify(sign({ personId: 7 }, SECRET, Date.now() - 1000), SECRET));
});

test("the session secret is required, not defaulted", () => {
  assert.throws(() => sessionSecret({}), /FOURWATER_SECRET/);
  assert.throws(() => sessionSecret({ FOURWATER_SECRET: "tooshort" }), /32/);
  assert.equal(sessionSecret({ FOURWATER_SECRET: SECRET }), SECRET);
});

test("cookies parse, and the cookie is HttpOnly SameSite=Lax with Secure only when asked", () => {
  assert.deepEqual(parseCookies("a=1; 4w_session=abc%20def"), { a: "1", "4w_session": "abc def" });
  const prod = cookieHeader("tok", { secure: true });
  assert.match(prod, /HttpOnly/);
  assert.match(prod, /SameSite=Lax/);
  assert.match(prod, /; Secure/);
  assert.ok(!cookieHeader("tok", { secure: false }).includes("Secure"), "local http must work without Secure");
});

test("CSRF: a missing, wrong, or truncated token is rejected", () => {
  const session = { csrf: newCsrf() };
  assert.equal(checkCsrf(session, session.csrf), true);
  assert.equal(checkCsrf(session, undefined), false);
  assert.equal(checkCsrf(session, ""), false);
  assert.equal(checkCsrf(session, session.csrf.slice(0, -1)), false);
  assert.equal(checkCsrf(session, newCsrf()), false);
  assert.equal(checkCsrf({}, "anything"), false, "a session with no csrf must never validate");
});

// ---- the dev provider ---------------------------------------------------------------------------------
test("the dev provider refuses to run in production or without the explicit opt-in", () => {
  assert.throws(() => assertDevAllowed({ NODE_ENV: "production", FOURWATER_AUTH: "dev" }), /never run with NODE_ENV=production/);
  assert.throws(() => assertDevAllowed({}), /FOURWATER_AUTH=dev/);
  assert.throws(() => assertDevAllowed({ FOURWATER_AUTH: "oidc" }), /FOURWATER_AUTH=dev/);
  assert.equal(assertDevAllowed({ FOURWATER_AUTH: "dev" }), true);
});

test("dev sign-in returns a real person or null, never a fabricated one", () => {
  const db = db0();
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const [id] = seedPeople(db, seasonId, [{ name: "Volunteer 1" }]);
  const env = { FOURWATER_AUTH: "dev" };
  assert.equal(devSignIn(db, id, env).personId, id);
  assert.equal(devSignIn(db, 999999, env), null);
});

// ---- OIDC (no network) --------------------------------------------------------------------------------
test("OIDC is disabled until every setting is present", async () => {
  assert.equal(oidcConfig({}).enabled, false);
  assert.equal(oidcConfig({ OIDC_ISSUER: "https://cloud.example.org", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b" }).enabled, false);
  const full = { OIDC_ISSUER: "https://cloud.example.org", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_REDIRECT_URI: "https://plan.example.org/auth/callback" };
  assert.equal(oidcConfig(full).enabled, true);
  await assert.rejects(beginOidc(oidcConfig({})), /not configured/);
});

// ---- endpoint discovery (increment S) -------------------------------------------------------------------
// The three endpoint paths used to be hardcoded as NextCloud's /apps/oidc/*. That is one product's current
// layout, not a spec, and it breaks under a subpath install. These tests pin the discovery behaviour AND the
// refusals, because the token endpoint is handed client_secret and must never be taken on trust.
const ISSUER = "https://cloud.example.org";
const CFG = () => oidcConfig({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_REDIRECT_URI: "https://plan.example.org/auth/callback" });

// A discovery responder. `doc` is what the well-known route returns; everything else answers as the IdP.
function idp(doc, { wellKnownOk = true, onCall = () => {} } = {}) {
  return async (url, opts = {}) => {
    onCall({ url, body: opts.body?.toString?.() });
    if (url.includes("/.well-known/openid-configuration")) {
      return wellKnownOk ? { ok: true, json: async () => doc } : { ok: false, status: 404 };
    }
    if (url.includes("token")) return { ok: true, json: async () => ({ access_token: "AT" }) };
    return { ok: true, json: async () => ({ sub: "nc-42", name: "Volunteer 1", email: "v1@example.org" }) };
  };
}
const goodDoc = (issuer = ISSUER) => ({
  issuer,
  authorization_endpoint: `${issuer}/index.php/apps/oidc/authorize`,
  token_endpoint: `${issuer}/index.php/apps/oidc/token`,
  userinfo_endpoint: `${issuer}/index.php/apps/oidc/userinfo`,
});

test("the authorize URL carries PKCE S256 and a state, and comes from discovery", async () => {
  clearDiscoveryCache();
  const cfg = oidcConfig({ OIDC_ISSUER: `${ISSUER}/`, OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_REDIRECT_URI: "https://plan.example.org/auth/callback" });
  const { url, state, verifier } = await beginOidc(cfg, { fetchImpl: idp(goodDoc()) });
  const u = new URL(url);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), state);
  assert.ok(u.searchParams.get("code_challenge"));
  assert.notEqual(u.searchParams.get("code_challenge"), verifier, "the challenge must be a hash, not the verifier");
  assert.ok(!url.includes("//index.php"), "trailing slash on the issuer must not double up");
  assert.match(u.pathname, /^\/index\.php\/apps\/oidc\/authorize$/,
    "the path must be the one the IdP published, not one we guessed");
});

test("a discovered endpoint on another host is refused — that is where client_secret would go", () => {
  assert.throws(() => validateEndpoint(ISSUER, "https://evil.example.net/token", "token_endpoint"),
    /is on https:\/\/evil\.example\.net, not the configured issuer/);
  // Subdomains are a different origin too: cloud.example.org and cdn.cloud.example.org are not the same host.
  assert.throws(() => validateEndpoint(ISSUER, "https://cdn.cloud.example.org/token", "token_endpoint"), /not the configured issuer/);
  assert.throws(() => validateEndpoint(ISSUER, "http://cloud.example.org/token", "token_endpoint"), /is not https/);
  assert.throws(() => validateEndpoint(ISSUER, "not-a-url", "token_endpoint"), /is not a URL/);
  // Same origin is fine, whatever the path.
  assert.equal(validateEndpoint(ISSUER, `${ISSUER}/index.php/apps/oidc/token`, "token_endpoint"),
    `${ISSUER}/index.php/apps/oidc/token`);
  // A developer running a test IdP over plain http on localhost is allowed.
  assert.equal(validateEndpoint("http://localhost:9000", "http://localhost:9000/token", "token_endpoint"),
    "http://localhost:9000/token");
});

test("a discovery document that points elsewhere falls back rather than leaking the secret", async () => {
  clearDiscoveryCache();
  const hostile = { ...goodDoc(), token_endpoint: "https://evil.example.net/token" };
  const got = await discoverOidc(CFG(), idp(hostile));
  assert.equal(got.source, "fallback", "a rejected document must not be used");
  assert.equal(got.token, `${ISSUER}${NEXTCLOUD_FALLBACK.token}`);
  assert.match(got.error, /evil\.example\.net/);
  assert.ok(!got.token.includes("evil"), "the secret must never be posted to the host in the document");
});

test("a document declaring a different issuer is refused", async () => {
  clearDiscoveryCache();
  const got = await discoverOidc(CFG(), idp(goodDoc("https://other.example.org")));
  assert.equal(got.source, "fallback");
  assert.match(got.error, /declares issuer/);
});

test("no well-known route falls back to NextCloud's layout and says why", async () => {
  clearDiscoveryCache();
  const got = await discoverOidc(CFG(), idp(null, { wellKnownOk: false }));
  assert.equal(got.source, "fallback");
  assert.equal(got.authorize, `${ISSUER}/apps/oidc/authorize`);
  assert.match(got.error, /returned 404/);
});

test("discovery is cached, so it is not fetched on every sign-in", async () => {
  clearDiscoveryCache();
  const calls = [];
  const fetchImpl = idp(goodDoc(), { onCall: (c) => calls.push(c.url) });
  await discoverOidc(CFG(), fetchImpl);
  await discoverOidc(CFG(), fetchImpl);
  const wellKnown = calls.filter((u) => u.includes(".well-known"));
  assert.equal(wellKnown.length, 1, `fetched the document ${wellKnown.length} times`);

  // And the TTL is honoured, so rotating an IdP's endpoints does not need a restart.
  await discoverOidc(CFG(), fetchImpl, { now: Date.now() + DISCOVERY_TTL_MS + 1 });
  assert.equal(calls.filter((u) => u.includes(".well-known")).length, 2, "an expired entry must be refetched");
});

// The fallback above is a `catch`, and a hang is not a rejection. Against a NextCloud that accepts the
// connection and then goes quiet, this degradation — the whole point of which is not to lock every volunteer
// out — was unreachable: the volunteer waited on undici's 300-second headers timeout instead. The transport
// here IGNORES the abort signal on purpose, because a timeout that needs the transport's cooperation is one a
// future adapter can silently remove.
test("an identity provider that goes quiet falls back instead of hanging the sign-in", async () => {
  clearDiscoveryCache();
  let aborted = false;
  const silent = (url, opts) => {
    opts?.signal?.addEventListener?.("abort", () => { aborted = true; });
    return new Promise(() => {});
  };
  const warned = [];
  const realWarn = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    const started = process.hrtime.bigint();
    const got = await discoverOidc(CFG(), silent, { now: Date.now(), timeoutMs: 50 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(ms < 2000, `discovery must not hang the sign-in: took ${ms.toFixed(0)}ms`);
    assert.equal(got.source, "fallback", "and it must reach the fallback it was written for");
    assert.match(got.error, /did not answer within/, "with a reason /status can show");
    assert.ok(got.authorize.startsWith(ISSUER), "pointing at the issuer, not nowhere");
    assert.ok(warned.some((w) => /did not answer/.test(w)), "and say so in the log");
    assert.equal(aborted, true, "the socket must be released, not left waiting on a silent server");
  } finally {
    console.warn = realWarn;
  }
});

test("a token exchange against a silent provider fails with which endpoint went quiet", async () => {
  clearDiscoveryCache();
  // Discovery succeeds; the TOKEN endpoint is the one that stops answering. Naming it matters, because
  // "sign-in is broken" and "the token endpoint is slow" get fixed differently.
  const half = (url, opts) => {
    if (url.includes(".well-known")) return Promise.resolve({ ok: true, json: async () => goodDoc() });
    return new Promise(() => {});
  };
  await assert.rejects(
    () => completeOidc(CFG(), { code: "c", verifier: "v" }, half, { timeoutMs: 50 }),
    (e) => /token endpoint did not answer/.test(e.message),
    "the error must name the endpoint that went quiet");
});

// The reason to write this rather than trust the three tests above: every recurring defect in this project has
// been care applied to one path and not its sibling. Four outbound calls existed and I found the hang in one of
// them; the other three were the same bug waiting. So assert the ENUMERATION, not the instances — a fifth
// outbound call added later must go through the bound or fail here.
//
// A grep, deliberately, rather than a runtime check: there is no seam every outbound request passes through at
// runtime, and inventing one to make this testable would be a worse design than reading the source.
test("every outbound request in the app goes through the bounded helper", () => {
  const files = ["src/auth.mjs", "src/notify.mjs", "tools/backup.mjs", "src/outbound.mjs"];
  const offenders = [];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    text.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment is allowed to say the word
      // `fetchImpl = fetch` is the default-parameter seam, not a call. `fetchImpl(` inside outbound.mjs IS the
      // one place the raw call belongs.
      if (/\bfetchImpl\s*=\s*fetch\b/.test(line)) return;
      if (rel === "src/outbound.mjs") return;
      if (/\b(await\s+)?fetchImpl\s*\(|\bawait\s+fetch\s*\(/.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `these call a transport directly instead of fetchBounded, so they cannot time out:\n${offenders.join("\n")}`);

  // And the helper is actually reached from each of them, rather than merely imported.
  for (const rel of ["src/auth.mjs", "src/notify.mjs", "tools/backup.mjs"]) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(text, /fetchBounded\(/, `${rel} imports the bound but never calls it`);
  }
});

// Written because it caught me twenty minutes after I wrote the doc. RUNBOOK quotes the error message an
// operator will grep for; I then moved the bound from notify.mjs's own 10s to the shared 8s and the quoted
// string was silently wrong. Prose fails exactly like code and never gets re-executed — same shape as the
// three UI strings that asserted false causes, and the reason the Node floor has a test of its own.
test("the timeout the RUNBOOK quotes is the timeout the code applies", () => {
  const runbook = readFileSync(path.join(ROOT, "RUNBOOK.md"), "utf8");
  const quoted = runbook.match(/did not answer within (\d+)s/);
  assert.ok(quoted, "RUNBOOK should show the message an operator will see in notifications.error");
  assert.equal(Number(quoted[1]), OUTBOUND_TIMEOUT_MS / 1000,
    `RUNBOOK says ${quoted[1]}s, the code says ${OUTBOUND_TIMEOUT_MS / 1000}s`);
});

test("state is compared safely and a mismatch fails", () => {
  assert.equal(checkState("abc", "abc"), true);
  assert.equal(checkState("abc", "abd"), false);
  assert.equal(checkState("abc", "ab"), false);
  assert.equal(checkState(undefined, "abc"), false);
});

test("the token exchange sends the verifier, to the discovered endpoint, and requires a sub", async () => {
  clearDiscoveryCache();
  const cfg = CFG();
  const calls = [];
  const id = await completeOidc(cfg, { code: "C", verifier: "V" }, idp(goodDoc(), { onCall: (c) => calls.push(c) }));
  assert.equal(id.subject, "nc-42");

  const token = calls.find((c) => c.url.includes("/token"));
  assert.equal(token.url, `${ISSUER}/index.php/apps/oidc/token`, "the published endpoint, not a guessed path");
  assert.match(token.body, /code_verifier=V/);
  assert.match(token.body, /grant_type=authorization_code/);
  assert.ok(calls.some((c) => c.url.includes("/index.php/apps/oidc/userinfo")), "userinfo must also come from the document");

  clearDiscoveryCache();
  const noSub = async (url) => {
    if (url.includes(".well-known")) return { ok: true, json: async () => goodDoc() };
    if (url.includes("/token")) return { ok: true, json: async () => ({ access_token: "AT" }) };
    return { ok: true, json: async () => ({ name: "nobody" }) };
  };
  await assert.rejects(() => completeOidc(cfg, { code: "C", verifier: "V" }, noSub), /no sub/);

  clearDiscoveryCache();
  const dead = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => completeOidc(cfg, { code: "C", verifier: "V" }, dead), /token endpoint returned 500/);
});

test("an unknown SSO identity is NOT auto-registered, but a pre-registered contact is adopted", () => {
  const db = db0();
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  seedPeople(db, seasonId, [{ name: "Volunteer 1", contact: "v1@example.org" }]);
  // People seeded with auth_provider 'oidc' but no subject are "pre-registered".
  db.prepare("UPDATE people SET auth_subject = NULL WHERE contact = ?").run("v1@example.org");

  assert.equal(linkIdentity(db, "oidc", "stranger", { email: "nobody@example.org" }), null,
    "anyone in the NextCloud instance must not be able to appear on the plan");

  const linked = linkIdentity(db, "oidc", "nc-1", { name: "Volunteer 1", email: "v1@example.org" });
  assert.ok(linked, "a pre-registered contact should be adopted on first sign-in");
  // And the link is now permanent, so a second sign-in takes the fast path.
  assert.equal(linkIdentity(db, "oidc", "nc-1", {}).personId, linked.personId);
});

// ---- invitations --------------------------------------------------------------------------------------
test("an invite is single-use, expiring, and stored only as a hash", () => {
  const db = db0();
  seedStructure(db, loadPattern());
  const token = createInvite(db, { email: "new@example.org" });

  const stored = db.prepare("SELECT token FROM invitations").get().token;
  assert.notEqual(stored, token, "the raw token must not be stored");
  assert.match(stored, /^[0-9a-f]{64}$/);

  const first = redeemInvite(db, token, { name: "Newcomer" });
  assert.equal(first.ok, true);
  assert.equal(rolesOf(db, first.personId).includes("volunteer"), true, "the invited role should be granted");

  assert.deepEqual(redeemInvite(db, token, {}), { ok: false, reason: "already_used" });
  assert.deepEqual(redeemInvite(db, "garbage", {}), { ok: false, reason: "unknown" });
});

test("an expired invite is refused", () => {
  const db = db0();
  seedStructure(db, loadPattern());
  const long_ago = new Date(Date.now() - 60 * 86400000);
  const token = createInvite(db, { email: "stale@example.org", now: long_ago });
  assert.deepEqual(redeemInvite(db, token, {}), { ok: false, reason: "expired" });
});

test("a revoked invite cannot be redeemed", () => {
  const db = db0();
  seedStructure(db, loadPattern());
  const token = createInvite(db, { email: "revoked@example.org" });
  assert.equal(revokeInvite(db, db.prepare("SELECT id FROM invitations").get().id), true);
  assert.deepEqual(redeemInvite(db, token, {}), { ok: false, reason: "already_used" });
});

// ---- roles --------------------------------------------------------------------------------------------
test("requireRole: 401 when signed out, 403 when signed in without the role", () => {
  const db = db0();
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const [vol] = seedPeople(db, seasonId, [{ name: "Volunteer 1" }]);
  const volunteerRole = db.prepare("SELECT id FROM roles WHERE name='volunteer'").get().id;
  db.prepare("INSERT INTO person_roles (person_id, role_id) VALUES (?,?)").run(vol, volunteerRole);

  assert.deepEqual(requireRole(db, null, "planner"), { ok: false, status: 401 });
  assert.deepEqual(requireRole(db, { personId: vol }, "planner"), { ok: false, status: 403 });
  assert.deepEqual(requireRole(db, { personId: vol }, "volunteer"), { ok: true, personId: vol });
  assert.deepEqual(requireRole(db, { personId: vol }, null), { ok: true, personId: vol });
});
