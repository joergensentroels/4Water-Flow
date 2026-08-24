// A populated database you can actually look at.
//
//   node tools/demo.mjs                       # build demo.db
//   FOURWATER_AUTH=dev FOURWATER_DB=demo.db FOURWATER_SECRET=$(openssl rand -hex 32) node src/server.mjs
//
// Everything here is invented ON PURPOSE and obviously so — "Demo One", "demo1@example.invalid". Nothing
// resembles a real 4water volunteer, because a demo database that looks like production is a demo database
// somebody eventually mistakes for production.
import { openDb, migrate } from "../src/db.mjs";
import { loadPattern, makeT } from "../src/config.mjs";
import { nudgeMessage, slotOpenMessage } from "../src/notify.mjs";
import { formatDate, formatTime, formatRole } from "../src/views.mjs";
import { seedSeason, seedPeople } from "../src/seed.mjs";
import { setAvailabilityDay, setAvailabilityHour, assignSlot } from "../src/queries.mjs";
import { bootstrapAdmin } from "./bootstrap.mjs";
import { addNote } from "../src/notes.mjs";
import { recordAudit, AUDITED } from "../src/audit.mjs";

const NAMES = ["Demo One", "Demo Two", "Demo Three", "Demo Four", "Demo Five", "Demo Six",
               "Demo Seven", "Demo Eight", "Demo Nine", "Demo Ten", "Demo Eleven", "Demo Twelve"];

// A season that SPANS TODAY. The real config describes 4water's actual export, whose season ended in June —
// and a demo whose season is over demonstrates the empty state rather than the product. Signing in as a
// planner showed "there is nothing to plan yet", which is correct behaviour and a useless demo.
//
// Six weeks behind for history that has been filled, four months ahead so there is real work to plan.
export function demoSeason(today = new Date()) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 42 * 86400000);
  const to = new Date(today.getTime() + 120 * 86400000);
  return { key: `demo-${iso(from)}`, from: iso(from), to: iso(to) };
}

export function demoPattern(base = loadPattern(), today = new Date()) {
  // MIRRORS THE REAL RHYTHM, and that is the point rather than a coincidence.
  //
  // It used to invent a shape — one workshop slot and one mixed slot — which demonstrated the software and not
  // 4water's week. A volunteer handed this at a meeting should recognise their own timetable, or the feedback is
  // about a schedule nobody runs. So: the four one-hour slots 4water confirmed on 2026-08-23, plus the evening
  // class and the later single-person slot.
  //
  // Positional keys, not names: test/seams.test.mjs forbids naming an activity in a string literal under src/ or
  // test/, and this file is held to the same rule. Which index is which lives in config/pattern.json.
  //
  // The alternation the real config puts on the evening class is deliberately NOT copied — everyNth/weekOffset
  // would leave half the evenings missing one of the two dances, which reads as a bug to somebody seeing the app
  // for the first time. The demo's job is to be recognisable, not to be a second copy of production.
  const keys = base.activities.map((a) => a.key);
  const bothDances = [keys[0], keys[1]];
  return {
    ...base,
    season: demoSeason(today),
    weekly: [
      { dayOfWeek: 3, hour: 19, minute: 0, activities: bothDances },
      // Carries no booth, so the demo shows a class that needs one next to a slot that does not.
      { dayOfWeek: 3, hour: 20, minute: 15, activities: [keys[2]] },
      { dayOfWeek: 0, hour: 13, minute: 0, activities: bothDances },
      { dayOfWeek: 0, hour: 14, minute: 0, activities: bothDances },
      { dayOfWeek: 0, hour: 15, minute: 0, activities: bothDances },
      { dayOfWeek: 0, hour: 16, minute: 0, activities: bothDances },
    ],
  };
}

