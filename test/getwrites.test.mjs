// The other half of test/csrf-audit.test.mjs. That one proves every POST refuses a bad token, which says nothing
// about GETs — and a GET that writes is the way round a CSRF guard rather than through it. Nothing issues the
// token: a browser fetches GETs from <img src>, a link prefetcher, a chat client unfurling a pasted URL, a mail
// gateway scanning a link before the recipient sees it.
//
// This is not hypothetical here. GET /invite/:token used to redeem the invitation, so one fetch by a mail scanner
// created the person, marked the invitation spent, and handed the session cookie to the scanner — and the
// volunteer's own click then got /signin?unknown=1. The audit exists because that was found by asking this
// question, and it stays so the answer cannot change quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie, makeAvailableEverywhere, slotsIn } from "../tools/testkit.mjs";
import { createInvite } from "../src/auth.mjs";

const MUTATING = /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|VACUUM)\b/i;

// Wraps prepare() AND exec() so every mutating statement executed from here on is recorded. Installed after the
// fixture is built, so only request-time writes are seen. There is no prepared-statement cache in this app and no
// db.prepare at module scope — every call site prepares inline — so wrapping prepare catches all of those.
//
// `exec` is wrapped because leaving it out left this whole audit resting on an unverified premise about the
// codebase: that no data write ever goes through it. The premise is true right now — every `db.exec` in src/ is
// transaction control, a PRAGMA, or migration DDL — but that is a fact about today's source rather than a property
// of the instrument, and the audit read as though it covered everything. One `db.exec("UPDATE ...")` in a future GET
// handler would have been invisible to a sweep that then reported a clean result: the check would have asserted
// "nothing written through prepare" while claiming "no GET writes". Wrapping both is cheaper than a second check
// asserting the premise, and it cannot go stale.
//
// BEGIN, COMMIT and ROLLBACK do not match MUTATING, so transaction control stays quiet, and the migration's DDL
// runs long before this wrapper exists.
function watchWrites(db) {
  const seen = [];
  const note = (sql) => sql.replace(/\s+/g, " ").trim().slice(0, 72);
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = realPrepare(sql);
    if (!MUTATING.test(sql)) return st;
    return { ...st, run: (...a) => { seen.push(note(sql)); return st.run(...a); },
                    get: (...a) => { seen.push(note(sql)); return st.get(...a); },
                    all: (...a) => { seen.push(note(sql)); return st.all(...a); } };
  };
  const realExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (MUTATING.test(sql)) seen.push(note(sql));
    return realExec(sql);
  };
  return seen;
}

// The one GET allowed to write, and why. GET /auth/callback also writes — linkIdentity creates or adopts the
// person — but its success path needs a live provider, so it cannot be reached from in-process here; it is covered
// end to end by test/oidc-endtoend.test.mjs. It is listed so this file does not silently depend on that.
const MAY_WRITE = new Map([
  ["/auth/callback", "returning from the identity provider IS the sign-in, and the protocol makes it a GET. The "
    + "state parameter is checked against the session before anything is written, and the route is throttled. "
    + "Its writing path is unreachable without a provider, so it is exercised in oidc-endtoend, not here."],
]);

