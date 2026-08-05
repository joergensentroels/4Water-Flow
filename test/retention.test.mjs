// Increment N. These close the three gaps docs/PRIVACY.md admitted to: nothing ever deleted anything, there
// was no erasure, and there was no way to answer an access request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { pruneNotifications, pruneSeasons, runRetention, retentionConfig,
         erasePerson, exportPerson, exportSeasonCsv } from "../src/retention.mjs";
import { rolesOf } from "../src/auth.mjs";
import { setRole } from "../src/admin.mjs";
import { assignSlot, setAvailabilityDay } from "../src/queries.mjs";
import { validatePattern, exportConfig, loadPattern } from "../src/config.mjs";

const withAdmin = (opts, fn) => async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin"] }, ...opts });
  try { await fn(w); } finally { w.close(); }
};
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

const addNotification = (db, { personId = null, daysAgo = 0, now = new Date("2026-08-03T12:00:00Z") }) =>
  db.prepare(`INSERT INTO notifications (kind, person_id, period, channel, body, status, created_at)
              VALUES ('availability_nudge', ?, ?, 'outbox', 'Hi there', 'queued', ?)`)
    .run(personId, `p${daysAgo}`, new Date(now.getTime() - daysAgo * 86400000).toISOString());

// ---- notifications ------------------------------------------------------------------------------------
test("old messages are deleted, recent ones kept, and the count is reported", withAdmin({}, async (w) => {
  const now = new Date("2026-08-03T12:00:00Z");
  for (const d of [1, 10, 89, 91, 200, 400]) addNotification(w.db, { personId: w.people[0], daysAgo: d, now });
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications").get().n, 6);

  const r = pruneNotifications(w.db, { olderThanDays: 90, now });
  assert.equal(r.removed, 3, "91, 200 and 400 days old should go");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications").get().n, 3);
  assert.ok(r.cutoff.startsWith("2026-05-05"), `cutoff looks wrong: ${r.cutoff}`);
}));

test("retention settings come from config, with sane floors", withAdmin({}, async (w) => {
  assert.equal(retentionConfig(w.pattern).seasons, w.pattern.retention.seasons);
  assert.equal(retentionConfig(w.pattern).notificationDays, w.pattern.retention.notificationDays);
  // Nothing configured falls back to the documented defaults.
  assert.deepEqual(retentionConfig({}), { seasons: 2, notificationDays: 90 });

  // A zero, a negative, or a typo must NOT be honoured — "keep zero seasons" would erase every record of who
  // taught what, and that is not an instruction to follow on the strength of a mistyped field.
  for (const bad of [0, -1, "", null, "soon", NaN]) {
    assert.deepEqual(retentionConfig({ retention: { seasons: bad, notificationDays: bad } }),
      { seasons: 2, notificationDays: 90 }, `${JSON.stringify(bad)} should fall back, not delete everything`);
  }
  // A deliberate 1 IS honoured — only the current season, which is a legitimate choice.
  assert.equal(retentionConfig({ retention: { seasons: 1 } }).seasons, 1);
  assert.equal(retentionConfig({ retention: { seasons: "3" } }).seasons, 3, "a string from JSON should still work");
  assert.equal(retentionConfig({ retention: { seasons: 2.7 } }).seasons, 2, "and a fraction rounds down");
}));

// ---- seasons ------------------------------------------------------------------------------------------
test("old seasons are dropped but the CURRENT one is never touched", withAdmin({}, async (w) => {
  // Three older seasons plus the configured one.
  for (const [key, from, to] of [["2023-A", "2023-01-01", "2023-06-30"], ["2024-A", "2024-01-01", "2024-06-30"],
                                 ["2025-A", "2025-01-01", "2025-06-30"]]) {
    w.db.prepare("INSERT INTO seasons (key, from_date, to_date) VALUES (?,?,?)").run(key, from, to);
  }
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM seasons").get().n, 4);

  const r = pruneSeasons(w.db, { keep: 2, currentKey: w.pattern.season.key });
  assert.equal(r.removed.length, 2, "keeping two of four");
  const left = w.db.prepare("SELECT key FROM seasons ORDER BY from_date").all().map((s) => s.key);
  assert.ok(left.includes(w.pattern.season.key), "the current season must survive");
  assert.deepEqual(left.sort(), ["2025-A", w.pattern.season.key].sort());
}));