export function buildDemo(db, { pattern = demoPattern(), people = 12, reset = true } = {}) {
  migrate(db);

  // Running this twice used to seed everyone again — 12 names became 25 people, because seedPeople always
  // INSERTs and nothing checked. A demo builder that silently duplicates its own data is worse than one that
  // refuses, so by default it clears the people it created and starts clean.
  const existing = db.prepare("SELECT COUNT(*) n FROM people").get().n;
  if (existing > 0) {
    if (!reset) return { ok: false, reason: "already_populated", people: existing };
    // Order matters only in that assignments must lose their person before the person goes; the schema's
    // ON DELETE rules handle the rest.
    //
    // SEASONS GO TOO, and leaving them made this tool crash on any second run. `demoSeason` is anchored on today —
    // six weeks back, four months forward — so its key changes every day. Reset deleted the PEOPLE and left the
    // previous season's sessions; seedSeason then created the new season and skipped every session, because seeding
    // only ever adds and those dates and timeslots were already taken. The new season came out with zero sessions,
    // and the next step — reading the first session to build the blocked-hour case — died with "Cannot read
    // properties of undefined (reading 'date')".
    //
    // Measured on the database it left behind: `demo-2026-06-24` with 117 sessions, `demo-2026-06-25` with none.
    // Reachable by exactly the workflow CONTRIBUTING documents — run the demo, come back another day, run it again —
    // and it left the file half-built, people deleted and re-seeded against a season with nothing in it.
    //
    // The demo owns its own database (demo.db, or FOURWATER_DB), so clearing every season is safe here and is what
    // "reset" was always supposed to mean. CASCADE takes the sessions and their assignments.
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE assignments SET person_id = NULL").run();
      db.prepare("DELETE FROM notifications").run();
      db.prepare("DELETE FROM invitations").run();
      db.prepare("DELETE FROM people").run();
      db.prepare("DELETE FROM seasons").run();
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  // seedSeason, so the demo builder cannot drift from what a real boot does — the whole point of that function
  // is that "structure but no slots" is no longer a state anyone can reach by forgetting a call.
  const { seasonId, slots: opened } = seedSeason(db, pattern);
  // And a floor, because the failure above was a TypeError four lines later rather than a sentence. Everything below
  // reads from these sessions, so a season with none is not a demo — it is a database to throw away, and whoever ran
  // this needs to be told which of the two it is.
  const seeded = db.prepare("SELECT COUNT(*) n FROM sessions WHERE season_id=?").get(seasonId).n;
  if (seeded === 0) {
    throw new Error(`demo: season ${pattern.season.key} was created with no sessions. Either its dates contain no day `
      + `the weekly rhythm uses, or another season already occupies them. Delete the database and run again.`);
  }
  const keys = pattern.activities.map((a) => a.key);

  // Deterministic spread of capabilities — no randomness, so the demo looks the same every time and a
  // screenshot from one run matches the next.
  const ids = seedPeople(db, seasonId, NAMES.slice(0, people).map((name, i) => ({
    name,
    contact: `demo${i + 1}@example.invalid`,
    preferredRole: ["l", "f", "b"][i % 3],
    can: [keys[i % keys.length], keys[(i + 1) % keys.length]],
  })));
  const dates = db.prepare("SELECT DISTINCT date FROM sessions WHERE season_id=? ORDER BY date").all(seasonId).map((r) => r.date);
  // Three deliberate shapes, because they are the states the screens must handle:
  //   - most people answer most dates
  //   - one person answers nothing at all (the nudge target, and an empty board)
  //   - one person is free all day but blocks a single hour (the override case)
  ids.forEach((id, i) => {
    if (i === people - 1) return;
    dates.forEach((date, d) => {
      if ((d + i) % 4 === 0) return;                       // some gaps, so the board is not uniformly full
      setAvailabilityDay(db, id, date, (d + i) % 7 !== 0); // and a few explicit "cannot"
    });
  });
  const blockedHour = db.prepare(`SELECT s.date, t.hour FROM sessions s JOIN timeslots t ON t.id=s.timeslot_id
                                  WHERE s.season_id=? ORDER BY s.date LIMIT 1`).get(seasonId);
  setAvailabilityDay(db, ids[0], blockedHour.date, true);
  setAvailabilityHour(db, ids[0], blockedHour.date, blockedHour.hour, false);

  // Fill roughly the first third of the season so the plan has history AND visible gaps.
  const open = db.prepare(`SELECT a.id, s.activity_id FROM assignments a JOIN sessions s ON s.id=a.session_id
                            WHERE a.person_id IS NULL AND s.season_id=? ORDER BY s.date`).all(seasonId);
  let filled = 0;
  for (const slot of open.slice(0, Math.floor(open.length / 3))) {
    for (const id of ids) {
      if (assignSlot(db, slot.id, id, { expectPersonId: null }).ok) { filled++; break; }
    }
  }

  // An admin who can actually sign in, plus a planner who is not an admin — the distinction the screens make.
  // A few messages, so the outbox demonstrates itself rather than showing three zeros. One of each state,
  // because those are the three the page must handle: queued needs a human to copy it somewhere, failed needs
  // a look at the webhook, sent is history. With no webhook configured — the demo's state, and 4water's
  // starting state — everything real would be 'queued'.
  //
  // Composed with the REAL message builders, not with prose written here. Two reasons: the demo then shows the
  // text 4water would actually receive rather than an approximation of it, and no activity label or weekday
  // name gets hardcoded — which test/seams.test.mjs caught when the first version of this did exactly that.
  const dt = makeT(pattern.locale ?? "en");
  const note = db.prepare(`INSERT INTO notifications (kind, person_id, period, channel, body, status, error, created_at)
                           VALUES (:kind, :pid, :period, :channel, :body, :status, :error, :at)`);
  const shown = db.prepare(`SELECT s.date, t.hour, t.minute, act.label, a.role
                              FROM assignments a
                              JOIN sessions s ON s.id=a.session_id
                              JOIN timeslots t ON t.id=s.timeslot_id
                              JOIN activities act ON act.id=s.activity_id
                             WHERE s.season_id=? AND a.role IS NOT NULL
                             ORDER BY s.date, a.role LIMIT 2`).all(seasonId);

  note.run({ kind: "availability_nudge", pid: ids[people - 1], period: "demo", channel: "outbox",
             body: nudgeMessage(dt, { name: NAMES[people - 1], from: dates[0], to: dates.at(-1) }),
             status: "queued", error: null, at: `${dates[0]}T09:00:00Z` });
  for (const [i, s] of shown.entries()) {
    note.run({
      kind: "slot_open", pid: null, period: null,
      channel: i === 0 ? "outbox" : "mattermost",
      body: slotOpenMessage(dt, {
        when: `${formatDate(dt, s.date)} ${formatTime(s.hour, s.minute)}`,
        activity: `${s.label}${formatRole(dt, s.role)}`,
        eligible: 3 + i,
      }),
      // The second one FAILED on purpose: a webhook that has been quietly broken for a week must look
      // different from a week with nothing to say, and the outbox is where that becomes visible.
      status: i === 0 ? "queued" : "failed",
      error: i === 0 ? null : "fetch failed: getaddrinfo ENOTFOUND chat.example.invalid",
      at: `${s.date}T18:30:00Z`,
    });
  }

  // NOTES AND A CHANGE LOG, for the reason stated at the top of this file about the season: a demo that shows the
  // empty state demonstrates the empty state rather than the product. That reasoning was applied to the season dates
  // and not to the features added after it — measured on the demo database this tool had been producing, the change log
  // held ONE row and there were NO notes at all, so two of the newest screens showed a board nothing whatsoever.
  //
  // Notes go on UPCOMING sessions, because that is where a planner would write them, and through addNote so the length
  // cap and the author stamp are the real ones.
  // `dates` is this season's own session dates, so "upcoming" is derived from the fixture rather than from a clock
  // that could disagree with it — the same reason demoSeason spans today in the first place.
  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = db.prepare(`SELECT id, date FROM sessions WHERE season_id=? AND date >= ? ORDER BY date LIMIT 3`)
    .all(seasonId, todayIso);
  const noteTexts = [
    "Bringing the speaker — no need for a second one.",
    "Running 10 minutes late, start the warm-up without me.",
    "New people expected, keep the first half gentle.",
  ];
  for (const [i, sess] of upcoming.entries()) {
    addNote(db, sess.id, { personId: ids[i % ids.length], authorName: NAMES[i % ids.length],
                           body: noteTexts[i], at: new Date(`${sess.date}T09:0${i}:00Z`) });
  }

  // And a change log with one row per KIND the audit vocabulary declares, so the screen shows its own range rather
  // than three copies of one action. Derived from AUDITED — the same constant the app records against — so a new
  // action appears in the demo without anybody remembering to add it here.
  const auditDay = (n) => new Date(`${dates[Math.min(n, dates.length - 1)]}T1${n % 9}:15:00Z`);
  for (const [i, action] of Object.keys(AUDITED).entries()) {
    recordAudit(db, { actorId: ids[i % 2], actorName: NAMES[i % 2], action,
                      subject: null, detail: null, at: auditDay(i) });
  }

  // Its own roles, not config/pattern.json's — otherwise creating the admin dragged 4water's real season into
  // the demo database, sessions and all.
  const admin = bootstrapAdmin(db, { email: "demo1@example.invalid", name: NAMES[0], roles: pattern.roles });
  const plannerRole = db.prepare("SELECT id FROM roles WHERE name='planner'").get().id;
  const volunteerRole = db.prepare("SELECT id FROM roles WHERE name='volunteer'").get().id;
  db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(ids[1], plannerRole);
  for (const id of ids) db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(id, volunteerRole);

  return { seasonId, people: ids, opened, filled, adminPersonId: admin.personId, inviteToken: admin.inviteToken };
}

if (process.argv[1] && (await import("node:url")).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { writeFileSync } = await import("node:fs");
  const dbFile = process.env.FOURWATER_DB || "demo.db";
  const patternFile = process.env.FOURWATER_PATTERN || "demo-pattern.json";

  // The demo needs its own config file, not 4water's. The app reads the season KEY from config to find the
  // season in the database, so seeding one season while the server looks for another would leave every screen
  // empty — which is exactly the failure this replaces.
  //
  // DATABASE FIRST, config second, and that order is the whole point. It was the other way round, and the
  // failure this comment claims to prevent happened anyway by a different route: the pattern file was written,
  // the seeding run then did not complete, and what was left behind was a config naming a season with no
  // sessions in it. Every screen empty, and /status reporting the season as fine. Writing the config only after
  // the database is known good means an interrupted run leaves the PREVIOUS working pair in place.
  const pattern = demoPattern();
  const db = openDb(dbFile);
  const r = buildDemo(db, { pattern });
  writeFileSync(patternFile, JSON.stringify(pattern, null, 2) + "\n", "utf8");
  const today = new Date().toISOString().slice(0, 10);

  // Every count below is scoped to the demo season. Counting the whole table is what hid a second season
  // getting seeded in here: "216 sessions" looked like a healthy demo and was really 117 real ones plus 99
  // belonging to a season the demo knows nothing about.
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const people = one("SELECT COUNT(*) n FROM people");
  const sessions = one("SELECT COUNT(*) n FROM sessions WHERE season_id=?", r.seasonId);
  const ahead = one("SELECT COUNT(*) n FROM sessions WHERE season_id=? AND date >= ?", r.seasonId, today);
  const inSeason = "session_id IN (SELECT id FROM sessions WHERE season_id=?)";

  // Counted from the data, not from how many rows an insert happened to create. Deriving "open" from the
  // insert delta printed "-38 open" on a second run, which is the sort of number that makes a reader distrust
  // everything else on the line.
  const openNow = one(`SELECT COUNT(*) n FROM assignments WHERE person_id IS NULL AND ${inSeason}`, r.seasonId);
  const filledNow = one(`SELECT COUNT(*) n FROM assignments WHERE person_id IS NOT NULL AND ${inSeason}`, r.seasonId);
  const seasons = one("SELECT COUNT(*) n FROM seasons");
  console.log(`demo database ready: ${people} people, ${sessions} sessions, ${filledNow} filled, ${openNow} open`);
  if (seasons !== 1) console.log(`WARNING: ${seasons} seasons in this database — a demo should have exactly one`);
  console.log(`season ${pattern.season.key}: ${pattern.season.from} to ${pattern.season.to} — ${ahead} sessions from today onward`);
  console.log(`admin + planner: ${NAMES[0]} · planner only: ${NAMES[1]} · answered nothing: ${NAMES[11]}`);
  console.log(`\nStart it with the developer sign-in enabled:`);
  console.log(`  FOURWATER_AUTH=dev FOURWATER_DB=${dbFile} FOURWATER_PATTERN=${patternFile} FOURWATER_SECRET=<32+ chars> node src/server.mjs`);
  db.close();
}
