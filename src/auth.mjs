// Identity. One seam, three providers, so that adding a fourth (or a second department's NextCloud) is a
// config change rather than a rewrite. `auth_provider` on `people` is a COLUMN, never a branch in app logic.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fetchBounded } from "./outbound.mjs";

export const PROVIDERS = ["dev", "oidc", "invite"];

// ---- the dev provider, built so it cannot ship ---------------------------------------------------------
// A local sign-in that skips OIDC is genuinely useful and genuinely dangerous. Two independent gates, both
// required, and it throws rather than degrading quietly: a safety posture that vanishes silently is the
// failure this project keeps designing out.
export function assertDevAllowed(env = process.env) {
  if (env.NODE_ENV === "production") throw new Error("the dev auth provider must never run with NODE_ENV=production");
  if (env.FOURWATER_AUTH !== "dev") throw new Error('the dev auth provider requires FOURWATER_AUTH=dev');
  return true;
}

export function devSignIn(db, personId, env = process.env) {
  assertDevAllowed(env);
  const p = db.prepare("SELECT id, name FROM people WHERE id = ?").get(Number(personId));
  if (!p) return null;
  return { personId: p.id, name: p.name, provider: "dev" };
}

// ---- OIDC against NextCloud ---------------------------------------------------------------------------
// Authorization code + PKCE. PKCE is not optional here: the code lands in a redirect URL, and without a
// verifier anything that can read that URL (browser history, a proxy log, an extension) can trade it.
// This comment used to read "this path CANNOT be exercised from the development machine — there is no NextCloud
// to talk to", and that sentence is why nobody tried for a long time. The absence of NextCloud does not prevent
// exercising THIS SIDE of the protocol: test/oidc-endtoend.test.mjs stands up a conforming provider and drives
// discovery, PKCE, the code exchange, userinfo and the three refusals over real HTTP.
//
// What is genuinely out of reach is NextCloud's own behaviour — its paths, its claim names, whether it honours
// PKCE. docs/OIDC.md carries the checklist for that, and it still has to be run.
export function oidcConfig(env = process.env) {
  const cfg = {
    issuer: env.OIDC_ISSUER || "",
    clientId: env.OIDC_CLIENT_ID || "",
    clientSecret: env.OIDC_CLIENT_SECRET || "",
    redirectUri: env.OIDC_REDIRECT_URI || "",
    scope: env.OIDC_SCOPE || "openid profile email",
  };
  cfg.enabled = Boolean(cfg.issuer && cfg.clientId && cfg.clientSecret && cfg.redirectUri);
  return cfg;
}

// ---- endpoint discovery -------------------------------------------------------------------------------
// The three endpoint paths used to be written out by hand as /apps/oidc/{authorize,token,userinfo}. That is
// NextCloud's current layout and nothing more: it is not part of any spec, it differs between OIDC apps, and
// it silently breaks if the admin mounts NextCloud under a subpath. OIDC publishes its endpoints, so ask.
//
// SECURITY: the token endpoint receives client_secret. A discovery document that named someone else's host
// would hand the secret to them, so every discovered endpoint must live on the SAME ORIGIN as the configured
// issuer. The issuer is operator-supplied config; the document is a network response, and the two are not
// equally trustworthy. https is required for the same reason, with localhost exempt so a developer can run a
// test IdP over http.
export const NEXTCLOUD_FALLBACK = { authorize: "/apps/oidc/authorize", token: "/apps/oidc/token", userinfo: "/apps/oidc/userinfo" };

const trimEnd = (s) => String(s).replace(/\/+$/, "");

export function validateEndpoint(issuer, url, what) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`discovery: ${what} is not a URL: ${url}`); }
  const iss = new URL(trimEnd(issuer));
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !localhost) throw new Error(`discovery: ${what} is not https: ${url}`);
  if (u.origin !== iss.origin) {
    throw new Error(`discovery: ${what} is on ${u.origin}, not the configured issuer ${iss.origin}`);
  }
  return u.toString();
}

