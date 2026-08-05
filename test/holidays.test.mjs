// Public holidays: the dates, the suppression, and the planner's way back in.
//
// The dates are the part that cannot be tested against the code, because the code IS the claim. So they are held
// against published calendars, written out here as literals: Easter for five years, and every Danish holiday in
// 2026 by name. If the computus is wrong, these fail; if these are wrong, a Dane reading the Administration screen
// finds out, which is a worse way to learn it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { easterSunday, COUNTRIES, holidayConfig, holidaysBetween, suppressed } from "../src/holidays.mjs";
import { seedSeason } from "../src/seed.mjs";
import { loadPattern } from "../src/config.mjs";
import { setClassesAnyway, sessionsOnDate } from "../src/admin.mjs";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";

test("Easter is computed, and matches the published dates", () => {
  // Gregorian Easter Sunday, from published ecclesiastical calendars.
  assert.deepEqual(
    [2023, 2024, 2025, 2026, 2027].map(easterSunday),
    ["2023-04-09", "2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28"]);
});

test("the Danish table is the actual list of Danish public holidays for 2026", () => {
  const got = COUNTRIES.DK(2026).map(([date, key]) => `${date} ${key}`).sort();
  assert.deepEqual(got, [
    "2026-01-01 newYear",
    "2026-04-02 maundyThursday",     // skærtorsdag
    "2026-04-03 goodFriday",         // langfredag
    "2026-04-05 easterSunday",       // påskedag
    "2026-04-06 easterMonday",       // 2. påskedag
    "2026-05-14 ascension",          // Kristi himmelfartsdag
    "2026-05-24 whitSunday",         // pinsedag
    "2026-05-25 whitMonday",         // 2. pinsedag
    "2026-12-25 christmas1",
    "2026-12-26 christmas2",
  ].sort());
});

// The table takes a year for exactly one reason, and it is a real one.
test("Store bededag is in the table until it was abolished, and not after", () => {
  const on = (year) => COUNTRIES.DK(year).find(([, k]) => k === "prayerDay")?.[0] ?? null;
  // 26 days after Easter Sunday. Written as an offset rather than as a weekday name, because the seams gate
  // forbids weekday names in string literals under src/ and test/ — and it caught this line.
  assert.equal(on(2023), "2023-05-05", "26 days after Easter 2023");
  assert.equal(on(2024), null, "abolished as a public holiday from 2024 — a table without a year would be wrong");
  assert.equal(on(2026), null);
});

test("an unrecognised country suppresses nothing rather than guessing", () => {
  const cfg = holidayConfig({ holidays: { country: "ZZ" } });
  assert.equal(cfg.country, null, "no guess");
  assert.equal(cfg.unknownCountry, "ZZ", "but it must be reportable, or the config silently does nothing");
  assert.equal(suppressed("2026-12-25", cfg), null, "Christmas Day is not suppressed for a country we cannot name");

  // And the shape a missing section produces, since most of this app's config sections are optional.
  const none = holidayConfig({});
  assert.deepEqual([none.country, none.extra, none.classesAnyway], [null, [], []]);
});

test("garbage in the config lists is dropped rather than trusted", () => {
  const cfg = holidayConfig({ holidays: { country: "dk", extra: ["2026-12-24", "sometime soon", 42, null],
                                          classesAnyway: ["2026-04-06", "26/12/2026"] } });
  assert.equal(cfg.country, "DK", "a lower-case country code is the same country");
  assert.deepEqual(cfg.extra, ["2026-12-24"]);
  assert.deepEqual(cfg.classesAnyway, ["2026-04-06"]);
});