test("the current season survives even when keep would exclude it", withAdmin({}, async (w) => {
  // Two seasons NEWER than the configured one, so keep:1 would otherwise drop the live season.
  for (const [key, from, to] of [["2030-A", "2030-01-01", "2030-06-30"], ["2031-A", "2031-01-01", "2031-06-30"]]) {
    w.db.prepare("INSERT INTO seasons (key, from_date, to_date) VALUES (?,?,?)").run(key, from, to);
  }
  pruneSeasons(w.db, { keep: 1, currentKey: w.pattern.season.key });
  const left = w.db.prepare("SELECT key FROM seasons").all().map((s) => s.key);
  assert.ok(left.includes(w.pattern.season.key), "deleting the season the app is serving would be an outage");
}));

test("dropping a season takes its sessions and sweeps the availability it leaves behind", withAdmin({}, async (w) => {
  // The configured season has sessions; give it availability too, then make it prunable by adding newer ones.
  setAvailabilityDay(w.db, w.people[0], w.pattern.season.from, true);
  assert.ok(w.db.prepare("SELECT COUNT(*) n FROM availability_day").get().n > 0);
  const sessionsBefore = w.db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
  assert.ok(sessionsBefore > 0);

  for (const [key, from, to] of [["2030-A", "2030-01-01", "2030-06-30"], ["2031-A", "2031-01-01", "2031-06-30"]]) {
    w.db.prepare("INSERT INTO seasons (key, from_date, to_date) VALUES (?,?,?)").run(key, from, to);
  }
  // currentKey null so nothing is protected — proving the cascade and the sweep, not the guard.
  const r = pruneSeasons(w.db, { keep: 2, currentKey: null });
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0].key, w.pattern.season.key);
  assert.ok(r.removed[0].sessions > 0, "the report must say what went with it");

  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0, "sessions cascade");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM assignments").get().n, 0, "and assignments with them");
  // Availability is keyed by DATE, not season, so cascade cannot reach it. Leaving it behind would keep
  // exactly the data the retention rule exists to remove.
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM availability_day").get().n, 0, "orphaned availability must be swept");
  assert.ok(r.orphanedAvailability > 0, "and reported");
}));

test("runRetention reports both halves and is safe to run twice", withAdmin({}, async (w) => {
  addNotification(w.db, { personId: w.people[0], daysAgo: 500 });
  const first = runRetention(w.db, { pattern: w.pattern, currentKey: w.pattern.season.key });
  assert.equal(first.notifications.removed, 1);
  const second = runRetention(w.db, { pattern: w.pattern, currentKey: w.pattern.season.key });
  assert.equal(second.notifications.removed, 0, "a second run has nothing to do");
  assert.deepEqual(second.seasons.removed, []);
}));

// ---- erasure ------------------------------------------------------------------------------------------
test("anonymising strips identity but keeps who ran what", withAdmin({}, async (w) => {
  const target = w.people[2];
  const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  setAvailabilityDay(w.db, target, w.pattern.season.from, true);
  assignSlot(w.db, slot, target, { expectPersonId: null });
  addNotification(w.db, { personId: target, daysAgo: 1 });

  const r = erasePerson(w.db, target, { mode: "anonymise" });
  assert.equal(r.ok, true);
  assert.equal(r.was, "Volunteer 3");

  const after = w.db.prepare("SELECT name, contact, auth_provider, auth_subject, status FROM people WHERE id=?").get(target);
  assert.equal(after.name, `#${target}`, "the label must be stable and obviously not a name");
  assert.equal(after.contact, null);
  assert.equal(after.auth_subject, null, "and they must not be able to sign back in");
  assert.equal(after.auth_provider, "erased");
  assert.equal(after.status, "inactive");

  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM availability_day WHERE person_id=?").get(target).n, 0);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM capabilities WHERE person_id=?").get(target).n, 0);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications WHERE person_id=?").get(target).n, 0,
    "messages naming them must go too");
  // The history survives, which is the whole point of this mode.
  assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(slot).person_id, target);
}));