// Cached per issuer, because this runs on every sign-in and a well-known document does not change per login.
// A short TTL rather than forever: rotating an IdP's endpoints should not need an app restart.
const discoveryCache = new Map();
export const DISCOVERY_TTL_MS = 10 * 60 * 1000;
export const clearDiscoveryCache = () => discoveryCache.clear();

// `timeoutMs` is injectable for the same reason `fetchImpl` is: a test that proves the timeout works must not
// take the production timeout to do it.
export async function discoverOidc(cfg, fetchImpl = fetch, { now = Date.now(), timeoutMs } = {}) {
  const key = trimEnd(cfg.issuer);
  const hit = discoveryCache.get(key);
  if (hit && hit.expires > now) return hit.value;

  const url = `${key}/.well-known/openid-configuration`;
  let value;
  try {
    // Bounded, because the fallback below is a `catch` and a hang is not a rejection. Against a NextCloud that
    // accepts the connection and goes quiet, this whole carefully-written degradation was unreachable — the
    // volunteer waited on undici's 300-second headers timeout instead, which is the case it exists for.
    const res = await fetchBounded(fetchImpl, url, { headers: { Accept: "application/json" } },
                                   { timeoutMs, label: "the identity provider" });
    if (!res.ok) throw new Error(`discovery: ${url} returned ${res.status}`);
    const doc = await res.json();
    // The spec requires issuer to match; a mismatch means we are reading someone else's metadata.
    if (doc.issuer && trimEnd(doc.issuer) !== key) {
      throw new Error(`discovery: document declares issuer ${doc.issuer}, expected ${key}`);
    }
    value = {
      authorize: validateEndpoint(key, doc.authorization_endpoint, "authorization_endpoint"),
      token: validateEndpoint(key, doc.token_endpoint, "token_endpoint"),
      userinfo: validateEndpoint(key, doc.userinfo_endpoint, "userinfo_endpoint"),
      source: "discovery",
    };
  } catch (e) {
    // Fall back to NextCloud's layout rather than locking every volunteer out over a missing well-known route
    // — but say so, loudly and on the status page, because a silent fallback is how a misconfiguration
    // survives for months. `source` is what /status reads.
    value = {
      authorize: key + NEXTCLOUD_FALLBACK.authorize,
      token: key + NEXTCLOUD_FALLBACK.token,
      userinfo: key + NEXTCLOUD_FALLBACK.userinfo,
      source: "fallback",
      error: e.message,
    };
    console.warn(`[oidc] ${e.message} — falling back to NextCloud's endpoint layout`);
  }
  discoveryCache.set(key, { value, expires: now + DISCOVERY_TTL_MS });
  return value;
}

