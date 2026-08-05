// Reading the audit trail — the half that was missing for three commits while the writing half had five tests.
//
// The rows existed, the coverage existed, the privacy notice described them, and `listAudit` was imported into
// server.mjs and never called. So these tests are about REACHABILITY and about not lying on the page: that an
// admin can get to it, that a planner cannot, that paging reaches older rows without skipping any, and that a
// reference to something erased or pruned reads as gone rather than as a bare integer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { recordAudit, listAudit, AUDIT_PAGE } from "../src/audit.mjs";

const world = () => makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"], 1: ["planner"] } });

test("an admin can reach the log from the navigation, and it shows what happened", async () => {
  const w = await world();
  try {
    const admin = await w.signIn(w.people[0]);
    // Through a real action, so the page is rendering what the app writes rather than what a fixture invents.
    await w.post("/admin/role", admin,
      new URLSearchParams({ csrf: csrfFromCookie(admin), personId: String(w.people[2]), role: "planner", on: "1" }));

    const nav = await (await w.get("/admin", admin)).text();
    assert.match(nav, /href="\/audit"/, "an admin must be able to GET THERE — a page nothing links to is the defect");

    const res = await w.get("/audit", admin);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /A role was granted or removed/, "the action should read as a sentence, not a key");
    assert.match(body, /<code>admin\.role<\/code>/, "and the stable identifier should be there to quote");
    assert.doesNotMatch(body, /audit\.action\.[a-z]/, "a raw string key reached the page");

    // The subject is stored as person:<id>. An integer is not an answer to "who".
    const name = w.db.prepare("SELECT name FROM people WHERE id=?").get(w.people[2]).name;
    assert.ok(body.includes(name), `the subject should resolve to ${name}, not an id`);
    assert.doesNotMatch(body, /person:\d+/, "an unresolved reference was rendered");
  } finally { w.close(); }
});

test("a planner cannot read it", async () => {
  const w = await world();
  try {
    const planner = await w.signIn(w.people[1]);
    assert.equal((await w.get("/audit", planner)).status, 403,
      "the log carries who was erased and who was given privilege — that is administration, not planning");
    const nav = await (await w.get("/planner", planner)).text();
    assert.doesNotMatch(nav, /href="\/audit"/, "and it must not be offered to them either");
  } finally { w.close(); }
});

test("paging reaches older entries and skips none", async () => {
  const w = await world();
  try {
    const admin = await w.signIn(w.people[0]);
    // More than one page, each entry distinguishable, and timestamps a second apart so ordering is unambiguous.
    const total = AUDIT_PAGE + 7;
    for (let i = 0; i < total; i++) {
      recordAudit(w.db, { actorName: "Alice", action: "planner.assign", detail: `entry-${i}`,
                          at: new Date(Date.UTC(2026, 2, 1, 0, 0, i)) });
    }
    const first = await (await w.get("/audit", admin)).text();
    // A bare `&` between parameters, not `&amp;`. That is deliberate and correct: an "ambiguous ampersand" in
    // HTML5 is one followed by alphanumerics AND a semicolon, so `&beforeId=8` is not one. The first version of
    // this regex demanded `&amp;` and failed against a page that was rendering the link perfectly well — the
    // probe was wrong, not the page. Values are still escaped; http.mjs does that to everything interpolated.
    const older = /href="\/audit\?before=([^&"]+)&(?:amp;)?beforeId=(\d+)"/.exec(first);
    assert.ok(older, "with more than one page there must be a link to the older ones");

    const second = await (await w.get(`/audit?before=${older[1]}&beforeId=${older[2]}`, admin)).text();
    assert.match(second, /href="\/audit"/, "and a way back to the newest");

    // Every entry must appear on exactly one of the two pages. A keyset cursor is used rather than OFFSET
    // precisely so that this holds while rows are being written; an offset would drop one silently.
    const seen = new Map();
    for (const page of [first, second]) {
      for (const m of page.matchAll(/entry-(\d+)/g)) seen.set(Number(m[1]), (seen.get(Number(m[1])) ?? 0) + 1);
    }
    const missing = [...Array(total).keys()].filter((i) => !seen.has(i));
    const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([i]) => i);
    assert.deepEqual(missing, [], `these entries appear on neither page: ${missing}`);
    assert.deepEqual(twice, [], `these entries appear on both pages: ${twice}`);
  } finally { w.close(); }
});

test("half a cursor is treated as no cursor, not as page zero", async () => {
  const w = await world();
  try {
    const admin = await w.signIn(w.people[0]);
    recordAudit(w.db, { actorName: "Alice", action: "planner.assign", detail: "only-entry" });
    for (const bad of ["?before=2026-03-01T00%3A00%3A00.000Z", "?beforeId=5", "?before=&beforeId=", "?beforeId=abc"]) {
      const res = await w.get(`/audit${bad}`, admin);
      assert.equal(res.status, 200, `${bad} should render, not fail`);
      assert.match(await res.text(), /only-entry/, `${bad} silently hid the only entry there is`);
    }
  } finally { w.close(); }
});

test("a reference to something erased or pruned reads as gone", async () => {
  const w = await world();
  try {
    const admin = await w.signIn(w.people[0]);
    // Ids that point at nothing: a person deleted by a hard erasure, an assignment whose season was pruned.
    recordAudit(w.db, { actorName: "Alice", action: "admin.status", subject: "person:99999" });
    recordAudit(w.db, { actorName: "Alice", action: "planner.assign", subject: "assignment:99999",
                        detail: "to person:99998" });

    const body = await (await w.get("/audit", admin)).text();
    assert.doesNotMatch(body, /person:9999\d/, "a dangling reference was rendered as a raw id");
    assert.doesNotMatch(body, /assignment:99999/, "same for the assignment");
    assert.equal((body.match(/no longer in the system/g) ?? []).length, 3,
      "all three dangling references should say so — and the count matters: it proves the substitution ran on " +
      "the detail as well as the subject");
  } finally { w.close(); }
});

test("the retention window on the page is the configured one", async () => {
  const w = await world();
  try {
    const admin = await w.signIn(w.people[0]);
    const body = await (await w.get("/audit", admin)).text();
    // Not a hardcoded 730: the page must read the same config the pruning job does, or it tells an admin their
    // data is kept for a period that is not the period.
    const days = w.pattern.retention?.auditDays ?? 730;
    assert.ok(body.includes(String(days)), `the page should state the configured window (${days})`);
  } finally { w.close(); }
});

test("the page caps what it renders, whatever is in the table", async () => {
  const w = await world();
  try {
    const admin = await w.signIn(w.people[0]);
    for (let i = 0; i < AUDIT_PAGE + 50; i++) {
      recordAudit(w.db, { actorName: "Alice", action: "planner.assign", detail: `row-${i}`,
                          at: new Date(Date.UTC(2026, 2, 1, 0, 0, i % 60, i)) });
    }
    const body = await (await w.get("/audit", admin)).text();
    const rendered = (body.match(/<li class="auditrow">/g) ?? []).length;
    assert.equal(rendered, AUDIT_PAGE, `rendered ${rendered} rows; the cap exists so a season of activity is not `
      + `half a megabyte on a phone, which this project has shipped twice`);
    assert.equal(listAudit(w.db, { limit: 10_000 }).length, AUDIT_PAGE,
      "and listAudit must enforce the cap itself, not trust its caller");
  } finally { w.close(); }
});
