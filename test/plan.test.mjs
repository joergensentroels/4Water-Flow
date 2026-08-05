// Increment C: the read-only views. The interesting assertions are the empty states and the query count —
// a per-row lookup is invisible at 40 volunteers and painful at 200.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, countQueries } from "../tools/testkit.mjs";
import { planForSeason, myUpcoming } from "../src/queries.mjs";

const withWorld = (opts, fn) => async () => {
  const w = await makeWorld(opts);
  try { await fn(w); } finally { w.close(); }
};

test("home and the plan both require a session", withWorld({}, async ({ get }) => {
  for (const path of ["/", "/plan"]) {
    const r = await get(path);
    assert.equal(r.status, 303, path);
    // "/" carries no destination, because that is where sign-in lands anyway; "/plan" carries one.
    assert.equal(r.headers.get("location"), path === "/" ? "/signin" : `/signin?next=${encodeURIComponent(path)}`, path);
  }
}));

test("a volunteer with nothing assigned gets a real empty state, not a blank page", withWorld({}, async ({ people, signIn, get, pattern }) => {
  const cookie = await signIn(people[0]);
  const body = await (await get("/", cookie)).text();
  // The message, not just an absence of rows.
  assert.match(body, /You have no upcoming slots|Du har ingen kommende vagter/);
  // And the two things they can actually do next are on the page.
  assert.match(body, /href="\/availability"/);
  assert.match(body, /href="\/board"/);
  // Score renders as zero-and-inactive rather than blank.
  assert.match(body, /Not active this season|Ikke aktiv i denne sæson/);
}));

test("home lists my own upcoming slots and nobody else's", withWorld({}, async ({ db, people, seasonId, signIn, get, today }) => {
  const mineId = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                             WHERE s.date >= ? ORDER BY s.date LIMIT 1`).get(today).id;
  const theirsId = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.date >= ? AND a.id <> ? ORDER BY s.date LIMIT 1`).get(today, mineId).id;
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(people[0], mineId);
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(people[1], theirsId);

  const rows = myUpcoming(db, people[0], seasonId, today);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assignmentId, mineId);

  const body = await (await get("/", await signIn(people[0]))).text();
  assert.match(body, /Your upcoming slots|Dine kommende vagter/);
  assert.match(body, /1 —|<b>1<\/b>/, "score should now read 1");
  assert.match(body, /Active volunteer|Aktiv frivillig/);
}));

test("a proposed assignment is labelled as a proposal, not shown as settled", withWorld({}, async ({ db, people, signIn, get, today }) => {
  const id = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                         WHERE s.date >= ? ORDER BY s.date LIMIT 1`).get(today).id;
  db.prepare("UPDATE assignments SET person_id=?, state='proposed' WHERE id=?").run(people[0], id);

  const body = await (await get("/", await signIn(people[0]))).text();
  assert.match(body, /Proposed|Forslag/, "an auto-roster proposal must be visibly provisional");
  // And it must not inflate Score, which only counts confirmed work.
  assert.match(body, /Not active this season|Ikke aktiv i denne sæson/);
}));

test("past slots are not 'upcoming'", withWorld({}, async ({ db, people, seasonId, signIn, get }) => {
  const first = db.prepare("SELECT s.date, a.id FROM assignments a JOIN sessions s ON s.id=a.session_id ORDER BY s.date LIMIT 1").get();
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(people[0], first.id);
  const dayAfter = new Date(Date.parse(`${first.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  assert.equal(myUpcoming(db, people[0], seasonId, dayAfter).length, 0, "a slot that already happened is not upcoming");
  assert.equal(myUpcoming(db, people[0], seasonId, first.date).length, 1, "the day itself still counts");
}));

test("the plan shows open slots as open, me as me, and others by name", withWorld({}, async ({ db, people, signIn, get, today }) => {
  const ids = db.prepare(`SELECT a.id FROM assignments a JOIN sessions s ON s.id=a.session_id
                          WHERE s.date >= ? ORDER BY s.date LIMIT 2`).all(today).map((r) => r.id);
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(people[0], ids[0]);
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(people[1], ids[1]);

  const body = await (await get("/plan", await signIn(people[0]))).text();
  assert.match(body, /You|Dig/, "my own slot should say 'you'");
  assert.match(body, /Volunteer 2/, "someone else's slot shows their name");
  assert.match(body, /Open|Ledig/, "unfilled slots read as open");
  // Activity labels come from config, so they must appear — proving the seam feeds the page.
  assert.ok(body.includes(db.prepare("SELECT label FROM activities LIMIT 1").get().label));
}));

test("rendering the whole season is a fixed number of queries, not one per row", withWorld({}, async ({ db, seasonId }) => {
  const rows = planForSeason(db, seasonId);
  assert.ok(rows.length > 50, `expected a season with many rows, got ${rows.length}`);

  const c = countQueries(db);
  const again = planForSeason(db, seasonId);
  c.restore();
  assert.equal(again.length, rows.length);
  assert.equal(c.n, 1, `the season view must be ONE query; it issued ${c.n} for ${rows.length} rows`);
}));

test("home is a bounded number of queries regardless of season size", withWorld({}, async ({ db, people, seasonId, today }) => {
  const c = countQueries(db);
  myUpcoming(db, people[0], seasonId, today);
  c.restore();
  assert.equal(c.n, 1, "one query for a volunteer's own slots");
}));