export async function beginOidc(cfg, {
  state = randomBytes(16).toString("base64url"),
  verifier = randomBytes(32).toString("base64url"),
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  if (!cfg.enabled) throw Object.assign(new Error("OIDC is not configured"), { status: 503 });
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // Forwarded, not just defaulted. This is the volunteer clicking "Sign in with NextCloud", so it is the most
  // exposed of the three calls — and an option that only ONE of three call sites threads through is the shape
  // of every sibling defect in this project.
  const endpoints = await discoverOidc(cfg, fetchImpl, { timeoutMs });
  const u = new URL(endpoints.authorize);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return { url: u.toString(), state, verifier };
}

// `state` must match what we issued, compared in constant time and consumed once. A reusable state is a
// login-CSRF: an attacker replays their own callback to bind your browser to their account.
export function checkState(issued, returned) {
  if (typeof issued !== "string" || typeof returned !== "string" || issued.length !== returned.length) return false;
  return timingSafeEqual(Buffer.from(issued), Buffer.from(returned));
}

// The token exchange is injected so this is testable without a network. Production passes fetch.
export async function completeOidc(cfg, { code, verifier }, fetchImpl = fetch, { timeoutMs } = {}) {
  const endpoints = await discoverOidc(cfg, fetchImpl, { timeoutMs });
  // Both bounded. A volunteer is watching a redirect while these run, so an IdP that stops answering must
  // produce an error page they can act on rather than a spinner that lasts five minutes. The thrown message
  // names which endpoint went quiet, because "sign-in is broken" and "userinfo is slow" get fixed differently.
  const res = await fetchBounded(fetchImpl, endpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: verifier,
    }),
  }, { timeoutMs, label: "the token endpoint" });
  if (!res.ok) throw Object.assign(new Error(`token endpoint returned ${res.status}`), { status: 502 });
  const tok = await res.json();
  const info = await fetchBounded(fetchImpl, endpoints.userinfo, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  }, { timeoutMs, label: "the userinfo endpoint" });
  if (!info.ok) throw Object.assign(new Error(`userinfo returned ${info.status}`), { status: 502 });
  const claims = await info.json();
  if (!claims.sub) throw Object.assign(new Error("userinfo carried no sub"), { status: 502 });
  return {
    subject: String(claims.sub),
    name: String(claims.name || claims.preferred_username || ""),
    email: String(claims.email || ""),
    // TRI-STATE, and the third state is the point: true, false, and "the provider did not say". Collapsing
    // absent to true is what this function used to do by not reading the claim at all; collapsing it to false
    // would lock out every pre-registered volunteer on a provider that omits it, and no NextCloud has been
    // asked yet. linkIdentity decides what each state means. Some providers send the claim as the STRING
    // "true"/"false" rather than a boolean — a known quirk, and reading it wrong would fail open.
    emailVerified: typeof claims.email_verified === "boolean" ? claims.email_verified
      : claims.email_verified === "true" ? true
      : claims.email_verified === "false" ? false
      : undefined,
  };
}

// Map an external identity onto a person. Deliberately does NOT create people: a volunteer roster is
// curated, and self-registration from an SSO domain would let anyone in the NextCloud instance appear on
// the plan. Unknown subjects are told to ask for an invite.
//
// THE ADOPTION PATH IS THE SIBLING OF THAT REFUSAL, AND IT USED TO BE UNGUARDED. Refusing to create a person
// stops a stranger appearing as a new name. It does nothing about a stranger arriving as an EXISTING one: the
// second branch below matches on an email address that came from the provider's userinfo response, and if that
// address is something the user can type into their own profile, then anybody in the instance could claim any
// pre-registered record — with whatever roles it already carries. A planner or administrator added by an admin
// but not yet signed in is precisely the highest-value window, and the app would have handed the record over
// and called it a successful first sign-in.
//
// So the address has to be one the provider vouches for. `emailVerified` is tri-state and each state means
// something different:
//
//   false      — the provider explicitly says this address is unverified. Never adopt. A compliant provider
//                saying "no" cannot be talked round, and there is nothing to break by refusing.
//   undefined  — the provider did not send the claim. Adopt, because refusing here would lock out every
//                pre-registered volunteer on an instance that simply omits it, and nobody has yet asked
//                4water's NextCloud what it sends. But say so, because a trust assumption nobody is told about
//                is the same failure as the discovery fallback that used to be silent.
//   true       — vouched for. Adopt.
//
// Not branched on `provider`: "an unverified address must not adopt a record" is a property of the address, not
// of which identity system produced it, and this file's own rule is that auth_provider is a column and never a
// branch. The invite path never reaches here — it creates its own person, from an address an admin typed.
export function linkIdentity(db, provider, subject, { name, email, emailVerified } = {}) {
  const existing = db.prepare("SELECT id, name FROM people WHERE auth_provider = ? AND auth_subject = ?").get(provider, subject);
  if (existing) return { personId: existing.id, name: existing.name, provider };

  // Second chance: an admin pre-registered them by contact address but they have not signed in yet.
  if (email) {
    if (emailVerified === false) {
      // No address in the log line: this is an unauthenticated stranger's claim about somebody else's contact
      // details, and writing it down would put a volunteer's address in the journal on a failed sign-in.
      console.warn("[oidc] refusing to adopt a pre-registered volunteer: the provider marked the address unverified");
      return null;
    }
    const byEmail = db.prepare("SELECT id, name FROM people WHERE contact = ? AND auth_subject IS NULL").get(email);
    if (byEmail) {
      if (emailVerified === undefined) {
        console.warn("[oidc] adopting a pre-registered volunteer on an address the provider did not mark verified " +
                     "— see docs/OIDC.md §3. If the provider lets people set their own address without " +
                     "confirming it, anyone in the instance can claim a pre-registered record.");
      }
      db.prepare("UPDATE people SET auth_provider = ?, auth_subject = ? WHERE id = ?").run(provider, subject, byEmail.id);
      return { personId: byEmail.id, name: byEmail.name || name || "", provider };
    }
  }
  return null;
}

