// Increment L, plus the error pages from M. Both came out of opening the app in a browser rather than from
// reading the code: the availability screen measured 3,750 pixels with 153 radio buttons, and the 403 page
// was a dead end with no navigation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { bulkTargets, bulkScopes, datesNeedingAnswer } from "../src/pages/availability.mjs";
import { makeT, loadPattern } from "../src/config.mjs";

const withWorld = (opts, fn) => async () => {
  const w = await makeWorld(opts);
  try { await fn(w); } finally { w.close(); }
};

// ---- scope selection ----------------------------------------------------------------------------------
test("bulk scopes are derived from the data, not assumed", withWorld({}, async (w) => {
  const t = makeT("en");
  const rows = datesNeedingAnswer(w.db, w.seasonId, w.today);
  const scopes = bulkScopes(t, rows);

  const configured = new Set(w.pattern.weekly.map((x) => x.dayOfWeek));
  assert.equal(scopes.dows.length, configured.size, "only weekdays that actually have sessions may be offered");
  for (const d of scopes.dows) {
    assert.ok(configured.has(Number(d.scope.slice(4))), `offered a weekday with no sessions: ${d.scope}`);
    assert.ok(!d.label.includes("{"), `unfilled placeholder in "${d.label}"`);
  }
  assert.ok(scopes.months.length > 1, "a half-year season spans several months");
}));

test("each scope selects exactly the dates it claims to", withWorld({}, async (w) => {
  const rows = datesNeedingAnswer(w.db, w.seasonId, w.today);
  const all = bulkTargets(rows, { scope: "all", value: "1" });
  assert.equal(all.rows.length, rows.length);

  const dow = w.pattern.weekly[0].dayOfWeek;
  const picked = bulkTargets(rows, { scope: `dow:${dow}`, value: "1" });
  assert.ok(picked.rows.length > 0);
  for (const r of picked.rows) {
    assert.equal(new Date(`${r.date}T00:00:00Z`).getUTCDay(), dow, `${r.date} is not weekday ${dow}`);
  }
  assert.ok(picked.rows.length < rows.length, "a weekday scope must be narrower than everything");

  const month = rows[0].date.slice(0, 7);
  const byMonth = bulkTargets(rows, { scope: `month:${month}`, value: "1" });
  for (const r of byMonth.rows) assert.equal(r.date.slice(0, 7), month);

  // A scope nobody offered selects nothing rather than everything — the safe direction for a bulk write.
  assert.deepEqual(bulkTargets(rows, { scope: "nonsense", value: "1" }).rows, []);
  assert.deepEqual(bulkTargets(rows, { scope: "", value: "1" }).rows, []);
}));

// ---- through HTTP -------------------------------------------------------------------------------------
test("one press answers every date, and the page says how many", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/availability", cookie);
  const expected = datesNeedingAnswer(w.db, w.seasonId, w.today).length;

  const r = await w.post("/availability/bulk", cookie, new URLSearchParams({ csrf: token, scope: "all", value: "1" }));
  assert.equal(r.status, 303);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(w.people[0]).n, expected);

  const { body } = await w.follow(r, cookie);
  assert.match(body, new RegExp(`${expected} dates updated|${expected} datoer opdateret`), "a silent bulk write is alarming");
}));

test("a weekday scope answers only that weekday", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/availability", cookie);
  const dow = w.pattern.weekly[0].dayOfWeek;

  await w.post("/availability/bulk", cookie, new URLSearchParams({ csrf: token, scope: `dow:${dow}`, value: "1" }));
  const written = w.db.prepare("SELECT date FROM availability_hour WHERE person_id=?").all(w.people[0]);
  assert.ok(written.length > 0);
  for (const row of written) assert.equal(new Date(`${row.date}T00:00:00Z`).getUTCDay(), dow);
}));

test("bulk-clearing removes rows rather than writing zeroes", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/availability", cookie);
  await w.post("/availability/bulk", cookie, new URLSearchParams({ csrf: token, scope: "all", value: "1" }));
  assert.ok(w.db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(w.people[0]).n > 0);

  await w.post("/availability/bulk", cookie, new URLSearchParams({ csrf: token, scope: "all", value: "" }));
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(w.people[0]).n, 0,
    "clearing in bulk must leave no rows — silence is still not a 'no'");
}));

