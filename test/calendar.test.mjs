// Increment W. A subscribable feed of a volunteer's own shifts.
//
// The interesting failures here are not iCalendar syntax — a client either parses the file or it does not, and
// that is easy to see. They are the quiet ones: an event an hour out for half the season, a name mangled at a
// fold boundary, a token that keeps working after someone revoked it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { migrate } from "../src/db.mjs";
import { makeT, validatePattern, loadPattern, calendarConfig } from "../src/config.mjs";
import { seedStructure, seedPeople } from "../src/seed.mjs";
import { buildIcs, escapeText, foldLine, icsStamp, tzOffsetMs, utcInstantFor,
         calendarTokenFor, revokeCalendarToken, hasCalendarToken, personByCalendarToken,
         hashCalendarToken } from "../src/calendar.mjs";

const t = makeT("en");
const CPH = "Europe/Copenhagen";

// ---- time, which is the part that can be wrong without looking wrong -----------------------------------
test("a wall-clock time resolves to the right UTC instant on both sides of a DST change", () => {
  // Copenhagen is UTC+1 in winter and UTC+2 in summer. A hardcoded offset — the obvious shortcut — is wrong
  // for roughly half of any season that crosses a change, and every event would simply be an hour off.
  const winter = utcInstantFor("2026-01-14", 19, 0, CPH);
  assert.equal(new Date(winter).toISOString(), "2026-01-14T18:00:00.000Z", "19:00 CET is 18:00Z");

  const summer = utcInstantFor("2026-07-15", 19, 0, CPH);
  assert.equal(new Date(summer).toISOString(), "2026-07-15T17:00:00.000Z", "19:00 CEST is 17:00Z");

  // The change itself: EU summer time starts on the last Sunday of March. The day before and the day after
  // must differ by an hour for the same wall-clock reading.
  const before = utcInstantFor("2026-03-28", 19, 0, CPH);
  const after = utcInstantFor("2026-03-29", 19, 0, CPH);
  assert.equal((after - before) / 3600000, 23, "the same clock time is 23 hours later across the spring change");

  const octBefore = utcInstantFor("2026-10-24", 19, 0, CPH);
  const octAfter = utcInstantFor("2026-10-25", 19, 0, CPH);
  assert.equal((octAfter - octBefore) / 3600000, 25, "and 25 hours across the autumn change");
});

test("UTC is a fixed point, and an unset time zone falls back to it visibly", () => {
  assert.equal(new Date(utcInstantFor("2026-07-15", 19, 0, "UTC")).toISOString(), "2026-07-15T19:00:00.000Z");
  assert.equal(tzOffsetMs(Date.parse("2026-07-15T12:00:00Z"), "UTC"), 0);

  // The fallback is UTC on purpose: wrong for every department, so a missing calendar.timezone shows up as a
  // visible offset rather than as plausible-looking times that are quietly an hour or two out.
  const none = calendarConfig({});
  assert.equal(none.timezone, "UTC");
  assert.equal(none.configured, false, "and the page can say so");
  assert.equal(calendarConfig(loadPattern()).configured, true, "the shipped config sets one");
});

test("a time zone the system does not know is refused at config load, not at render", () => {
  const base = loadPattern();
  // "Europe/Copenhagn" is well-formed and meaningless. Left to render time it would silently become UTC.
  assert.throws(() => validatePattern({ ...base, calendar: { timezone: "Europe/Copenhagn" } }),
    /not a time zone this system knows/);
  assert.throws(() => validatePattern({ ...base, calendar: { eventMinutes: 3 } }), /15\.\.600/);
  assert.throws(() => validatePattern({ ...base, calendar: { eventMinutes: 45.5 } }), /whole number/);
  assert.doesNotThrow(() => validatePattern({ ...base, calendar: { timezone: "UTC", eventMinutes: 60 } }));
  assert.doesNotThrow(() => validatePattern({ ...base, calendar: undefined }), "absent means defaults");
});

