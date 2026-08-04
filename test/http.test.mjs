// Increment A: the router. Tested through a real server on an ephemeral port rather than with a mock
// req/res, because the things most likely to be wrong — header casing, status codes, body limits — are
// exactly what a hand-rolled mock would paper over.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, html, h, raw, send, redirect, readForm } from "../src/http.mjs";

let base;
let server;

before(async () => {
  const app = createApp();
  app.get("/ok", ({ res }) => send(res, 200, html`<p>fine</p>`));
  app.get("/echo/:id", ({ res, params }) => send(res, 200, html`<p>${params.id}</p>`));
  app.post("/form", async ({ req, res }) => {
    const f = await readForm(req);
    send(res, 200, html`<p>${f.name}</p><p>${f.__all("day").join(",")}</p>`);
  });
  app.post("/only-post", ({ res }) => send(res, 200, html`<p>posted</p>`));
  app.get("/boom", () => { throw new Error("secret path C:\\Users\\somebody\\thing"); });
  app.get("/teapot", () => { throw Object.assign(new Error("nope"), { status: 418 }); });
  app.get("/go", ({ res }) => redirect(res, "/ok"));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test("escaping is the default; raw() is the explicit opt-out", () => {
  assert.equal(h(`<script>"x"&'y'`), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
  assert.equal(html`<p>${"<b>hi</b>"}</p>`.__raw, "<p>&lt;b&gt;hi&lt;/b&gt;</p>");
  assert.equal(html`<p>${raw("<b>hi</b>")}</p>`.__raw, "<p><b>hi</b></p>");
  assert.equal(html`<ul>${[1, 2].map((n) => html`<li>${n}</li>`)}</ul>`.__raw, "<ul><li>1</li><li>2</li></ul>");
  assert.equal(html`<p>${null}${undefined}</p>`.__raw, "<p></p>", "null must render empty, not the word null");
});

test("a path parameter reaching the page is escaped", async () => {
  const r = await fetch(`${base}/echo/${encodeURIComponent("<img src=x>")}`);
  const body = await r.text();
  assert.equal(r.status, 200);
  assert.ok(body.includes("&lt;img"), "a reflected parameter must be escaped");
  assert.ok(!body.includes("<img"), `unescaped markup reached the page: ${body}`);
});

test("security headers are on every response, including errors and redirects", async () => {
  for (const p of ["/ok", "/nope", "/boom", "/go"]) {
    const r = await fetch(`${base}${p}`, { redirect: "manual" });
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", p);
    assert.equal(r.headers.get("x-frame-options"), "DENY", p);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer", p);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, p);
  }
});

test("a wrong verb is 405, a genuinely unknown path is 404", async () => {
  assert.equal((await fetch(`${base}/only-post`)).status, 405);
  assert.equal((await fetch(`${base}/not-a-route`)).status, 404);
  assert.equal((await fetch(`${base}/only-post`, { method: "POST" })).status, 200);
});

test("an internal error leaks nothing, and an explicit status is honoured", async () => {
  const r = await fetch(`${base}/boom`);
  assert.equal(r.status, 500);
  const body = await r.text();
  assert.ok(!/Users|secret path/.test(body), `the error body leaked internals: ${body}`);
  assert.equal((await fetch(`${base}/teapot`)).status, 418);
});

test("a POST redirect is 303 so a refresh cannot resubmit", async () => {
  const r = await fetch(`${base}/go`, { redirect: "manual" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/ok");
});

test("form parsing keeps every value of a repeated field", async () => {
  const body = new URLSearchParams();
  body.append("name", "Volunteer 1");
  body.append("day", "2026-01-07");
  body.append("day", "2026-01-11");
  const r = await fetch(`${base}/form`, { method: "POST", body });
  const text = await r.text();
  assert.ok(text.includes("Volunteer 1"));
  // Object.fromEntries would silently keep only the last one, which would quietly drop a volunteer's
  // availability answers — hence __all().
  assert.ok(text.includes("2026-01-07,2026-01-11"), `repeated field collapsed: ${text}`);
});

test("an oversized body is refused rather than buffered", async () => {
  const r = await fetch(`${base}/form`, { method: "POST", body: new URLSearchParams({ name: "x".repeat(70 * 1024) }) });
  assert.equal(r.status, 413);
});

test("static serving allows only known extensions and cannot traverse", async () => {
  for (const p of ["/static/../src/db.mjs", "/static/db.mjs", "/static/%2e%2e%2fsrc%2fdb.mjs", "/static/nope.css"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, `${p} should not be served (got ${r.status})`);
  }
});
