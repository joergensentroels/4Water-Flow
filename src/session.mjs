// Sessions in a signed cookie. No server-side store, because 200 volunteers on one process do not need one,
// and no JWT library, because HMAC over JSON is the whole feature.
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const COOKIE = "4w_session";
// A volunteer entering availability once a season should not be logged out mid-form, so this is deliberately
// long. It used to say "30 days with a short-lived CSRF token instead", which was false: `newCsrf()` is sixteen
// random bytes with no timestamp, `checkCsrf` only compares them, and the token rides inside this same cookie
// for the full thirty days. Nothing was ever short-lived. The sentence justified a long session by naming a
// compensating control that did not exist — the more dangerous direction for a security comment to be wrong in,
// because it stops the next reader looking.
//
// The long life is still the right call, and rotation would be the wrong fix: minting a new token mid-session
// invalidates the form on any page a volunteer left open, which is exactly the "logged out mid-form" failure
// this value exists to prevent. What actually protects a POST is below — SameSite=Lax plus a per-session token
// that script cannot read.
const MAX_AGE_S = 60 * 60 * 24 * 30;

// The secret is required. Defaulting it to a constant would mean every deployment shares a forgeable
// cookie, and the failure is invisible — so refuse to start instead.
export function sessionSecret(env = process.env) {
  const s = env.FOURWATER_SECRET;
  if (!s || s.length < 32) {
    throw new Error("FOURWATER_SECRET must be set to at least 32 characters (generate: openssl rand -hex 32)");
  }
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
const mac = (secret, payload) => createHmac("sha256", secret).update(payload).digest();

export function sign(data, secret, now = Date.now()) {
  const body = b64u(JSON.stringify({ ...data, exp: Math.floor(now / 1000) + MAX_AGE_S }));
  return `${body}.${b64u(mac(secret, body))}`;
}

// Returns null for every failure mode. A caller that cannot distinguish "tampered" from "expired" cannot
// accidentally trust one of them, and the user-facing outcome is identical: sign in again.
export function verify(token, secret, now = Date.now()) {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  let given, expected;
  try { given = unb64u(token.slice(dot + 1)); } catch { return null; }
  expected = mac(secret, body);
  // Compare lengths first: timingSafeEqual throws on a length mismatch rather than returning false.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(unb64u(body).toString("utf8")); } catch { return null; }
  if (!data || typeof data.exp !== "number" || data.exp * 1000 <= now) return null;
  return data;
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Secure is conditional: it must be ON in production behind the reverse proxy, and OFF for local http
// development, or nothing works locally and someone "fixes" it by removing the flag permanently.
export const cookieHeader = (token, { secure = true, maxAge = MAX_AGE_S } = {}) =>
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

export const clearCookieHeader = ({ secure = true } = {}) =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

export const readSession = (req, secret, now = Date.now()) =>
  verify(parseCookies(req.headers?.cookie)[COOKIE], secret, now);

// ---- CSRF ---------------------------------------------------------------------------------------------
// SameSite=Lax already blocks cross-site POSTs in current browsers; this is the second lock, because
// "current browsers" is an assumption about other people's software. The token lives in the session so it
// needs no separate store.
export const newCsrf = () => randomBytes(16).toString("base64url");

export function checkCsrf(session, submitted) {
  const want = session?.csrf;
  if (!want || typeof submitted !== "string" || submitted.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(submitted));
}

export const COOKIE_NAME = COOKIE;
export const SESSION_MAX_AGE_S = MAX_AGE_S;