test("removing entirely deletes the person and leaves past slots unfilled", withAdmin({}, async (w) => {
  const target = w.people[2];
  const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  setAvailabilityDay(w.db, target, w.pattern.season.from, true);
  assignSlot(w.db, slot, target, { expectPersonId: null });

  const r = erasePerson(w.db, target, { mode: "remove" });
  assert.equal(r.ok, true);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM people WHERE id=?").get(target).n, 0);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM availability_day WHERE person_id=?").get(target).n, 0);
  // The session still exists — it happened — but reads as nobody, rather than disappearing from the plan.
  const row = w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(slot);
  assert.ok(row, "the assignment row must survive");
  assert.equal(row.person_id, null);
}));

test("erasure refuses a bad mode, an unknown person, and the last administrator", withAdmin({}, async (w) => {
  assert.deepEqual(erasePerson(w.db, w.people[1], { mode: "obliterate" }), { ok: false, reason: "bad_mode" });
  assert.deepEqual(erasePerson(w.db, 999999, { mode: "remove" }), { ok: false, reason: "no_such_person" });
  assert.deepEqual(erasePerson(w.db, w.people[0], { mode: "remove" }), { ok: false, reason: "last_admin" },
    "an organisation must not be able to erase its way out of having an administrator");

  setRole(w.db, w.people[1], "admin", true);
  assert.equal(erasePerson(w.db, w.people[0], { mode: "anonymise" }).ok, true, "with a second admin it is allowed");
}));

test("erasure through the admin screen, with a message naming what happened", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const r = await w.post("/admin/erase", admin, new URLSearchParams({
    csrf: token, personId: String(w.people[2]), mode: "anonymise",
  }));
  assert.equal(reasonOf(r), "erased");
  const { body } = await w.follow(r, admin);
  assert.match(body, /Volunteer 3/, "the message should name who was erased");
  assert.match(body, /anonymise/);

  // And a volunteer cannot erase anyone.
  const volunteer = await w.signIn(w.people[1]);
  const bad = await w.post("/admin/erase", volunteer, new URLSearchParams({
    csrf: csrfFromCookie(volunteer), personId: String(w.people[0]), mode: "remove",
  }));
  assert.equal(bad.status, 403);
}));

// ---- export -------------------------------------------------------------------------------------------
test("a person's export contains everything held about them and nothing about anyone else", withAdmin({}, async (w) => {
  const me = w.people[1], other = w.people[2];
  setAvailabilityDay(w.db, me, w.pattern.season.from, true);
  setAvailabilityDay(w.db, other, w.pattern.season.from, true);
  const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  assignSlot(w.db, slot, me, { expectPersonId: null });
  addNotification(w.db, { personId: me, daysAgo: 1 });
  addNotification(w.db, { personId: other, daysAgo: 1 });

  const data = exportPerson(w.db, me);
  assert.equal(data.person.name, "Volunteer 2");
  assert.equal(data.person.contact, "v2@example.org");
  assert.ok(data.capabilities.length > 0);
  assert.equal(data.availabilityByDay.length, 1);
  assert.equal(data.assignments.length, 1);
  assert.equal(data.messagesAboutYou.length, 1);

  // The whole document must not mention the other volunteer, by name or by contact address.
  const blob = JSON.stringify(data);
  assert.ok(!blob.includes("Volunteer 3"), "an export must not leak another volunteer");
  assert.ok(!blob.includes("v3@example.org"));
  assert.equal(exportPerson(w.db, 999999), null);
}));

test("the export downloads as a file, and a volunteer can fetch their own", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const r = await w.get(`/admin/person/${w.people[1]}/export.json`, admin);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="4water-person-\d+\.json"/);
  const body = JSON.parse(await r.text());
  assert.ok(body.exportedAt, "the file should say when it was produced");

  // Portability without going through an admin: a volunteer downloads their own.
  const volunteer = await w.signIn(w.people[1]);
  const mine = await w.get("/me/export.json", volunteer);
  assert.equal(mine.status, 200);
  assert.equal(JSON.parse(await mine.text()).person.id, w.people[1]);

  // But not somebody else's.
  assert.equal((await w.get(`/admin/person/${w.people[0]}/export.json`, volunteer)).status, 403);
}));

