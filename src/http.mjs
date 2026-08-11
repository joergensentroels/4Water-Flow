// A small router over node:http. No framework, because a framework is a dependency that needs upgrading by
// whoever inherits this — and the whole app is a dozen routes.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ROOT } from "./config.mjs";

const BODY_LIMIT = 64 * 1024;   // no route here needs more; an unbounded body is a free denial of service

// Escaping is the DEFAULT, not an opt-in. `h` is used by every template; raw output requires calling
// `raw()` explicitly, so injecting markup is something you must choose rather than something you forget.
export const h = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const raw = (s) => ({ __raw: String(s) });
const render = (v) => (v && v.__raw !== undefined ? v.__raw : h(v));

// Tagged template for HTML: interpolations are escaped unless wrapped in raw(). Arrays are joined, so
// `${rows.map(r => html`<li>...`)}` works without a manual .join("").
// HTML comments are dropped at assembly, and the reason is a measurement rather than tidiness.
//
// The explanatory comments in the page templates are HTML comments, so they were being SERVED. Measured across six
// pages: 55% of the bytes. /plan alone was 264 KB of which 195 KB was comment, because the one comment in
// src/pages/plan.mjs sits inside a per-row map and shipped once per row — 223 times over a season. On the phone this
// app exists for, three-quarters of the page was prose for whoever maintains it.
//
// The comments stay in the source: a decision without its reason decays, and several record measurements that cost
// real time. They are simply not worth sending.
//
// HERE rather than in send(), and that distinction is a defect I shipped and then measured. Stripping in send()
// touched EVERY payload — including the JSON export, which is a data-protection right. A volunteer named
// "Ann <!-- note --> Berg" exported as "Ann  Berg": valid JSON, silently not their record. Doing it where HTML is
// BUILT means only HTML is ever affected, and the property is intrinsic rather than conditional on a header
// somebody could get wrong. It also covers a page rendered directly by a test, which send() did not.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (Array.isArray(v) ? v.map(render).join("") : render(v)) + strings[i + 1];
  }
  // After assembly, so a comment written across an interpolation is still whole. Interpolated user content cannot
  // form one: `h` escapes < to &lt; before it ever reaches this string.
  return raw(stripComments(out));
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // No inline script and no external origins: this app ships server-rendered HTML and one local stylesheet,
  // so the strictest policy that works is also the policy we need.
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : (body?.__raw ?? String(body ?? ""));
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // NOT CACHED by default, because the default response here carries somebody's name.
    //
    // Every gated page shows personal data — who is teaching on which evening, contact details on the admin
    // screen, one volunteer's whole record in an export — and this is a nonprofit where people share whatever
    // laptop is to hand. With no Cache-Control the browser applies its own heuristic, so the back button after a
    // sign-out can render the roster from cache. `no-store` is the standard answer for an authenticated app and
    // costs a re-fetch of a page that is under two kilobytes on every screen except the plan.
    //
    // In `send` rather than SECURITY_HEADERS, and that placement is the whole care in this change. serveStatic
    // spreads SECURITY_HEADERS AFTER its own `public, max-age=3600`, so putting it there would have silently
    // un-cached the stylesheet — the one response that deliberately wants caching. Here, a route's own headers win
    // (they spread last), which is how the calendar feed keeps `private, max-age=300`, and serveStatic's 200 path
    // does not come through this function at all. Two increments ago a transformation went into the universal
    // boundary and corrupted the JSON export; this is the same shape, checked before rather than after.
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(payload);
}

export const redirect = (res, to, headers = {}) =>
  send(res, 303, "", { Location: to, ...headers });   // 303: a POST must not be re-submitted on refresh

export async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  // Return a plain object, but keep getAll for checkbox groups — availability entry posts many values
  // under one name and losing all but the last would corrupt a volunteer's answers silently.
  const obj = Object.fromEntries(params);
  obj.__all = (k) => params.getAll(k);
  return obj;
}

