// Identity. One seam, three providers, so that adding a fourth (or a second department's NextCloud) is a
// config change rather than a rewrite. `auth_provider` on `people` is a COLUMN, never a branch in app logic.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
// NOTE: this path CANNOT be exercised from the development machine — there is no NextCloud to talk to.
// docs/OIDC.md carries the checklist to run against the real server before trusting it.
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

export function beginOidc(cfg, { state = randomBytes(16).toString("base64url"), verifier = randomBytes(32).toString("base64url") } = {}) {
  if (!cfg.enabled) throw Object.assign(new Error("OIDC is not configured"), { status: 503 });
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const u = new URL(`${cfg.issuer.replace(/\/+$/, "")}/apps/oidc/authorize`);
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
export async function completeOidc(cfg, { code, verifier }, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.issuer.replace(/\/+$/, "")}/apps/oidc/token`, {
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
  });
  if (!res.ok) throw Object.assign(new Error(`token endpoint returned ${res.status}`), { status: 502 });
  const tok = await res.json();
  const info = await fetchImpl(`${cfg.issuer.replace(/\/+$/, "")}/apps/oidc/userinfo`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!info.ok) throw Object.assign(new Error(`userinfo returned ${info.status}`), { status: 502 });
  const claims = await info.json();
  if (!claims.sub) throw Object.assign(new Error("userinfo carried no sub"), { status: 502 });
  return { subject: String(claims.sub), name: String(claims.name || claims.preferred_username || ""), email: String(claims.email || "") };
}

// Map an external identity onto a person. Deliberately does NOT create people: a volunteer roster is
// curated, and self-registration from an SSO domain would let anyone in the NextCloud instance appear on
// the plan. Unknown subjects are told to ask for an invite.
export function linkIdentity(db, provider, subject, { name, email } = {}) {
  const existing = db.prepare("SELECT id, name FROM people WHERE auth_provider = ? AND auth_subject = ?").get(provider, subject);
  if (existing) return { personId: existing.id, name: existing.name, provider };

  // Second chance: an admin pre-registered them by contact address but they have not signed in yet.
  if (email) {
    const byEmail = db.prepare("SELECT id, name FROM people WHERE contact = ? AND auth_subject IS NULL").get(email);
    if (byEmail) {
      db.prepare("UPDATE people SET auth_provider = ?, auth_subject = ? WHERE id = ?").run(provider, subject, byEmail.id);
      return { personId: byEmail.id, name: byEmail.name || name || "", provider };
    }
  }
  return null;
}

// ---- invitations: the fallback for volunteers with no NextCloud identity -------------------------------
const INVITE_TTL_DAYS = 14;

export function createInvite(db, { email, roleName = "volunteer", now = new Date() }) {
  const token = randomBytes(24).toString("base64url");
  const roleId = db.prepare("SELECT id FROM roles WHERE name = ?").get(roleName)?.id ?? null;
  db.prepare("INSERT INTO invitations (email, token, role_id, created_at) VALUES (?,?,?,?)")
    .run(email, hashToken(token), roleId, now.toISOString());
  // The raw token is returned ONCE and stored only as a hash — a stolen database must not yield working
  // invite links. Same reasoning as never storing a password.
  return token;
}

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

export function redeemInvite(db, token, { name, now = new Date() } = {}) {
  const row = db.prepare("SELECT * FROM invitations WHERE token = ?").get(hashToken(String(token || "")));
  if (!row) return { ok: false, reason: "unknown" };
  if (row.accepted_at) return { ok: false, reason: "already_used" };
  const ageDays = (now - Date.parse(row.created_at)) / 86400000;
  if (ageDays > INVITE_TTL_DAYS) return { ok: false, reason: "expired" };

  let personId;
  db.exec("BEGIN");
  try {
    const r = db.prepare("INSERT INTO people (name, contact, auth_provider, auth_subject) VALUES (?,?,?,?)")
      .run(name || row.email, row.email, "invite", `invite:${row.id}`);
    personId = Number(r.lastInsertRowid);
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
