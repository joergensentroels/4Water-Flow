// A small router over node:http. No framework, because a framework is a dependency that needs upgrading by
// whoever inherits this — and the whole app is a dozen routes.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
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
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (Array.isArray(v) ? v.map(render).join("") : render(v)) + strings[i + 1];
  }
  return raw(out);
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
        const pathname = decodeURIComponent(url.pathname);

        if (req.method === "GET" && pathname.startsWith("/static/")) return serveStatic(pathname, res, renderError);

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
        return send(res, status, renderError(status));
      } catch (e) {
        const status = e?.status ?? 500;
        if (status >= 500) console.error("[http]", e);
        // Never echo the error to the client: messages here can carry file paths and query fragments.
        return send(res, status, renderError(status));
      }
    },
    listen: (port, host = "127.0.0.1") => createServer(app.handler).listen(port, host),
    // Introspection, so a test can walk every route the app actually registers rather than a hand-kept list
    // that drifts. A CSRF audit against a list somebody has to remember to update is not an audit.
    routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern })),
  };
  return app;
}

function serveStatic(pathname, res, renderError) {
  const name = path.basename(pathname);                 // basename only: traversal is not expressible
  const ext = path.extname(name);
  const type = STATIC_TYPES[ext];
  if (!type) return send(res, 404, renderError(404));
  const file = path.join(ROOT, "static", name);
  if (!existsSync(file)) return send(res, 404, renderError(404));
  const body = readFileSync(file);
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "public, max-age=3600", ...SECURITY_HEADERS });
  res.end(body);
}