test("timestamps are basic-format UTC, which is the only form every client agrees on", () => {
  assert.equal(icsStamp(Date.parse("2026-07-15T17:00:00Z")), "20260715T170000Z");
  assert.ok(!icsStamp(Date.now()).includes("-"), "no separators in the basic format");
});

// ---- text, where a config file somebody else edits meets a format with separators ----------------------
test("separators in a label are escaped rather than truncating the event", () => {
  // These are the characters RFC 5545 treats as structural. An activity label with a comma in it would
  // otherwise cut the summary short, and the labels come from a file an admin edits.
  // Synthetic labels on purpose. A real activity name here would be department vocabulary in a test file, and
  // it would also obscure the point: buildIcs treats the label as DATA, so what it contains is arbitrary.
  assert.equal(escapeText("Alpha, Beta"), "Alpha\\, Beta");
  assert.equal(escapeText("a;b"), "a\\;b");
  assert.equal(escapeText("back\\slash"), "back\\\\slash");
  assert.equal(escapeText("two\nlines"), "two\\nlines");
  assert.equal(escapeText("two\r\nlines"), "two\\nlines");
  assert.equal(escapeText(null), "");
});

test("long lines fold at 75 OCTETS without splitting a character in half", () => {
  assert.equal(foldLine("SHORT:value"), "SHORT:value", "a short line is untouched");

  const long = "SUMMARY:" + "a".repeat(200);
  const folded = foldLine(long);
  for (const [i, seg] of folded.split("\r\n").entries()) {
    assert.ok(Buffer.byteLength(seg, "utf8") <= 75, `segment ${i} is ${Buffer.byteLength(seg, "utf8")} octets`);
    if (i > 0) assert.ok(seg.startsWith(" "), "continuation lines must begin with a space");
  }
  assert.equal(folded.split("\r\n").map((s, i) => (i ? s.slice(1) : s)).join(""), long, "unfolding restores it");

  // The case that makes byte-counting necessary: names are exactly where non-ASCII appears, and folding by
  // character length would put half a multi-byte sequence on each side of the fold.
  const accented = "SUMMARY:" + "é".repeat(80);
  const foldedAccented = foldLine(accented);
  for (const seg of foldedAccented.split("\r\n")) {
    assert.ok(Buffer.byteLength(seg, "utf8") <= 75);
    assert.ok(!seg.includes("�"), "a replacement character means a sequence was cut");
  }
  assert.equal(foldedAccented.split("\r\n").map((s, i) => (i ? s.slice(1) : s)).join(""), accented);
});

// ---- the document -------------------------------------------------------------------------------------
const oneRow = (over = {}) => ({
  assignmentId: 7, date: "2026-07-15", hour: 19, minute: 0, role: "l",
  activityLabel: "Alpha", state: "confirmed", ...over,
});

test("the feed is a well-formed calendar with one event per shift", () => {
  const ics = buildIcs({
    rows: [oneRow(), oneRow({ assignmentId: 8, date: "2026-07-19", hour: 13, role: null, activityLabel: "Beta: Gamma" })],
    calendarName: "Feed — my shifts", timeZone: CPH, eventMinutes: 90,
    now: Date.parse("2026-07-01T00:00:00Z"), t,
  });

  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"), "and it must be CRLF, which some clients require");
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 2);
  assert.equal(ics.match(/END:VEVENT/g).length, 2);
  assert.match(ics, /VERSION:2\.0/);

  // 19:00 Copenhagen in July is 17:00Z, and 90 minutes later is 18:30Z.
  assert.match(ics, /DTSTART:20260715T170000Z/);
  assert.match(ics, /DTEND:20260715T183000Z/);

  // The role belongs in the summary: this text is read in a calendar app, away from every screen that shows it.
  assert.match(ics, /SUMMARY:Alpha \(leader\)/);
  assert.match(ics, /SUMMARY:Beta: Gamma\r\n/, "a slot with no role gets no parenthetical");
});