test("holidaysBetween covers the range, labels the extras, and marks the opted-in dates", () => {
  const cfg = holidayConfig({ holidays: { country: "DK", extra: ["2026-12-24"], classesAnyway: ["2026-04-06"] } });
  const list = holidaysBetween("2026-04-01", "2026-12-31", cfg);
  const byDate = new Map(list.map((h) => [h.date, h]));

  assert.ok(!byDate.has("2026-01-01"), "outside the range");
  assert.equal(byDate.get("2026-04-06")?.key, "easterMonday");
  assert.equal(byDate.get("2026-04-06")?.classesAnyway, true, "the planner said classes run that day");
  assert.equal(byDate.get("2026-12-24")?.key, "extra", "a board's own closing day is labelled as one");
  assert.equal(byDate.get("2026-12-25")?.classesAnyway, false);
  assert.deepEqual([...byDate.keys()], [...byDate.keys()].sort(), "oldest first, so the screen reads as a calendar");

  // An `extra` that collides with a real holiday must not relabel it: the official name is more informative, and
  // "a day 4water is closed" over Christmas Day would read as though somebody had configured it by hand.
  const collide = holidaysBetween("2026-12-01", "2026-12-31",
    holidayConfig({ holidays: { country: "DK", extra: ["2026-12-25"] } }));
  assert.equal(collide.find((h) => h.date === "2026-12-25").key, "christmas1");
  assert.equal(collide.filter((h) => h.date === "2026-12-25").length, 1, "and it must appear once, not twice");
});

// The behaviour 4water asked for, at the level that matters: no sessions on the day.
const seasonPattern = (holidays) => {
  const base = loadPattern();
  return {
    ...base,
    season: { key: "test-easter", from: "2026-04-01", to: "2026-04-30" },
    holidays,
  };
};

const seeded = (pattern) => {
  const db = new DatabaseSync(":memory:");
  const r = seedSeason(db, pattern);
  const dates = db.prepare("SELECT DISTINCT date FROM sessions WHERE season_id=? ORDER BY date")
    .all(r.seasonId).map((x) => x.date);
  db.close();
  return { ...r, dates };
};

test("seeding creates nothing on a public holiday, and says how many days it skipped", () => {
  const withHolidays = seeded(seasonPattern({ country: "DK" }));
  for (const d of ["2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06"]) {
    assert.ok(!withHolidays.dates.includes(d), `${d} is a Danish public holiday and got sessions anyway`);
  }
  assert.ok(withHolidays.skipped >= 4, `four holidays fall in April 2026; skipped=${withHolidays.skipped}`);

  // THE CONTROL, and without it this test proves nothing: the same season with no country configured must create
  // sessions on those dates. Otherwise "no sessions on Easter Monday" could just as well mean the weekly rhythm
  // has no Monday in it, and the assertion above would pass over a feature that does nothing.
  const without = seeded(seasonPattern({}));
  const created = ["2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06"].filter((d) => without.dates.includes(d));
  assert.ok(created.length > 0,
    "with no country configured the same season must produce sessions on at least one of those dates — if not, " +
    "this fixture cannot tell suppression from an empty weekly pattern");
  assert.equal(without.skipped, 0, "and nothing is skipped when nothing is configured");
  assert.ok(without.dates.length > withHolidays.dates.length, "suppression must remove dates, not reorder them");
});

test("a date the planner opted into is seeded like any other", () => {
  // The date is derived from the rhythm for the same reason as the HTTP tests below: a holiday on a weekday nobody
  // teaches would make "and created once the planner says so" unfalsifiable.
  const april = seasonPattern({ country: "DK" });
  const date = holidayOnATeachingDay(april);
  const anyway = seeded(seasonPattern({ country: "DK", classesAnyway: [date] }));
  const plain = seeded(april);

  assert.ok(!plain.dates.includes(date), "suppressed by default");
  assert.ok(anyway.dates.includes(date), "and created once the planner says classes run anyway");
  assert.equal(anyway.skipped, plain.skipped - 1, "exactly one fewer day skipped");
});

test("setClassesAnyway is idempotent in both directions and reports whether it changed anything", () => {
  const base = { holidays: { country: "DK", classesAnyway: [] } };
  const on = setClassesAnyway(base, "2026-04-06", true);
  assert.deepEqual(on.pattern.holidays.classesAnyway, ["2026-04-06"]);
  assert.equal(on.changed, true);

  const again = setClassesAnyway(on.pattern, "2026-04-06", true);
  assert.deepEqual(again.pattern.holidays.classesAnyway, ["2026-04-06"], "no duplicate");
  assert.equal(again.changed, false, "and it must SAY nothing changed, or a double click reports success twice");

  const off = setClassesAnyway(on.pattern, "2026-04-06", false);
  assert.deepEqual(off.pattern.holidays.classesAnyway, []);
  assert.equal(off.changed, true);
  assert.equal(setClassesAnyway(off.pattern, "2026-04-06", false).changed, false);

  // The config may not have a holidays section at all yet.
  const fresh = setClassesAnyway({ season: { key: "x" } }, "2026-12-25", true);
  assert.deepEqual(fresh.pattern.holidays.classesAnyway, ["2026-12-25"]);
  assert.equal(fresh.pattern.season.key, "x", "and the rest of the config must survive");
});

