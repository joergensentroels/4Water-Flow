// Notes on a shift — the "chat system of sorts" 4water asked for, in the shape they did not specify.
//
// The shape was my call and the reasoning is in src/notes.mjs; what these tests pin is the part that would hurt if
// it were wrong: that the page is REACHABLE, that nobody can touch another volunteer's words, that free text does
// not escape the GDPR work, and that a note count on a whole-season page costs one query rather than one per row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeWorld, csrfFromCookie, countQueries } from "../tools/testkit.mjs";
import { migrate } from "../src/db.mjs";
import { listNotes, addNote, deleteNote, noteCounts, NOTE_MAX, deleteNotesBy } from "../src/notes.mjs";
import { erasePerson, pruneSeasons } from "../src/retention.mjs";
import { seedSeason } from "../src/seed.mjs";
import { loadPattern } from "../src/config.mjs";

const world = () => makeWorld({ volunteers: 3, roles: { 0: ["planner"] } });
const aSession = (w) => w.db.prepare("SELECT id FROM sessions WHERE season_id=? ORDER BY date LIMIT 1").get(w.seasonId).id;

test("the plan links to every session, so the notes are reachable at all", async () => {
  const w = await world();
  try {
    const me = await w.signIn(w.people[0]);
    const body = await (await w.get("/plan", me)).text();
    const sid = aSession(w);
    assert.match(body, new RegExp(`href="/session/${sid}"`),
      "a page nobody can navigate to is the defect this project has shipped three times");
    // The accessible name says WHICH shift, not just "Details".
    assert.match(body, /aria-label="Details — /, "the link must name the shift it opens");

    // ONE link per session. A class with a leader and a follower is two assignment rows on one session, and the
    // first version linked from both — two adjacent links to the same page, announcing different names. Found in a
    // browser, not by a test, which is why this assertion exists at all.
    const links = [...body.matchAll(/href="\/session\/(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(links, [...new Set(links)],
      `the plan links to some session twice: ${links.filter((s, i) => links.indexOf(s) !== i).join(", ")}`);
    assert.ok(links.length >= 2, `expected a link per session, saw ${links.length}`);
  } finally { w.close(); }
});

test("a note appears on the shift, signed and timed", async () => {
  const w = await world();
  try {
    const me = await w.signIn(w.people[1]);
    const sid = aSession(w);
    const res = await w.post(`/session/${sid}/note`, me,
      new URLSearchParams({ csrf: csrfFromCookie(me), body: "  Bring   the speaker  " }));
    assert.equal(new URL(res.headers.get("location"), "http://x").searchParams.get("r"), "note_added");

    const rows = listNotes(w.db, sid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "Bring the speaker", "whitespace is collapsed, not preserved verbatim");
    assert.equal(rows[0].personId, w.people[1]);
    assert.ok(rows[0].authorName, "a note must carry who wrote it");
    assert.match(rows[0].at, /^\d{4}-\d{2}-\d{2}T/, "and when");

    const page = await (await w.get(`/session/${sid}`, me)).text();
    assert.match(page, /Bring the speaker/);
    assert.doesNotMatch(page, /notes\.[a-z]/i, "a raw string key reached the page");
  } finally { w.close(); }
});

test("an empty note and an over-long one are refused, and nothing is written", async () => {
  const w = await world();
  try {
    const me = await w.signIn(w.people[1]);
    const sid = aSession(w);
    const reason = async (body) => new URL((await w.post(`/session/${sid}/note`, me,
      new URLSearchParams({ csrf: csrfFromCookie(me), body }))).headers.get("location"), "http://x")
      .searchParams.get("r");

    assert.equal(await reason("   "), "empty_note");
    assert.equal(await reason("x".repeat(NOTE_MAX + 1)), "note_too_long");
    assert.equal(listNotes(w.db, sid).length, 0, "neither may write a row");

    // Exactly at the limit is allowed: an off-by-one here would reject the longest legitimate note.
    assert.equal(await reason("x".repeat(NOTE_MAX)), "note_added");
    assert.equal(listNotes(w.db, sid).length, 1);
  } finally { w.close(); }
});

test("a note on a session that does not exist is a 404, not a row", async () => {
  const w = await world();
  try {
    const me = await w.signIn(w.people[1]);
    assert.equal((await w.get("/session/999999", me)).status, 404);
    const res = await w.post("/session/999999/note", me,
      new URLSearchParams({ csrf: csrfFromCookie(me), body: "into the void" }));
    assert.equal(res.status, 404);
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notes").get().n, 0);
  } finally { w.close(); }
});

test("your own note you may delete; somebody else's you may not", async () => {
  const w = await world();
  try {
    const mine = await w.signIn(w.people[1]);
    const theirs = await w.signIn(w.people[2]);
    const sid = aSession(w);
    await w.post(`/session/${sid}/note`, mine, new URLSearchParams({ csrf: csrfFromCookie(mine), body: "mine" }));
    const noteId = listNotes(w.db, sid)[0].id;

    // The other volunteer, with a valid session and a valid CSRF token — the only thing stopping them is ownership.
    const refused = await w.post(`/note/${noteId}/delete`, theirs,
      new URLSearchParams({ csrf: csrfFromCookie(theirs) }));
    assert.equal(new URL(refused.headers.get("location"), "http://x").searchParams.get("r"), "not_your_note");
    assert.equal(listNotes(w.db, sid).length, 1, "and the note survives");

    const ok = await w.post(`/note/${noteId}/delete`, mine, new URLSearchParams({ csrf: csrfFromCookie(mine) }));
    assert.equal(new URL(ok.headers.get("location"), "http://x").searchParams.get("r"), "note_deleted");
    assert.equal(listNotes(w.db, sid).length, 0);
  } finally { w.close(); }
});

test("the delete button is offered only on your own notes", async () => {
  const w = await world();
  try {
    const mine = await w.signIn(w.people[1]);
    const theirs = await w.signIn(w.people[2]);
    const sid = aSession(w);
    await w.post(`/session/${sid}/note`, mine, new URLSearchParams({ csrf: csrfFromCookie(mine), body: "mine" }));

    assert.match(await (await w.get(`/session/${sid}`, mine)).text(), /action="\/note\/\d+\/delete"/,
      "the author must be offered the button");
    assert.doesNotMatch(await (await w.get(`/session/${sid}`, theirs)).text(), /action="\/note\/\d+\/delete"/,
      "and nobody else — a button that always 403s is worse than no button");
  } finally { w.close(); }
});

test("a signed-out visitor sees no notes and cannot write one", async () => {
  const w = await world();
  try {
    const nobody = { cookie: "" };
    const res = await w.get(`/session/${aSession(w)}`, nobody);
    // 303, which is what `gate` sends — the first version of this allowed 302 and 403 and failed on the correct
    // answer. Asserting the destination too, because a redirect to the wrong place would satisfy a status check.
    assert.equal(res.status, 303, `expected the sign-in redirect, got ${res.status}`);
    assert.match(res.headers.get("location") ?? "", /signin/, "and it must go to sign-in, not somewhere else");
  } finally { w.close(); }
});

// The GDPR half, and the asymmetry with the audit trail is the point: audit rows are RELABELLED and notes are
// DELETED, because a note is the person's own sentence and there is no version of it with the person taken out.
test("erasure deletes the person's own notes and leaves everybody else's", async () => {
  for (const mode of ["anonymise", "remove"]) {
    const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"] } });
    try {
      const sid = aSession(w);
      const doomed = w.people[1];
      addNote(w.db, sid, { personId: doomed, authorName: "Doomed", body: "my own words" });
      addNote(w.db, sid, { personId: w.people[2], authorName: "Other", body: "somebody else's words" });

      const r = erasePerson(w.db, doomed, { mode, today: w.today });
      assert.ok(r.ok, `erase ${mode} failed: ${r.reason}`);
      assert.equal(r.notesRemoved, 1, `${mode}: erasePerson must report how many notes it removed`);

      const left = listNotes(w.db, sid);
      assert.equal(left.length, 1, `${mode}: exactly the other volunteer's note remains`);
      assert.equal(left[0].body, "somebody else's words");
      assert.ok(!left.some((n) => n.body === "my own words"), `${mode}: the erased person's words are gone`);
    } finally { w.close(); }
  }
});

test("notes go with their season when retention prunes it", () => {
  // Built by hand rather than with makeWorld, because this needs TWO seasons and pruneSeasons refuses the current
  // one — which is the guard that makes the test worth writing rather than an obstacle to route around.
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const base = loadPattern();
  const old = seedSeason(db, { ...base, season: { key: "old", from: "2020-01-01", to: "2020-06-30" }, holidays: {} });
  const now = seedSeason(db, { ...base, season: { key: "now", from: "2026-01-01", to: "2026-06-30" }, holidays: {} });
  const pick = (seasonId) => db.prepare("SELECT id FROM sessions WHERE season_id=? LIMIT 1").get(seasonId).id;

  addNote(db, pick(old.seasonId), { personId: null, authorName: "A", body: "on the old season" });
  addNote(db, pick(now.seasonId), { personId: null, authorName: "A", body: "on the current season" });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notes").get().n, 2);

  pruneSeasons(db, { keep: 1, currentKey: "now" });
  const left = db.prepare("SELECT body FROM notes").all().map((r) => r.body);
  assert.deepEqual(left, ["on the current season"],
    "a pruned season must take its notes with it — free text nobody can erase field by field has to be bounded " +
    "by something, and CASCADE from sessions is that something");
  db.close();
});

// The page-size defect, third instalment. /planner rendered 534 KB and /admin 953 KB by putting a form on every
// row; the plan page renders a WHOLE SEASON, so the note count must not cost a query per session.
test("note counts on the whole-season plan cost one query, not one per session", async () => {
  const w = await world();
  try {
    const sessions = w.db.prepare("SELECT id FROM sessions WHERE season_id=?").all(w.seasonId).map((r) => r.id);
    assert.ok(sessions.length >= 20, `expected a season of sessions, saw ${sessions.length}`);
    for (const id of sessions.slice(0, 5)) addNote(w.db, id, { personId: null, authorName: "A", body: "hello" });

    const counter = countQueries(w.db);
    const counts = noteCounts(w.db, sessions);
    assert.equal(counter.n, 1, `${sessions.length} sessions must cost ONE query, not ${counter.n}`);
    assert.equal(counts.size, 5, "and it must return the counts it was asked for");
    assert.equal(counts.get(sessions[0]), 1);

    // The empty case must not query at all — an IN () clause is a syntax error waiting for the season with no
    // sessions in it, which is a state this app reaches on a fresh deployment.
    const c2 = countQueries(w.db);
    assert.equal(noteCounts(w.db, []).size, 0);
    assert.equal(c2.n, 0, "no sessions, no query");
  } finally { w.close(); }
});

test("deleteNotesBy leaves notes whose author is already gone", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const base = loadPattern();
  const { seasonId } = seedSeason(db, { ...base, season: { key: "s", from: "2026-01-01", to: "2026-06-30" }, holidays: {} });
  const sid = db.prepare("SELECT id FROM sessions WHERE season_id=? LIMIT 1").get(seasonId).id;
  const pid = db.prepare("INSERT INTO people (name, status) VALUES ('X','active') RETURNING id").get().id;

  addNote(db, sid, { personId: pid, authorName: "X", body: "theirs" });
  addNote(db, sid, { personId: null, authorName: "system", body: "nobody's" });
  assert.equal(deleteNotesBy(db, pid), 1, "exactly the one with an author");
  assert.deepEqual(listNotes(db, sid).map((n) => n.body), ["nobody's"],
    "a note with no person_id belongs to nobody and must not be swept by an erasure");
  db.close();
});