test("the season CSV quotes every field so a comma or apostrophe cannot shift a column", withAdmin({}, async (w) => {
  w.db.prepare("UPDATE people SET name=? WHERE id=?").run(`O'Brien, "Bo"`, w.people[1]);
  setAvailabilityDay(w.db, w.people[1], w.pattern.season.from, true);
  const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  assignSlot(w.db, slot, w.people[1], { expectPersonId: null });

  const csv = exportSeasonCsv(w.db, w.seasonId);
  assert.equal(csv[0], "\uFEFF", "the export leads with a UTF-8 BOM — see the encoding test below");
  const lines = csv.slice(1).trim().split("\r\n");
  assert.equal(lines[0], '"date","time","activity_key","activity","role","person","state"');
  assert.match(csv, /"O'Brien, ""Bo"""/, "internal quotes must be doubled, not dropped");
  // Every row must have the same number of fields as the header, which is the thing bad quoting breaks.
  const fields = (line) => (line.match(/"(?:[^"]|"")*"/g) ?? []).length;
  for (const line of lines) assert.equal(fields(line), 7, `wrong field count: ${line}`);
  assert.ok(csv.endsWith("\r\n"), "spreadsheets expect CRLF line endings from a .csv");
}));

// This app is for a Danish organisation, so most volunteer names contain æ, ø or å — and the season export is
// the artefact the board is most likely to open. The response says `charset=utf-8`, which is correct and
// useless: the file is DOWNLOADED and then opened from disk, where no HTTP header exists. Without a byte-order
// mark a spreadsheet on Windows decodes it in the system codepage, and "Søren Nørgård" measured out as
// "SÃ¸ren NÃ¸rgÃ¥rd" — every Danish name on every row.
test("Danish names survive the round trip a spreadsheet actually makes", withAdmin({}, async (w) => {
  w.db.prepare("UPDATE people SET name=? WHERE id=?").run("Søren Nørgård", w.people[1]);
  setAvailabilityDay(w.db, w.people[1], w.pattern.season.from, true);
  const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  assignSlot(w.db, slot, w.people[1], { expectPersonId: null });

  const csv = exportSeasonCsv(w.db, w.seasonId);
  const bytes = Buffer.from(csv, "utf8");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the file must begin with a UTF-8 BOM");

  // A BOM-aware reader — which is what every spreadsheet is — gets the name back exactly.
  const decoded = new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes);
  assert.ok(decoded.includes("Søren Nørgård"), "a BOM-aware reader must see the real name");
  assert.ok(!decoded.startsWith("\uFEFF"), "and must not see the mark itself");

  // Turning the BOM off reproduces the defect, so this test is measuring the fix rather than describing it.
  const naked = exportSeasonCsv(w.db, w.seasonId, { bom: false });
  assert.equal(Buffer.from(naked, "utf8").toString("latin1").includes("SÃ¸ren NÃ¸rgÃ¥rd"), true,
    "without the BOM, a codepage reader mangles it — which is what this exists to prevent");
}));

