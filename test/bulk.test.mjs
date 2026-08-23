// Increment L, plus the error pages from M. Both came out of opening the app in a browser rather than from
// reading the code: the availability screen measured 3,750 pixels with 153 radio buttons, and the 403 page
// was a dead end with no navigation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { bulkTargets, bulkScopes, datesNeedingAnswer, groupByDate, saveAvailability, currentAnswers, shown } from "../src/pages/availability.mjs";
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

// ---- a date with several times is asked once, and answered once ---------------------------------------
//
// The configured rhythm now gives one weekday four one-hour slots and another two, so almost every date appeared
// more than once and printed its own date again on each row. Which weekday is configuration, not a fact about
// this test — the seams gate forbids naming it here. The fix groups by date: one whole-day answer, with
// the individual times behind a disclosure for anyone who needs to be finer than that.
//
// The whole-day control is the FIRST thing in this app to write availability_day. The column, the setter and the
// COALESCE in queries.mjs have all existed since the schema was written — only demo.mjs and measure.mjs wrote to
// it — so this is a feature landing on a seam that was already built for it.
test("a date with several times is grouped, and one with a single time is not", withWorld({}, async (w) => {
  const rows = datesNeedingAnswer(w.db, w.seasonId, w.today);
  const groups = groupByDate(rows);

  assert.equal(groups.reduce((n, g) => n + g.hours.length, 0), rows.length,
    "grouping must not lose or invent a slot");
  assert.equal(new Set(groups.map((g) => g.date)).size, groups.length, "one group per date");
  assert.deepEqual(groups.map((g) => g.date), [...new Set(rows.map((r) => r.date))],
    "and the dates must stay in the order the query returned them");

  // The fixture has to contain a multi-hour date or the grouping is untested. ASSERTED, not skipped — the same
  // rule the CSV test beside this one states at length.
  const multi = groups.find((g) => g.hours.length > 1);
  assert.ok(multi, "the configured pattern must give some date more than one time, or this proves nothing");
  assert.ok(groups.length < rows.length, "grouping must actually shorten the list");
}));

test("a whole-day answer is stored at day level, not smeared across the hours", withWorld({}, async (w) => {
  const rows = datesNeedingAnswer(w.db, w.seasonId, w.today);
  const multi = groupByDate(rows).find((g) => g.hours.length > 1);
  const me = w.people[0];

  saveAvailability(w.db, me, { [`day:${multi.date}`]: "1" }, w.seasonId, w.today);
  assert.equal(w.db.prepare("SELECT available FROM availability_day WHERE person_id=? AND date=?").get(me, multi.date)?.available, 1);
  assert.equal(w.db.prepare("SELECT COUNT(*) c FROM availability_hour WHERE person_id=? AND date=?").get(me, multi.date).c, 0,
    "one answer for the day must be ONE row, not one per hour");

  // And it is the effective answer for every hour of that date, through the same COALESCE a planner reads.
  const answers = currentAnswers(w.db, me);
  for (const h of multi.hours) {
    assert.equal(shown(answers, multi.date, h.hour), "1", `hour ${h.hour} must inherit the day answer`);
  }
}));

// THE ORDERING, which is the part that can silently lose an answer.
//
// One submit carries both levels: "free all that day except one time" arrives as day=1 with that hour's 0. A
// day write clears the date's hour rows so the whole-day answer can actually take effect against stale rows from
// an earlier save — run in the other order, that clear deletes the very answer the same request is setting.
test("free all day EXCEPT one time survives a single save", withWorld({}, async (w) => {
  const rows = datesNeedingAnswer(w.db, w.seasonId, w.today);
  const multi = groupByDate(rows).find((g) => g.hours.length > 1);
  const me = w.people[0];
  const odd = multi.hours[1].hour;

  saveAvailability(w.db, me, { [`day:${multi.date}`]: "1", [`slot:${multi.date}:${odd}`]: "0" }, w.seasonId, w.today);

  const answers = currentAnswers(w.db, me);
  assert.equal(shown(answers, multi.date, odd), "0", "the exception must survive the day write in the same submit");
  for (const h of multi.hours) {
    if (h.hour === odd) continue;
    assert.equal(shown(answers, multi.date, h.hour), "1", `hour ${h.hour} must still inherit the day answer`);
  }
}));

test("a stale hour answer stops overriding once the day is answered", withWorld({}, async (w) => {
  const rows = datesNeedingAnswer(w.db, w.seasonId, w.today);
  const multi = groupByDate(rows).find((g) => g.hours.length > 1);
  const me = w.people[0];
  const h0 = multi.hours[0].hour;

  saveAvailability(w.db, me, { [`slot:${multi.date}:${h0}`]: "0" }, w.seasonId, w.today);
  assert.equal(shown(currentAnswers(w.db, me), multi.date, h0), "0", "control: the hour answer is stored first");

  // Now answer the whole day yes, sending ONLY the day field.
  //
  // That shape matters, and the first version of this test used the browser's shape instead — day plus a blank
  // radio for every hour — which passes whether or not a day write clears anything, because the blanks clear the
  // rows by themselves. Removing the clear from saveAvailability left all three of these tests green, so the
  // check was decorative. This asserts the INVARIANT ("a day answer replaces everything finer for that date")
  // at the only level where it is observable: a caller that sends a day answer and no hour fields, which is what
  // anything other than this one form would send.
  saveAvailability(w.db, me, { [`day:${multi.date}`]: "1" }, w.seasonId, w.today);
  assert.equal(w.db.prepare("SELECT COUNT(*) c FROM availability_hour WHERE person_id=? AND date=?").get(me, multi.date).c, 0,
    "a day answer must clear that date's hour rows rather than leaving them to override it");
  assert.equal(shown(currentAnswers(w.db, me), multi.date, h0), "1",
    "the day answer must win, or the volunteer sees 'available all day' beside an hour that still says no");

  // And the browser's own shape reaches the same place by a different route, so both callers agree.
  saveAvailability(w.db, me, { [`slot:${multi.date}:${h0}`]: "0" }, w.seasonId, w.today);
  const blanks = Object.fromEntries(multi.hours.map((h) => [`slot:${multi.date}:${h.hour}`, ""]));
  saveAvailability(w.db, me, { [`day:${multi.date}`]: "0", ...blanks }, w.seasonId, w.today);
  assert.equal(shown(currentAnswers(w.db, me), multi.date, h0), "0");
}));

test("a fabricated day answer for an unoffered date is ignored", withWorld({}, async (w) => {
  const me = w.people[0];
  saveAvailability(w.db, me, { "day:1999-01-01": "1" }, w.seasonId, w.today);
  assert.equal(w.db.prepare("SELECT COUNT(*) c FROM availability_day WHERE person_id=?").get(me).c, 0,
    "the day allow-list comes from the same rows as the hour one, and must refuse a date the form never offered");

  // CONTROL: the same call shape DOES write for a date that is offered, so the assertion above is not passing
  // because saveAvailability quietly ignores every `day:` field.
  const real = datesNeedingAnswer(w.db, w.seasonId, w.today)[0].date;
  saveAvailability(w.db, me, { [`day:${real}`]: "1" }, w.seasonId, w.today);
  assert.equal(w.db.prepare("SELECT COUNT(*) c FROM availability_day WHERE person_id=?").get(me).c, 1);
}));