// foldLine was unit-tested above and its APPLICATION was not, which is a distinction this project has paid for
// twice: makeNotifier and startJobs were called only from tests while production wired neither, and the notification
// link strings existed for a whole increment with no call site passing the URL. Measured here the same way —
// `lines.map(foldLine)` removed from buildIcs and the WHOLE SUITE still green.
//
// The consequence is not cosmetic. A department whose activity label is longer than a few words emits content lines
// over 75 octets, and a client that enforces the limit rejects the file rather than the line — so the volunteer's
// calendar simply stops updating, in an app nobody here can see. The shipped labels are short, which is exactly why
// the unit test on the helper was never enough.
test("buildIcs APPLIES the folding, not merely defines it", () => {
  // Long enough to need folding, and non-ASCII so a character-based fold would corrupt it rather than just
  // mis-measure. Built from repeated runs rather than a literal so no department vocabulary appears here.
  const label = `Workshop: ${"øvelsesrække for begyndere ".repeat(3)}hold to`;
  const ics = buildIcs({
    rows: [oneRow({ activityLabel: label, role: null })],
    calendarName: label, timeZone: CPH, eventMinutes: 90,
    now: Date.parse("2026-07-01T00:00:00Z"), t,
  });

  const lines = ics.split("\r\n");
  const over = lines.filter((l) => Buffer.byteLength(l, "utf8") > 75);
  assert.deepEqual(over.map((l) => Buffer.byteLength(l, "utf8")), [],
    `every content line must be at most 75 octets. Over-long: ${over.map((l) => l.slice(0, 40)).join(" | ")}`);

  // The control: this fixture must actually PRODUCE a fold, or the assertion above holds for a feed that never
  // needed one — which is the state the whole suite was in before this test existed.
  assert.ok(lines.some((l) => l.startsWith(" ")), "the fixture must be long enough to fold, or it proves nothing");

  // And the fold must be lossless: unfolding restores the escaped label exactly, with no replacement character
  // from a UTF-8 sequence cut in half.
  const unfolded = lines.map((l, i) => (l.startsWith(" ") ? l.slice(1) : (i ? "\n" + l : l))).join("");
  assert.ok(unfolded.includes(escapeText(label)), "unfolding must restore the summary the client should read");
  assert.ok(!ics.includes("�"), "a fold inside a multi-byte character would leave a replacement character");
});

test("the UID is stable per assignment, so a refresh updates rather than duplicates", () => {
  const a = buildIcs({ rows: [oneRow()], calendarName: "c", timeZone: CPH, now: 1, t });
  const b = buildIcs({ rows: [oneRow()], calendarName: "c", timeZone: CPH, now: 2_000_000, t });
  const uid = (s) => s.match(/UID:(.+)\r\n/)[1];
  assert.equal(uid(a), uid(b), "a changing UID makes every poll add the shift again");
  assert.match(uid(a), /^assignment-7@/);
  assert.notEqual(a.match(/DTSTAMP:(.+)\r\n/)[1], b.match(/DTSTAMP:(.+)\r\n/)[1], "DTSTAMP does move");
});

test("a proposal is TENTATIVE — a plan the planner has not locked in is not a promise", () => {
  const proposed = buildIcs({ rows: [oneRow({ state: "proposed" })], calendarName: "c", timeZone: CPH, t });
  assert.match(proposed, /STATUS:TENTATIVE/);
  const confirmed = buildIcs({ rows: [oneRow()], calendarName: "c", timeZone: CPH, t });
  assert.match(confirmed, /STATUS:CONFIRMED/);
});

test("an empty feed is still a valid calendar, not an error", () => {
  const ics = buildIcs({ rows: [], calendarName: "c", timeZone: CPH, t });
  assert.ok(ics.includes("BEGIN:VCALENDAR") && ics.includes("END:VCALENDAR"));
  assert.ok(!ics.includes("BEGIN:VEVENT"));
});

// ---- the token ----------------------------------------------------------------------------------------
function people() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const ids = seedPeople(db, seasonId, [
    { name: "One", contact: "one@example.org", can: [pattern.activities[0].key] },
    { name: "Two", contact: "two@example.org", can: [pattern.activities[0].key] },
  ]);
  return { db, ids };
}