// Over HTTP, because the guard that matters lives in the route: turning a holiday back off DELETES sessions.
const withAdmin = (fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"] } });
  try { await fn({ ...w, admin: await w.signIn(w.people[0]) }); } finally { w.close(); }
};

// A holiday in the season that the weekly rhythm ACTUALLY COVERS, derived from the configured pattern rather than
// picked by hand.
//
// This exists because the hand-picked date was 2026-04-06, whose weekday is not in 4water's rhythm — so opting it
// in created no sessions, the "refuses when somebody is on that date" test hit its own `if (slots === 0) return`
// and asserted NOTHING. It passed, and it went on passing with the guard deleted. Found by the mutation probe,
// which is the only reason it is not still there: a test that skips itself reads exactly like a test that ran.
//
// Fails loudly when no such date exists, rather than skipping. If 4water's rhythm ever misses every holiday in the
// season, that is worth being told about, not routing around.
const holidayOnATeachingDay = (pattern) => {
  const cfg = holidayConfig({ holidays: { country: "DK" } });
  const days = new Set(pattern.weekly.map((w) => w.dayOfWeek));
  const found = holidaysBetween(pattern.season.from, pattern.season.to, cfg)
    .find((h) => days.has(new Date(Date.parse(`${h.date}T00:00:00Z`)).getUTCDay()));
  assert.ok(found, `no public holiday in ${pattern.season.from}..${pattern.season.to} falls on a day the weekly ` +
    `rhythm covers — these tests would be vacuous, which is how they were broken before`);
  return found.date;
};

test("the Administration screen lists the season's holidays and offers one button each", withAdmin(async (w) => {
  const body = await (await w.get("/admin", w.admin)).text();
  assert.match(body, /Public holidays/, "a section nobody can see is a config file with extra steps");
  assert.match(body, /action="\/admin\/holiday"/, "and it must offer the toggle");
  assert.doesNotMatch(body, /holiday\.[a-z]/i, "a raw string key reached the page");
}));

test("a holiday can be opted into and back out of, and both are audited", withAdmin(async (w) => {
  const post = (body) => w.post("/admin/holiday", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), ...body }));
  const reason = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

  const date = holidayOnATeachingDay(w.pattern);
  assert.equal(reason(await post({ date, on: "1" })), "holiday_on");
  assert.deepEqual(JSON.parse((await import("node:fs")).readFileSync(w.patternFile, "utf8"))
    .holidays.classesAnyway, [date], "the decision is recorded in the config, so a reseed keeps it");

  assert.equal(reason(await post({ date, on: "1" })), "holiday_unchanged", "a second click says so");
  assert.equal(reason(await post({ date, on: "0" })), "holiday_off");
  assert.equal(reason(await post({ date: "not-a-date", on: "1" })), "holiday_bad_date");

  const actions = (await import("../src/audit.mjs")).listAudit(w.db).filter((r) => r.action === "admin.holiday");
  assert.ok(actions.length >= 2, `both directions must be logged, saw ${actions.length}`);
  assert.ok(actions.some((r) => /classes run on/.test(r.detail ?? "")), "the detail should say which way");
  assert.equal(actions[0].actorId, w.people[0], "and who did it");
}));