// ---- invitations: the fallback for volunteers with no NextCloud identity -------------------------------
const INVITE_TTL_DAYS = 14;

// Returns `{ token, id }`. The id is what the audit trail records, and the reason is not tidiness: the audit
// used to store `invited <address>` in its detail, and nothing in erasure reaches that column — so an erased
// person's email address stayed in the log forever, next to a `people` row that had been deleted and an
// `invitations` row whose address had been scrubbed to 'erased'. An id resolves to the invitation, which erasure
// DOES scrub, so the same row reads as "invited somebody" afterwards without any code having to remember to
// blank it. Every other audit detail already referred to people as `person:<id>` for this reason; this one was
// the exception, and it was the one carrying the most identifying value.
// `personId` names the person this invitation is FOR, and it is normally null — an admin inviting an address
// is inviting somebody not on the roster yet, and redemption creates them. It is set only by
// tools/bootstrap.mjs, which has already created the person it is inviting, and without it redemption made a
// SECOND row for the same human: see redeemInvite below for the measurement.
//
// Deliberately NOT inferred from the email. Matching an invitation to an existing person by address would mean
// a leaked link takes over that person's account and history, instead of producing a spurious empty one — a
// strictly worse failure, and the same shape as the linkIdentity concern about adopting on an unverified
// address. An explicit id set by the caller that created the person carries no such risk.
export function createInvite(db, { email, roleName = "volunteer", personId = null, now = new Date() }) {
  const token = randomBytes(24).toString("base64url");
  const roleId = db.prepare("SELECT id FROM roles WHERE name = ?").get(roleName)?.id ?? null;
  const { id } = db.prepare(`INSERT INTO invitations (email, token, role_id, created_at, person_id)
                             VALUES (?,?,?,?,?) RETURNING id`).get(email, hashToken(token), roleId, now.toISOString(), personId);
  // The raw token is returned ONCE and stored only as a hash — a stolen database must not yield working
  // invite links. Same reasoning as never storing a password.
  return { token, id };
}

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

// Whether a token could still be used, WITHOUT using it. Separated out because the invitation link arrives by
// email and a GET of it must change nothing: mail security gateways fetch links to scan them before the
// recipient ever sees them, and a GET that redeemed spent the invitation on that fetch. Redemption is a POST
// now, and this is what the GET asks so it can either offer the button or say no.
export function inviteStatus(db, token, { now = new Date() } = {}) {
  const row = db.prepare("SELECT * FROM invitations WHERE token = ?").get(hashToken(String(token || "")));
  if (!row) return { ok: false, reason: "unknown" };
  if (row.accepted_at) return { ok: false, reason: "already_used" };
  if ((now - Date.parse(row.created_at)) / 86400000 > INVITE_TTL_DAYS) return { ok: false, reason: "expired" };
  return { ok: true, row, email: row.email };
}