test("the raw token is shown once and only its hash is kept", () => {
  const { db, ids } = people();
  assert.equal(hasCalendarToken(db, ids[0]), false);

  const made = calendarTokenFor(db, ids[0], { rotate: true });
  assert.ok(made.token, "creation returns the raw token");
  assert.equal(hasCalendarToken(db, ids[0]), true);

  // A database copy must not yield working URLs.
  const stored = db.prepare("SELECT calendar_token_hash h FROM people WHERE id=?").get(ids[0]).h;
  assert.notEqual(stored, made.token);
  assert.equal(stored, hashCalendarToken(made.token));
  assert.equal(stored.length, 64, "sha-256 hex");

  // Asking again without rotating cannot recover it — there is nothing to recover.
  assert.deepEqual(calendarTokenFor(db, ids[0]), { token: null, existing: true });
  db.close();
});

test("a token resolves to its owner, and nothing else does", () => {
  const { db, ids } = people();
  const mine = calendarTokenFor(db, ids[0], { rotate: true }).token;
  assert.deepEqual(personByCalendarToken(db, mine), { personId: ids[0], name: "One" });

  for (const bad of ["", null, undefined, "short", "!!!!!!!!!!!!!!!!!!!!", mine + "x", mine.slice(0, -1),
                     mine.toUpperCase() === mine ? mine.toLowerCase() : mine.toUpperCase()]) {
    assert.equal(personByCalendarToken(db, bad), null, `"${bad}" must not resolve`);
  }
  db.close();
});

test("rotating invalidates the old link immediately, and revoking kills the feed", () => {
  const { db, ids } = people();
  const first = calendarTokenFor(db, ids[0], { rotate: true }).token;
  const second = calendarTokenFor(db, ids[0], { rotate: true }).token;
  assert.notEqual(first, second);
  assert.equal(personByCalendarToken(db, first), null, "a replaced link must stop working at once — that is the point");
  assert.deepEqual(personByCalendarToken(db, second), { personId: ids[0], name: "One" });

  assert.equal(revokeCalendarToken(db, ids[0]), true);
  assert.equal(personByCalendarToken(db, second), null);
  assert.equal(hasCalendarToken(db, ids[0]), false);
  db.close();
});

test("an inactive person's feed stops working", () => {
  const { db, ids } = people();
  const tok = calendarTokenFor(db, ids[0], { rotate: true }).token;
  db.prepare("UPDATE people SET status='inactive' WHERE id=?").run(ids[0]);
  assert.equal(personByCalendarToken(db, tok), null,
    "someone taken off the roster must not keep a live feed of the plan");
  db.close();
});

// ---- over HTTP ----------------------------------------------------------------------------------------
test("the feed serves a calendar without a session, and only that person's shifts", async () => {
  const w = await makeWorld({ volunteers: 2 });
  try {
    // Give each volunteer one slot, so "only mine" is a claim with something to exclude.
    const slots = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 2").all();
    w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(w.people[0], slots[0].id);
    w.db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(w.people[1], slots[1].id);

    const cookie = await w.signIn(w.people[0]);
    const csrf = csrfFromCookie(cookie);
    const made = await w.post("/me/calendar", cookie, new URLSearchParams({ csrf }));
    assert.equal(made.headers.get("location"), "/me?r=calendar_created");

    // The link is shown once, on the next render of /me.
    const page = await (await w.get("/me", cookie)).text();
    const url = page.match(/\/calendar\/([A-Za-z0-9_-]+)\.ics/);
    assert.ok(url, "the fresh link must be shown");

    // Fetched with NO cookie at all — a calendar client has none.
    const feed = await w.get(`/calendar/${url[1]}.ics`);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get("content-type"), /^text\/calendar/);
    assert.ok(!feed.headers.getSetCookie?.()?.length, "a feed request must not start a session");
    const ics = await feed.text();
    assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1, "one event: mine, not both volunteers'");
    assert.match(ics, new RegExp(`UID:assignment-${slots[0].id}@`));
    assert.ok(!ics.includes(`assignment-${slots[1].id}@`), "another volunteer's shift must not be in my feed");

    // And it is shown only once.
    const again = await (await w.get("/me", cookie)).text();
    assert.ok(!/\/calendar\/[A-Za-z0-9_-]+\.ics/.test(again), "the raw link must not be rendered a second time");
  } finally { w.close(); }
});