test("clearing a holiday refuses when somebody is on that date", withAdmin(async (w) => {
  const post = (body) => w.post("/admin/holiday", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), ...body }));
  const reason = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");
  const date = holidayOnATeachingDay(w.pattern);

  assert.equal(reason(await post({ date, on: "1" })), "holiday_on");
  const before = sessionsOnDate(w.db, w.seasonId, date);
  assert.ok(before.slots > 0,
    `opting ${date} in must create slots, or the guard below is never reached — the previous version of this test ` +
    `returned early here and passed with the guard deleted`);

  // Somebody agrees to teach it. `UPDATE ... LIMIT` is not available in SQLite without a build-time option, so
  // the single row is chosen by subselect — and the version that used LIMIT was never executed at all, because
  // the early return this test used to take stopped before it. One skip hid two defects.
  w.db.prepare(`UPDATE assignments SET person_id=?, state='confirmed' WHERE id = (
                  SELECT a.id FROM assignments a JOIN sessions s ON s.id = a.session_id
                   WHERE s.season_id=? AND s.date=? ORDER BY a.id LIMIT 1)`)
    .run(w.people[1], w.seasonId, date);

  assert.equal(reason(await post({ date, on: "0" })), "holiday_taken",
    "removing the date would cancel on a volunteer who said yes — that has to be refused, not reported as done");
  assert.equal(sessionsOnDate(w.db, w.seasonId, date).sessions, before.sessions, "and nothing was deleted");

  // Free it, and then it goes. `state` stays 'confirmed' — there is no 'open' state and the CHECK constraint says
  // so; an empty slot is `person_id IS NULL`, which is the distinction the whole board is built on.
  w.db.prepare(`UPDATE assignments SET person_id=NULL
                 WHERE session_id IN (SELECT id FROM sessions WHERE season_id=? AND date=?)`)
    .run(w.seasonId, date);
  assert.equal(reason(await post({ date, on: "0" })), "holiday_off");
  assert.equal(sessionsOnDate(w.db, w.seasonId, date).sessions, 0, "now the sessions are gone");
}));

// The retrofit case, which is how a real deployment meets this feature: the season was seeded before anybody
// configured a country, so dates that are now holidays still have sessions on them. The config says suppressed and
// the plan says otherwise — and only the plan is what volunteers see.
test("a holiday that still has sessions from before it was configured says so, and can be cleared",
     withAdmin(async (w) => {
  const date = holidayOnATeachingDay(w.pattern);
  assert.equal(sessionsOnDate(w.db, w.seasonId, date).sessions, 0,
    "the world seeds with the repository's config, which now HAS a country — so the date starts suppressed");

  // Now reproduce the history rather than describing it: seed the same season as it was before anybody configured
  // a country. Seeding is INSERT OR IGNORE, so this adds exactly the dates suppression is now removing.
  seedSeason(w.db, { ...w.pattern, holidays: {} });
  const existing = sessionsOnDate(w.db, w.seasonId, date);
  assert.ok(existing.sessions > 0,
    `seeding without a country must create ${date}; without that this test asserts nothing about the retrofit`);

  // Scoped to THIS date's card. The first version asserted over the whole page and failed on the other holidays,
  // which say "No sessions on this date" and are right to: they were suppressed before anything was seeded.
  const body = await (await w.get("/admin", w.admin)).text();
  const card = body.split('<div class="card">').find((chunk) => chunk.includes(`value="${date}"`));
  assert.ok(card, `no card on the Administration screen offers a toggle for ${date}`);
  assert.doesNotMatch(card, /No sessions on this date/,
    "this card must not claim the date is empty while the plan still has sessions on it");
  assert.match(card, /slots still exist on this date/, "it has to say what is actually there");
  assert.match(card, /No classes after all/, "and offer the button that fixes it, not the one the config implies");

  // And the button offered must be the one that fixes it, not "classes run anyway" — which would be a no-op
  // dressed as an action.
  const res = await w.post("/admin/holiday", w.admin,
    new URLSearchParams({ csrf: csrfFromCookie(w.admin), date, on: "0" }));
  assert.equal(new URL(res.headers.get("location"), "http://x").searchParams.get("r"), "holiday_off",
    "clearing must report that it did something even though the config list did not change");
  assert.equal(sessionsOnDate(w.db, w.seasonId, date).sessions, 0);
}));

test("a volunteer cannot change which days are holidays", withAdmin(async (w) => {
  const volunteer = await w.signIn(w.people[2]);
  const res = await w.post("/admin/holiday", volunteer,
    new URLSearchParams({ csrf: csrfFromCookie(volunteer), date: "2026-04-06", on: "1" }));
  assert.equal(res.status, 403);
}));