test("bulk then individual correction: the later answer wins", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[0]);
  const { token, body } = await w.csrfFrom("/availability", cookie);
  await w.post("/availability/bulk", cookie, new URLSearchParams({ csrf: token, scope: "all", value: "1" }));

  const first = body.match(/name="slot:(\d{4}-\d{2}-\d{2}):(\d+)"/);
  const key = `slot:${first[1]}:${first[2]}`;
  await w.post("/availability", cookie, new URLSearchParams({ csrf: token, [key]: "0" }));
  assert.equal(w.db.prepare("SELECT available FROM availability_hour WHERE person_id=? AND date=?").get(w.people[0], first[1]).available, 0,
    "the point of bulk is a starting position you then correct");
}));

test("bulk needs CSRF and a session, and writes for the session's person only", withWorld({}, async (w) => {
  assert.equal((await w.post("/availability/bulk", null, new URLSearchParams({ scope: "all", value: "1" }))).status, 303,
    "no session redirects to sign-in");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM availability_hour").get().n, 0);

  const cookie = await w.signIn(w.people[1]);
  assert.equal((await w.post("/availability/bulk", cookie, new URLSearchParams({ scope: "all", value: "1" }))).status, 403);

  const form = new URLSearchParams({ csrf: csrfFromCookie(cookie), scope: "all", value: "1" });
  form.set("personId", String(w.people[0]));
  await w.post("/availability/bulk", cookie, form);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(w.people[0]).n, 0);
  assert.ok(w.db.prepare("SELECT COUNT(*) n FROM availability_hour WHERE person_id=?").get(w.people[1]).n > 0);
}));

// ---- the privacy notice -------------------------------------------------------------------------------
test("volunteers are told what is stored, on the screen where they first enter it", withWorld({}, async (w) => {
  const cookie = await w.signIn(w.people[0]);
  const body = await (await w.get("/availability", cookie)).text();
  assert.match(body, /href="\/privacy"/, "gap 5 of docs/PRIVACY.md was that nobody was told at all");

  const privacy = await w.get("/privacy", cookie);
  assert.equal(privacy.status, 200);
  const text = await privacy.text();
  for (const re of [/name/i, /schedule|lægge planen/i, /no tracking|ingen sporing/i, /delete|slettet/i]) {
    assert.match(text, re, `the notice should cover ${re}`);
  }
  assert.equal((await w.get("/privacy")).status, 200, "and be readable before signing in");
}));

// ---- error pages ---------------------------------------------------------------------------------------
test("404 and 405 are real pages with a stylesheet and a way out", withWorld({}, async (w) => {
  for (const [path, status] of [["/no-such-page", 404], ["/availability/bulk", 405]]) {
    const r = await w.get(path);
    assert.equal(r.status, status, path);
    const body = await r.text();
    assert.match(body, /<link rel="stylesheet"/, `${path} rendered without the stylesheet`);
    assert.match(body, /href="\/(signin|)"/, `${path} left the user with no way out`);
    assert.ok(!/^<h1>\d+<\/h1>$/.test(body.trim()), `${path} is still a bare heading`);
  }
}));

test("a 403 explains itself and links home, and a stale form says so specifically", withWorld({ volunteers: 2 }, async (w) => {
  const volunteer = await w.signIn(w.people[1]);
  const forbidden = await w.get("/admin", volunteer);
  assert.equal(forbidden.status, 403);
  const body = await forbidden.text();
  assert.match(body, /do not have access|har ikke adgang/);
  assert.match(body, /href="\/"/, "a 403 with no navigation is a dead end");

  // A stale CSRF token is almost always a form left open, not an intruder — the message must differ.
  const stale = await w.post("/availability", volunteer, new URLSearchParams({ csrf: "wrong" }));
  assert.equal(stale.status, 403);
  const staleBody = await stale.text();
  assert.match(staleBody, /too old|for gammel/, "telling this person 'no access' sends them to find an admin");
}));

test("an administrator can reach the planner screen", withWorld({ volunteers: 2, roles: { 0: ["admin"] } }, async (w) => {
  // Found by browsing as an admin and getting a 403. The restriction protected nothing — an admin can grant
  // themselves the role in two clicks — and produced a dead end for the person most likely to fix a gap.
  const admin = await w.signIn(w.people[0]);
  assert.equal((await w.get("/planner", admin)).status, 200);
  assert.equal((await w.get("/admin", admin)).status, 200);
  assert.match(await (await w.get("/", admin)).text(), /href="\/planner"/, "and it must be in the navigation");

  // Not symmetric: a planner is still not an administrator.
  const w2 = await makeWorld({ volunteers: 2, roles: { 0: ["planner"] } });
  try {
    const planner = await w2.signIn(w2.people[0]);
    assert.equal((await w2.get("/planner", planner)).status, 200);
    assert.equal((await w2.get("/admin", planner)).status, 403, "planners must not gain admin powers");
  } finally { w2.close(); }
}));