test("an unknown token is a 404 that reveals nothing, and revoking takes effect over HTTP", async () => {
  const w = await makeWorld({ volunteers: 2 });
  try {
    const bad = await w.get("/calendar/aaaaaaaaaaaaaaaaaaaaaaaa.ics");
    assert.equal(bad.status, 404, "404, not 403 — 'wrong token' and 'no such feed' must look identical");
    assert.equal((await bad.text()).trim(), "", "and it must not describe itself");

    const cookie = await w.signIn(w.people[0]);
    const csrf = csrfFromCookie(cookie);
    await w.post("/me/calendar", cookie, new URLSearchParams({ csrf }));
    const url = (await (await w.get("/me", cookie)).text()).match(/\/calendar\/([A-Za-z0-9_-]+)\.ics/)[1];
    assert.equal((await w.get(`/calendar/${url}.ics`)).status, 200);

    await w.post("/me/calendar", cookie, new URLSearchParams({ csrf, action: "revoke" }));
    assert.equal((await w.get(`/calendar/${url}.ics`)).status, 404, "a revoked link must be dead immediately");
  } finally { w.close(); }
});

test("creating a feed needs a session and a CSRF token", async () => {
  const w = await makeWorld({ volunteers: 2 });
  try {
    const anon = await w.post("/me/calendar", undefined, new URLSearchParams({}));
    assert.equal(anon.status, 303, "signed out is redirected, not served");
    assert.equal(hasCalendarToken(w.db, w.people[0]), false);

    const cookie = await w.signIn(w.people[0]);
    const noCsrf = await w.post("/me/calendar", cookie, new URLSearchParams({}));
    assert.equal(noCsrf.status, 403, "a missing CSRF token must be refused");
    assert.equal(hasCalendarToken(w.db, w.people[0]), false, "and must not have created anything");
  } finally { w.close(); }
});

// ---- erasure ------------------------------------------------------------------------------------------
// The feed would already stop serving an erased person, because resolving a token filters on status='active'
// and anonymising sets it inactive. That is a filter in another module doing an erasure's job — safe by
// coincidence. An erasure must destroy the credential itself.
test("erasing a volunteer destroys their calendar credential, not just its usefulness", async () => {
  const { erasePerson, exportPerson } = await import("../src/retention.mjs");
  const { db, ids } = people();
  const tok = calendarTokenFor(db, ids[0], { rotate: true }).token;
  assert.ok(personByCalendarToken(db, tok), "live before erasure");

  // A subject access request should say a feed exists — but never carry the token.
  const exported = exportPerson(db, ids[0]);
  assert.equal(exported.calendarFeedEnabled, true);
  const asJson = JSON.stringify(exported);
  assert.ok(!asJson.includes(tok), "an export must not contain the raw token");
  assert.ok(!asJson.includes(hashCalendarToken(tok)), "nor its hash — that is a credential, not personal data");

  assert.equal(erasePerson(db, ids[0], { mode: "anonymise" }).ok, true);
  assert.equal(db.prepare("SELECT calendar_token_hash h FROM people WHERE id=?").get(ids[0]).h, null,
    "the stored credential must be gone from the row, not merely unusable");
  assert.equal(personByCalendarToken(db, tok), null);
  assert.equal(exportPerson(db, ids[0]).calendarFeedEnabled, false);

  // The remove mode drops the row entirely, so there is nothing left to hold a token.
  const tok2 = calendarTokenFor(db, ids[1], { rotate: true }).token;
  assert.equal(erasePerson(db, ids[1], { mode: "remove" }).ok, true);
  assert.equal(personByCalendarToken(db, tok2), null);
  db.close();
});
