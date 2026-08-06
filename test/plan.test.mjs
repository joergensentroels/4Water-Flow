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

// ---- the horizon on the page every volunteer opens --------------------------------------------------------------
//
// MEASURED IN A BROWSER at 375px on the demo instance, which is the only way this was ever going to surface: /plan
// rendered 46 dates, 59 KB and 15,012 pixels of page — eighteen phone screens — starting six weeks IN THE PAST. So
// "am I on this Wednesday" was eighteen screens down, behind a month and a half of history.
//
// The planner's grid has had a four-week window with widen links since the whole-season view was measured at 490 KB.
// The page with twenty times the readers got none of it: the same fix applied to the back-office screen and not to
// the volunteers'. The windowing is now one definition in queries.mjs and both pages call it.
test("the plan opens on the next four weeks, not on the start of the season", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[0]);
  const shown = async (q = "") => {
    const body = await (await w.get(`/plan${q}`, cookie)).text();
    // The dates are read back through the session links the page renders, resolved in the database — the page prints
    // them in a human format (formatDate) and parsing that back would be testing the formatter, not the horizon.
    const ids = [...new Set([...body.matchAll(/\/session\/(\d+)/g)].map((m) => Number(m[1])))];
    const dates = ids.length === 0 ? []
      : w.db.prepare(`SELECT DISTINCT date FROM sessions WHERE id IN (${ids.join(",")}) ORDER BY date`)
          .all().map((r) => r.date);
    return { body, dates };
  };

  // The fixture's season starts ON today, so there is no past to exclude and half of this test would be unaskable.
  // Its own control caught that on the first run — it refused with the two ranges printed. So a handful of sessions are
  // moved behind today, which is also the realistic state: a season in progress has history.
  const early = w.db.prepare("SELECT DISTINCT date FROM sessions ORDER BY date LIMIT 2").all().map((r) => r.date);
  w.db.prepare(`UPDATE sessions SET date = date(date, '-60 days') WHERE date IN ('${early.join("','")}')`).run();

  // And now the fixture must span the horizon in both directions, or the assertions below cannot fail.
  const until = new Date(Date.parse(`${w.today}T00:00:00Z`) + 28 * 86400000).toISOString().slice(0, 10);
  const all = w.db.prepare("SELECT MIN(date) lo, MAX(date) hi FROM sessions").get();
  assert.ok(all.lo < w.today && all.hi > until,
    `the season must reach either side of the window (${all.lo}..${all.hi} around ${w.today}..${until})`);

  const dflt = await shown();
  assert.ok(dflt.dates.length > 0, "the default view must show something");
  assert.ok(dflt.dates.every((d) => d >= w.today && d <= until),
    `the default view must be this window only, got ${dflt.dates[0]}..${dflt.dates.at(-1)}`);
  // The way out has to be on the page, or a four-week default is a feature nobody can turn off.
  assert.match(dflt.body, /\/plan\?weeks=all/, "and a link to the whole season");
  assert.match(dflt.body, /aria-current="true"/, "with the current horizon marked, so the page cannot lie about itself");

  const everything = await shown("?weeks=all");
  assert.ok(everything.dates.some((d) => d < w.today),
    "the whole-season view includes the past, because 'who taught in September' is a fair question here");
  assert.ok(everything.dates.length > dflt.dates.length, "and it is genuinely wider than the default");
}));

// The regression the four-week default introduced, and the reason a real deployment caught it rather than a unit test:
// 4water's shipped config covers January to June, so on any date after that the next four weeks are empty — and the
// page announced "there are no activities in this season yet" about a season with 223 of them.
test("a season entirely outside the window shows the season, with the chips saying so", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[0]);
  // Move every session far into the past, so the default window is empty while the season is not.
  w.db.prepare("UPDATE sessions SET date = date(date, '-400 days')").run();
  const body = await (await w.get("/plan", cookie)).text();
  assert.doesNotMatch(body, /no activities in this season/,
    "a season with sessions must never describe itself as empty just because they are outside the default window");
  assert.match(body, /\/session\/\d+/, "the sessions must be on the page");
  // And the chip that is current must be the whole-season one, since that is what is being shown.
  const current = body.match(/<a class="chip" href="\/plan\?weeks=(\w+)" aria-current="true"/);
  assert.equal(current?.[1], "all", `the current chip should be "all", markup says ${current?.[1]}`);
}));