test("the delimiter comes from config, and data containing it still cannot shift a column", withAdmin({}, async (w) => {
  // A name carrying BOTH separators, so neither choice of delimiter can be safe by luck.
  w.db.prepare("UPDATE people SET name=? WHERE id=?").run("Hansen; Kjær, Bo", w.people[1]);
  setAvailabilityDay(w.db, w.people[1], w.pattern.season.from, true);
  const slot = w.db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  assignSlot(w.db, slot, w.people[1], { expectPersonId: null });

  for (const delimiter of [",", ";", "\t", "|"]) {
    const csv = exportSeasonCsv(w.db, w.seasonId, { delimiter }).slice(1);
    const lines = csv.trim().split("\r\n");
    assert.equal(lines[0], ["date", "time", "activity_key", "activity", "role", "person", "state"]
      .map((h) => `"${h}"`).join(delimiter), `header must use ${JSON.stringify(delimiter)}`);
    // Field count by quoted-run, which is delimiter-agnostic: if quoting were wrong, the name's own separator
    // would split it and the count would climb.
    for (const line of lines) {
      assert.equal((line.match(/"(?:[^"]|"")*"/g) ?? []).length, 7, `${JSON.stringify(delimiter)}: ${line}`);
    }
    assert.ok(csv.includes('"Hansen; Kjær, Bo"'), "the name stays in one field whatever separates the columns");
  }
}));

test("a delimiter the config cannot express is refused rather than producing an unreadable file", () => {
  // Built from the real committed config, so this validates against the same shape a deployment loads rather
  // than against a hand-rolled stub that might not resemble it.
  const base = loadPattern();
  // A quote or a newline as the separator yields a file no parser can read, and multi-character is not CSV.
  for (const bad of ['"', "\r\n", ", ", "", "ab", 44]) {
    assert.throws(() => validatePattern({ ...base, export: { csvDelimiter: bad } }),
      /csvDelimiter/, `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of [",", ";", "\t", "|"]) {
    assert.doesNotThrow(() => validatePattern({ ...base, export: { csvDelimiter: good } }));
  }
  assert.throws(() => validatePattern({ ...base, export: "," }), /export must be an object/);

  assert.equal(exportConfig({}).csvDelimiter, ",", "absent means the standard, so an older config keeps working");
  assert.equal(exportConfig({ export: { csvDelimiter: ";" } }).csvDelimiter, ";");

  // And the shipped config says what the comment beside it says, because a deployment's own file is the thing
  // that decides this and a stale comment there would mislead whoever inherits it.
  assert.equal(exportConfig(base).csvDelimiter, ";",
    "config/pattern.json is a Danish deployment; its spreadsheets split on a semicolon");
});

test("the season CSV is planner-gated and downloads as a file", withAdmin({}, async (w) => {
  const admin = await w.signIn(w.people[0]);
  const r = await w.get("/planner/season.csv", admin);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), new RegExp(`filename="4water-${w.pattern.season.key}\\.csv"`));

  const volunteer = await w.signIn(w.people[1]);
  assert.equal((await w.get("/planner/season.csv", volunteer)).status, 403, "the whole roster is not public");
}));

test("running retention from the admin screen reports what it removed", withAdmin({}, async (w) => {
  addNotification(w.db, { personId: w.people[0], daysAgo: 400 });
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const r = await w.post("/admin/retention", admin, new URLSearchParams({ csrf: token }));
  assert.equal(reasonOf(r), "retention_done");
  const { body } = await w.follow(r, admin);
  assert.match(body, /removed 1 messages|1 beskeder/, "a silent clean-up is indistinguishable from a broken one");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications").get().n, 0);
}));

// A partner-dance class opens one slot per role, so this export emits TWO rows with the same date, time and
// activity. Without the role column they are indistinguishable — and for an unfilled pair that means two
// identical rows with an empty person, which reads as a duplicated line in whatever spreadsheet it lands in.
test("the season CSV distinguishes the two halves of a class", withAdmin({}, async (w) => {
  const pair = w.db.prepare(`SELECT s.id, s.date, act.key,
                                    (SELECT COUNT(*) FROM assignments a WHERE a.session_id=s.id) AS slots
                               FROM sessions s JOIN activities act ON act.id=s.activity_id
                              WHERE s.season_id=? AND slots > 1 LIMIT 1`).get(w.seasonId);
  if (!pair) return;                              // a config with no multi-role activity has nothing to assert

  const csv = exportSeasonCsv(w.db, w.seasonId);
  const header = csv.split("\r\n")[0].split(",").map((f) => f.replace(/"/g, ""));
  const roleAt = header.indexOf("role");
  assert.ok(roleAt >= 0, "there must be a role column");

  // The rows for that one session: same date, same activity, different roles, and none of them identical.
  const cells = (line) => (line.match(/"(?:[^"]|"")*"/g) ?? []).map((f) => f.slice(1, -1).replace(/""/g, '"'));
  const rows = csv.split("\r\n").slice(1).filter(Boolean).map(cells)
    .filter((r) => r[0] === pair.date && r[2] === pair.key);
  assert.equal(rows.length, pair.slots, "one row per slot");
  const roles = rows.map((r) => r[roleAt]).sort();
  assert.deepEqual(roles, ["f", "l"], "raw l/f, not a translation — a data export must not change with the locale");
  assert.equal(new Set(rows.map((r) => r.join("|"))).size, rows.length,
    "no two rows for one session may be identical, or the file looks like it has duplicates");
}));

// ---- invitations were never pruned at all ----------------------------------------------------------------
// Found by deliberately looking for siblings of two list-size defects. invitations.email is a personal email
// address, docs/PRIVACY.md lists it as stored personal data, and increment N — the increment whose whole point
// was "nothing deletes anything, ever" — built retention for notifications and seasons and did not touch this
// table. So an invitation sent to somebody who never joined left their address in the database permanently.
test("spent and dead invitations are deleted; live ones are not", withAdmin({}, async (w) => {
  const { pruneInvitations } = await import("../src/retention.mjs");
  const now = new Date("2026-08-04T12:00:00Z");
  const at = (daysAgo) => new Date(now.getTime() - daysAgo * 86400000).toISOString();
  const ins = w.db.prepare("INSERT INTO invitations (email, token, created_at, accepted_at) VALUES (?,?,?,?)");

  ins.run("old-accepted@example.org", "h1", at(200), at(199));   // spent long ago
  ins.run("new-accepted@example.org", "h2", at(10), at(9));      // spent recently
  ins.run("ancient-pending@example.org", "h3", at(200), null);   // expired long ago, never redeemable
  ins.run("recent-pending@example.org", "h4", at(3), null);      // still live — an admin may be waiting on it
  // Revoked: revokeInvite stamps accepted_at with the epoch as a sentinel, so it is older than any cutoff.
  ins.run("revoked@example.org", "h5", at(2), new Date(0).toISOString());

  const r = pruneInvitations(w.db, { olderThanDays: 90, ttlDays: 14, now });
  const left = w.db.prepare("SELECT email FROM invitations ORDER BY email").all().map((x) => x.email);

  assert.deepEqual(left, ["new-accepted@example.org", "recent-pending@example.org"],
    "only a recently-spent invite and a still-live one should survive");
  assert.equal(r.removed, 3);
  assert.equal(r.spent, 2, "the old accepted one and the revoked one");
  assert.equal(r.expired, 1);

  // A revoked invitation is dead the moment it is revoked — keeping the address after that has no purpose.
  assert.ok(!left.includes("revoked@example.org"));
  // And a second run has nothing to do.
  assert.equal(pruneInvitations(w.db, { olderThanDays: 90, ttlDays: 14, now }).removed, 0);
}));

test("runRetention reports invitations, and the summary names them", withAdmin({}, async (w) => {
  const now = new Date("2026-08-04T12:00:00Z");
  w.db.prepare(`INSERT INTO invitations (email, token, created_at, accepted_at)
                VALUES ('gone@example.org','hx',?,?)`)
    .run(new Date(now.getTime() - 300 * 86400000).toISOString(), new Date(now.getTime() - 299 * 86400000).toISOString());

  const r = runRetention(w.db, { pattern: w.pattern, currentKey: w.pattern.season.key, now });
  assert.equal(r.invitations.removed, 1, "runRetention must actually prune them, not just expose the function");
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM invitations").get().n, 0);

  // A clean-up that silently deletes a category it does not mention is as opaque as one that never deletes it.
  const admin = await w.signIn(w.people[0]);
  const { token } = await w.csrfFrom("/admin", admin);
  const posted = await w.post("/admin/retention", admin, new URLSearchParams({ csrf: token }));
  const { body } = await w.follow(posted, admin);
  assert.match(body, /invitations|invitationer/i, "the summary must say how many invitations went");
}));
