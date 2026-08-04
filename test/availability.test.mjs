// Increment B, driven through the real server: sign in, fetch the form, post it, read it back.
// Every test gets its own database and server — see tools/testkit.mjs for why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, slotsIn } from "../tools/testkit.mjs";

// A tiny wrapper so no test can forget to close its world.
const withWorld = (opts, fn) => async () => {
  const w = await makeWorld(opts);
  try { await fn(w); } finally { w.close(); }
};

test("an anonymous visitor is sent to sign-in, not shown the form", withWorld({}, async ({ get }) => {
  const r = await get("/availability");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/signin");
}));

test("the form offers exactly the season's session dates and needs no JavaScript", withWorld({}, async ({ db, seasonId, people, signIn, get }) => {
  const cookie = await signIn(people[0]);
  const body = await (await get("/availability", cookie)).text();

  const offered = slotsIn(body).map((s) => `${s.date}:${s.hour}`).sort();
  const expected = db.prepare(`SELECT DISTINCT s.date || ':' || t.hour AS k FROM sessions s
                               JOIN timeslots t ON t.id=s.timeslot_id WHERE s.season_id=?`).all(seasonId).map((r) => r.k).sort();
  assert.deepEqual(offered, expected);

  assert.ok(!/<script/i.test(body), "the page must work with JS disabled");
  assert.match(body, /<form method="post" action="\/availability"/);
}));

test("answers round-trip, and the three states stay distinguishable", withWorld({}, async ({ db, people, signIn, csrfFrom, post, get }) => {
  const cookie = await signIn(people[0]);
  const { token, body: page } = await csrfFrom("/availability", cookie);
  const [a, b, c] = slotsIn(page);
  assert.ok(c, "need three distinct slots to tell three states apart");

  const form = new URLSearchParams({ csrf: token });
  form.set(a.key, "1");
  form.set(b.key, "0");
  form.set(c.key, "");                       // explicitly "no answer"
  assert.equal((await post("/availability", cookie, form)).status, 303);

  const rows = db.prepare("SELECT date, hour, available FROM availability_hour WHERE person_id=?").all(people[0]);
  assert.equal(rows.length, 2, "an empty answer must store nothing, not a zero");
  assert.equal(rows.find((r) => r.date === a.date && String(r.hour) === a.hour).available, 1);
  assert.equal(rows.find((r) => r.date === b.date && String(r.hour) === b.hour).available, 0);

  const again = await (await get("/availability", cookie)).text();
  assert.match(again, new RegExp(`id="${a.key}:1"[^>]*checked`), "a 'can' answer must come back checked");
  assert.match(again, new RegExp(`id="${b.key}:0"[^>]*checked`));
  assert.match(again, new RegExp(`id="${c.key}:x"[^>]*checked`), "an unanswered date must show as unanswered");
}));

test("clearing an answer removes the row rather than recording a 'no'", withWorld({}, async ({ db, people, signIn, csrfFrom, post }) => {
  const cookie = await signIn(people[0]);
  const { token, body } = await csrfFrom("/availability", cookie);
  const [a] = slotsIn(body);

  await post("/availability", cookie, new URLSearchParams({ csrf: token, [a.key]: "1" }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(people[0]).n, 1);

  await post("/availability", cookie, new URLSearchParams({ csrf: token, [a.key]: "" }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(people[0]).n, 0,
    "silence must leave no row — it is not a 'no'");
}));

test("a POST without a valid CSRF token is refused and writes nothing", withWorld({}, async ({ db, people, signIn, csrfFrom, post }) => {
  const cookie = await signIn(people[0]);
  const { body } = await csrfFrom("/availability", cookie);
  const [a] = slotsIn(body);

  for (const bad of [undefined, "", "not-the-token"]) {
    const form = new URLSearchParams({ [a.key]: "1" });
    if (bad !== undefined) form.set("csrf", bad);
    assert.equal((await post("/availability", cookie, form)).status, 403, `csrf=${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM availability_hour").get().n, 0);
}));

test("the person written comes from the session, never from the form", withWorld({}, async ({ db, people, signIn, csrfFrom, post }) => {
  const cookie = await signIn(people[1]);
  const { token, body } = await csrfFrom("/availability", cookie);
  const [a] = slotsIn(body);

  const form = new URLSearchParams({ csrf: token });
  form.set(a.key, "1");
  form.set("personId", String(people[0]));    // no such field exists; prove it is ignored
  form.set("person_id", String(people[0]));
  await post("/availability", cookie, form);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(people[0]).n, 0,
    "a forged person field must not write to another volunteer");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(people[1]).n, 1);
}));

test("a fabricated date is ignored rather than stored", withWorld({}, async ({ db, people, signIn, csrfFrom, post }) => {
  const cookie = await signIn(people[0]);
  const { token } = await csrfFrom("/availability", cookie);
  const form = new URLSearchParams({ csrf: token });
  form.set("slot:1999-01-01:19", "1");        // no session exists then
  form.set("slot:not-a-date:19", "1");
  await post("/availability", cookie, form);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM availability_hour").get().n, 0);
}));

test("/healthz answers without a session, for the container probe", withWorld({}, async ({ get }) => {
  const r = await get("/healthz");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok");
}));
