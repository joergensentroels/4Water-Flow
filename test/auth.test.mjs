// Increment A: sessions, CSRF, the auth seam, and the guards that keep the dev provider out of production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db.mjs";
import { loadPattern } from "../src/config.mjs";
import { seedStructure, seedPeople } from "../src/seed.mjs";
import { sign, verify, parseCookies, cookieHeader, newCsrf, checkCsrf, sessionSecret, SESSION_MAX_AGE_S } from "../src/session.mjs";
import { assertDevAllowed, devSignIn, oidcConfig, beginOidc, checkState, completeOidc, linkIdentity,
         createInvite, redeemInvite, revokeInvite, rolesOf, requireRole } from "../src/auth.mjs";

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
test("OIDC is disabled until every setting is present", () => {
  assert.equal(oidcConfig({}).enabled, false);
  assert.equal(oidcConfig({ OIDC_ISSUER: "https://cloud.example.org", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b" }).enabled, false);
  const full = { OIDC_ISSUER: "https://cloud.example.org", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_REDIRECT_URI: "https://plan.example.org/auth/callback" };
  assert.equal(oidcConfig(full).enabled, true);
  assert.throws(() => beginOidc(oidcConfig({})), /not configured/);
});

test("the authorize URL carries PKCE S256 and a state", () => {
  const cfg = oidcConfig({ OIDC_ISSUER: "https://cloud.example.org/", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_REDIRECT_URI: "https://plan.example.org/auth/callback" });
  const { url, state, verifier } = beginOidc(cfg);
  const u = new URL(url);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), state);
  assert.ok(u.searchParams.get("code_challenge"));
  assert.notEqual(u.searchParams.get("code_challenge"), verifier, "the challenge must be a hash, not the verifier");
  assert.ok(!url.includes("//apps"), "trailing slash on the issuer must not double up");
});

test("state is compared safely and a mismatch fails", () => {
  assert.equal(checkState("abc", "abc"), true);
  assert.equal(checkState("abc", "abd"), false);
  assert.equal(checkState("abc", "ab"), false);
  assert.equal(checkState(undefined, "abc"), false);
});

test("the token exchange sends the verifier and requires a sub", async () => {
  const cfg = oidcConfig({ OIDC_ISSUER: "https://cloud.example.org", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_REDIRECT_URI: "https://plan.example.org/cb" });
  const calls = [];
  const fake = async (url, opts = {}) => {
    calls.push({ url, body: opts.body?.toString?.() });
    if (url.endsWith("/token")) return { ok: true, json: async () => ({ access_token: "AT" }) };
    return { ok: true, json: async () => ({ sub: "nc-42", name: "Volunteer 1", email: "v1@example.org" }) };
  };
  const id = await completeOidc(cfg, { code: "C", verifier: "V" }, fake);
  assert.equal(id.subject, "nc-42");
  assert.match(calls[0].body, /code_verifier=V/);
  assert.match(calls[0].body, /grant_type=authorization_code/);

  const noSub = async (url) => url.endsWith("/token")
    ? { ok: true, json: async () => ({ access_token: "AT" }) }
    : { ok: true, json: async () => ({ name: "nobody" }) };
  await assert.rejects(() => completeOidc(cfg, { code: "C", verifier: "V" }, noSub), /no sub/);

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