// ---- accessibility of the availability radios -----------------------------------------------------------
test("every availability radio announces the answer AND the date it belongs to", withWorld({}, async (w) => {
  // The visible label is a glyph, and a glyph is the accessible name when a label has text content — `title`
  // is only a fallback for elements with no name at all. Before this, a screen reader read "✓ radio button"
  // 153 times with no way to tell which date was being answered.
  const cookie = await w.signIn(w.people[0]);
  const body = await (await w.get("/availability", cookie)).text();

  const radios = [...body.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
  assert.ok(radios.length > 30, `expected many radios, found ${radios.length}`);
  for (const r of radios) {
    assert.match(r, /aria-label="/, `a radio with no accessible name: ${r}`);
    const label = r.match(/aria-label="([^"]+)"/)[1];
    // The answer word, then the date — so the announcement is unambiguous on its own.
    assert.match(label, /(Kan|Kan ikke|Ikke svaret|Available|Unavailable|No answer yet)/, `no answer word: ${label}`);
    assert.match(label, /\d+\/\d+/, `no date in the accessible name: ${label}`);
  }
  // The glyph must not be read a second time on top of the aria-label.
  const glyphLabels = [...body.matchAll(/<label for="slot:[^"]+"[^>]*>(.*?)<\/label>/g)].map((m) => m[1]);
  assert.ok(glyphLabels.length > 30);
  for (const g of glyphLabels) assert.match(g, /aria-hidden="true"/, `glyph not hidden from the reader: ${g}`);
}));

// ---- the past is not answerable ---------------------------------------------------------------------------------
//
// MEASURED IN A BROWSER at 375px on the demo: this form offered 46 dates of which TWELVE were in the past — a quarter
// of a 6,528-pixel form spent on questions with no answer worth giving. The earliest field was 2026-06-28 with today at
// 2026-08-06. Availability for a session that already happened changes nothing: the roster is done, and the retention
// sweep deletes the row once its date has no sessions.
//
// Both halves are asserted, because the form and the write path share one allow-list and a cutoff on one alone would
// let a stale POST write what the screen has stopped offering.
test("neither the form nor the write path offers a date that has already passed", async () => {
  const w = await makeWorld({ volunteers: 2 });
  try {
    // Move two dates behind today, which is the realistic state of a season in progress.
    const early = w.db.prepare("SELECT DISTINCT date FROM sessions ORDER BY date LIMIT 2").all().map((r) => r.date);
    w.db.prepare(`UPDATE sessions SET date = date(date, '-60 days') WHERE date IN ('${early.join("','")}')`).run();
    const past = w.db.prepare("SELECT DISTINCT date FROM sessions WHERE date < ? ORDER BY date").all(w.today)
      .map((r) => r.date);
    assert.equal(past.length, 2, "the fixture must have a past, or this test cannot fail");

    const offered = datesNeedingAnswer(w.db, w.seasonId, w.today).map((r) => r.date);
    assert.ok(offered.length > 0, "and a future, or it proves nothing either");
    assert.deepEqual(offered.filter((d) => d < w.today), [],
      `the form still offers ${offered.filter((d) => d < w.today).join(", ")}`);

    // The write path: a hand-made POST naming a past date must be ignored, while the same shape on a live date works.
    const cookie = await w.signIn(w.people[0]);
    const live = offered[0];
    const hour = w.db.prepare("SELECT t.hour FROM sessions s JOIN timeslots t ON t.id=s.timeslot_id WHERE s.date=? LIMIT 1")
      .get(past[0]).hour;
    const liveHour = w.db.prepare("SELECT t.hour FROM sessions s JOIN timeslots t ON t.id=s.timeslot_id WHERE s.date=? LIMIT 1")
      .get(live).hour;
    await w.post("/availability", cookie, new URLSearchParams({
      csrf: csrfFromCookie(cookie), [`slot:${past[0]}:${hour}`]: "1", [`slot:${live}:${liveHour}`]: "1",
    }));
    const rows = w.db.prepare("SELECT date FROM availability_hour WHERE person_id=?").all(w.people[0]).map((r) => r.date);
    assert.ok(rows.includes(live), "the live date must have been written — otherwise this test passes on a broken POST");
    assert.ok(!rows.includes(past[0]), `a past date was written anyway: ${rows.join(", ")}`);
  } finally { w.close(); }
});