test("no GET route writes to the database, except the one that authenticates", async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin"], 1: ["planner"] } });
  try {
    for (const p of w.people) {
      makeAvailableEverywhere(w.db, p);
      w.db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) SELECT ?, id FROM activities").run(p);
    }
    const admin = await w.signIn(w.people[0]);
    // A real invitation, so /invite/:token takes its SUCCESS path. With a bogus token it redirects before reaching
    // anything, and a clean result there would be about the failure path only — which is exactly how a sweep
    // reports that nothing writes while never having run the code that does.
    const { token } = createInvite(w.db, { email: "audited@example.org" });

    const seen = watchWrites(w.db);
    const gets = w.routes().filter((r) => r.method === "GET");
    assert.ok(gets.length >= 15, `expected many GET routes, saw ${gets.length}`);

    const writers = [];
    for (const r of gets) {
      seen.length = 0;
      const path = r.pattern === "/invite/:token" ? `/invite/${token}` : r.pattern.replace(/:(\w+)/g, () => "1");
      await w.get(path, admin);
      if (seen.length) writers.push(`GET ${r.pattern} wrote: ${[...new Set(seen)].join(" | ")}`);
    }
    assert.deepEqual(writers.filter((x) => ![...MAY_WRITE.keys()].some((k) => x.startsWith(`GET ${k} `))), [],
      `a GET that writes is reachable without a CSRF token, from an <img> tag or a link scanner:\n  ${writers.join("\n  ")}`);

    for (const [route, why] of MAY_WRITE) {
      assert.ok(w.routes().some((r) => r.method === "GET" && r.pattern === route),
        `${route} is listed as allowed to write but is not a GET route any more — remove the entry`);
      assert.ok(why.length >= 60, `${route}: record WHY the protocol forces a write on a GET, not just that it does`);
    }
  } finally { w.close(); }
});

// The audit above is worth nothing if the wrapper cannot see a write. Two controls: a POST that certainly writes,
// and the invitation accepted through the route that replaced the redeeming GET.
test("the write detector sees writes, on a POST and on the route that used to be a GET", async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] } });
  try {
    const admin = await w.signIn(w.people[0]);
    const { token } = createInvite(w.db, { email: "control@example.org" });
    const form = await (await w.get("/availability", admin)).text();
    const slot = slotsIn(form)[0];
    assert.ok(slot, "the availability form must offer a date, or the control below writes nothing");

    const seen = watchWrites(w.db);
    await w.post("/availability", admin,
      new URLSearchParams({ csrf: csrfFromCookie(admin), [`slot:${slot.date}:${slot.hour}`]: "1" }));
    assert.ok(seen.length > 0, "saving an availability answer must be seen as a write, or the audit above is blind");

    // And the accept route, which is the write the GET used to do. If this stopped writing, the invitation flow
    // would be broken in a way the audit above would report as a clean sweep.
    seen.length = 0;
    const accepted = await w.post(`/invite/${token}/accept`, null, new URLSearchParams({}));
    assert.equal(accepted.headers.get("location"), "/availability", "the accept route must still work");
    assert.ok(seen.some((s) => /INSERT INTO people/i.test(s)),
      "accepting an invitation must create the person — on the POST, where it belongs");
  } finally { w.close(); }
});

// The control for the OTHER half of the watcher. Wrapping `exec` closes a hole in the audit above, and an unexercised
// wrapper is exactly the decoration this repository keeps removing — so this drives a write through `exec` directly
// and requires the watcher to see it, and drives transaction control through the same path and requires silence.
//
// Both directions matter. If BEGIN or COMMIT were recorded as writes, every GET that opens a transaction would be
// reported as a writer, the audit would fail on correct code, and the fix would be to loosen it — which is how a
// working check gets weakened into a broken one.
test("the write detector sees an exec write, and stays quiet on transaction control", async () => {
  const w = await makeWorld({ volunteers: 1 });
  try {
    const seen = watchWrites(w.db);

    w.db.exec("BEGIN");
    w.db.exec("COMMIT");
    assert.deepEqual(seen, [], "transaction control was recorded as a write — every GET that opens one would fail");

    // A real write, through exec rather than prepare. This is the shape the audit above could not see before.
    w.db.exec("UPDATE people SET name = name WHERE id = 0");
    assert.equal(seen.length, 1, "a write through exec() was not seen — wrapping it accomplished nothing");
    assert.match(seen[0], /^UPDATE people/, `the recorded note does not name the statement: ${seen[0]}`);

    // And prepare is still wrapped: replacing exec must not have shadowed the original half.
    seen.length = 0;
    w.db.prepare("UPDATE people SET name = name WHERE id = 0").run();
    assert.equal(seen.length, 1, "the prepare wrapper stopped working when the exec wrapper was added");
  } finally { w.close(); }
});