export function redeemInvite(db, token, { name, now = new Date() } = {}) {
  // The three refusals are shared with the GET rather than restated. Two copies of "is this token still good"
  // is how a page and the write behind it come to disagree about an expiry boundary.
  const checked = inviteStatus(db, token, { now });
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const row = checked.row;

  let personId;
  db.exec("BEGIN");
  try {
    // ADOPT the person the invitation already names, rather than always inserting.
    //
    // Measured 2026-08-23 by rehearsing the RUNBOOK's own first-run procedure against a production boot.
    // `tools/bootstrap.mjs` creates the first administrator AND an invite for the same address; this INSERT
    // then made a second row for the same human. The result was two active people on a one-person roster:
    // one named by their email address holding admin, and one holding admin+planner that nobody could ever
    // sign in to, because bootstrap leaves auth_subject NULL. Both counted as volunteers. The existing
    // idempotency test covers running bootstrap TWICE, not bootstrap-then-redeem, which is why it was green.
    //
    // Only an invitation carrying an explicit person_id adopts. An ordinary admin-created invite still has
    // person_id NULL and still creates a person, so nothing about the leaked-link risk changes — see
    // createInvite above for why matching on the email address instead would have been worse.
    if (row.person_id) {
      personId = Number(row.person_id);
      // Claim the credential slot if that person has none. bootstrap creates them as provider `oidc` with a
      // NULL subject so a later NextCloud sign-in can adopt them; until OIDC exists, that leaves them with no
      // way back in once this session expires — the invite they just used is spent. Binding the invite here
      // makes them a normal invite-provider person, keeping their id and history. An existing subject is left
      // alone: it is a working credential and this must not overwrite one.
      db.prepare(`UPDATE people SET auth_provider = 'invite', auth_subject = ?
                   WHERE id = ? AND auth_subject IS NULL`).run(`invite:${row.id}`, personId);
    } else {
      const r = db.prepare("INSERT INTO people (name, contact, auth_provider, auth_subject) VALUES (?,?,?,?)")
        .run(name || row.email, row.email, "invite", `invite:${row.id}`);
      personId = Number(r.lastInsertRowid);
    }
    if (row.role_id) db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(personId, row.role_id);
    // Marking accepted inside the same transaction is what makes it single-use under concurrency.
    const upd = db.prepare("UPDATE invitations SET accepted_at = ?, person_id = ? WHERE id = ? AND accepted_at IS NULL")
      .run(now.toISOString(), personId, row.id);
    if (upd.changes !== 1) throw new Error("invite was consumed concurrently");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return { ok: false, reason: "already_used" };
  }
  return { ok: true, personId, provider: "invite" };
}

export const revokeInvite = (db, id) =>
  db.prepare("UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL")
    .run(new Date(0).toISOString(), id).changes === 1;

// ---- roles --------------------------------------------------------------------------------------------
export const rolesOf = (db, personId) =>
  db.prepare("SELECT r.name FROM person_roles pr JOIN roles r ON r.id = pr.role_id WHERE pr.person_id = ?")
    .all(personId).map((r) => r.name);

// An administrator satisfies the planner role. Found by opening the app in a browser as an admin and hitting
// a 403 on the planning screen: the restriction protected nothing, because an admin can grant themselves the
// role in two clicks, and all it produced was a dead end for the person most likely to be filling a gap. In a
// forty-person volunteer organisation the admin usually IS a planner.
//
// It is NOT symmetric: a planner is not an administrator, so planners cannot invite people, edit the season or
// change roles. That direction is a real boundary and is tested.
const IMPLIES = { admin: ["planner"] };

export const hasRole = (db, personId, role) => {
  const held = rolesOf(db, personId);
  if (held.includes(role)) return true;
  return held.some((h) => (IMPLIES[h] ?? []).includes(role));
};

// 401 when nobody is signed in, 403 when someone is but lacks the role. Returning 404 to hide the route's
// existence would be security theatre here — the volunteer knows the planner screen exists — and it turns
// a permissions question into a "the link is broken" support message.
export function requireRole(db, session, role) {
  if (!session?.personId) return { ok: false, status: 401 };
  if (role && !hasRole(db, session.personId, role)) return { ok: false, status: 403 };
  return { ok: true, personId: session.personId };
}