const STATIC_TYPES = { ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

// `renderError` lets the caller draw error pages with the real layout. Without it a 404 was a bare <h1> with
// no stylesheet and no way back — found by browsing the app rather than by any test, because a test asserts
// the status code and never looks at the page.
export function createApp({ renderError = (status) => `<h1>${status}</h1>` } = {}) {
  const routes = [];
  const add = (method, pattern, handler) => {
    // "/board/:id/claim" -> a regex with named groups. Segments only; no path traversal is expressible.
    const rx = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/:(\w+)/g, "/(?<$1>[^/]+)") + "$");
    routes.push({ method, rx, handler, pattern });
  };
  const app = {
    get: (p, fn) => add("GET", p, fn),
    post: (p, fn) => add("POST", p, fn),
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        // decodeURIComponent throws URIError on a malformed escape, and `GET /%` is enough to do it. Decoded in
        // its own try so that is a 400: it fell into the generic catch below, which has no `.status` to read, so
        // it called a client's typo a 500 AND logged a stack trace for it. Bots probe with bad escapes
        // constantly, so that is an unbounded stream of server-error logs describing nothing wrong with the
        // server — the same noise `ratelimit.mjs` goes out of its way to bound.
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); }
        catch { return send(res, 400, renderError(400, req)); }

        if (req.method === "GET" && pathname.startsWith("/static/")) return serveStatic(pathname, res, renderError, req);

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.rx.exec(pathname);
          if (!m) continue;
          return await r.handler({ req, res, params: m.groups ?? {}, query: url.searchParams });
        }
        // A GET that matches a POST-only route is a 405, not a 404 — the difference matters when debugging
        // a form that posts to the wrong verb.
        const otherVerb = routes.some((r) => r.rx.test(pathname));
        const status = otherVerb ? 405 : 404;
        return send(res, status, renderError(status, req));
      } catch (e) {
        const status = e?.status ?? 500;
        if (status >= 500) console.error("[http]", e);
        // Never echo the error to the client: messages here can carry file paths and query fragments.
        return send(res, status, renderError(status, req));
      }
    },
    // Forwards a ready callback and returns the http.Server, so the caller can announce the bind only once it
    // has actually succeeded and attach an 'error' handler for when it has not. Without the callback the only
    // place to log success was the statement after this one — which runs before the bind resolves, so a port
    // collision printed "listening" and then crashed.
    listen: (port, host = "127.0.0.1", onReady) => createServer(app.handler).listen(port, host, onReady),
    // Introspection, so a test can walk every route the app actually registers rather than a hand-kept list
    // that drifts. A CSRF audit against a list somebody has to remember to update is not an audit.
    routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern })),
    // Would this app actually serve that? Asked by the post-sign-in redirect, and the reason it can be an
    // ALLOWLIST instead of a filter: a destination is acceptable only if a registered route matches it, so
    // `//evil.com`, `https://evil.com`, `/board/../admin` and every other spelling nobody thought of are refused
    // by not being routes rather than by being recognised as attacks. A filter has to enumerate what is bad; this
    // enumerates what is servable, and the router already knows.
    canServe: (method, pathname) => routes.some((r) => r.method === method && r.rx.test(pathname)),
  };
  return app;
}

// A content hash per static file, so the LINK carries the version and a changed file is a changed URL.
//
// Found while trying to measure a CSS fix in a browser and watching the old stylesheet come back three times. The
// response said `Cache-Control: public, max-age=3600` with no ETag and no Last-Modified, and the file is always at
// the same path — so a returning volunteer kept the previous stylesheet for up to an hour, the browser would not
// even send a conditional request in that window, and there was no way to make it. An hour of stale CSS on an app
// whose entire layout is one stylesheet is a phone that renders wrong with no explanation and nothing the operator
// can do but wait. A forced reload did not fix it either, which is what made the cause obvious rather than
// suspected.
//
// Computed once per process and memoised: the files are a few kilobytes and never change while running. Eight hex
// characters of SHA-256 is plenty to distinguish deployments — this is cache-busting, not integrity.
const versions = new Map();
export function assetVersion(name) {
  if (!versions.has(name)) {
    const file = path.join(ROOT, "static", path.basename(name));
    versions.set(name, existsSync(file)
      ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 8)
      : "0");
  }
  return versions.get(name);
}

function serveStatic(pathname, res, renderError, req) {
  const name = path.basename(pathname);                 // basename only: traversal is not expressible
  const ext = path.extname(name);
  const type = STATIC_TYPES[ext];
  if (!type) return send(res, 404, renderError(404, req));
  const file = path.join(ROOT, "static", name);
  if (!existsSync(file)) return send(res, 404, renderError(404));
  const body = readFileSync(file);
  // An ETag as well as the versioned link, because the bare URL stays valid and someone will bookmark or curl it.
  // Quoted per RFC 9110; a conditional request then costs a 304 instead of the whole file.
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
  const headers = { "Content-Type": type, "Cache-Control": "public, max-age=3600", ETag: etag, ...SECURITY_HEADERS };
  if (req?.headers?.["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, "Content-Length": body.length });
  res.end(body);
}
