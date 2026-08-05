// Schema and migration. Node's built-in SQLite only — no npm dependencies anywhere in this project.
//
// `node:sqlite` arrived in Node 22.5.0 but stayed behind --experimental-sqlite until 22.13.0 (and 23.4.0 on
// the other line), so 22.5 is NOT a floor this app can run on — the docs said it was, and on 22.5–22.12 the
// app dies at import with "No such built-in module: node:sqlite" and no hint about why.
//
// package.json `engines` cannot help here: this project has no dependencies, so nobody ever runs `npm
// install`, so nothing ever reads it. A version declared only in a file no tool opens is a wish. Hence a real
// check, before the import that would otherwise fail cryptically — which is why the import is dynamic and
// this module carries a top-level await.
export const MIN_NODE = [22, 13, 0];

// EACH RELEASE LINE HAD ITS OWN CUTOFF, and treating the floor as one number is what let a whole range through.
// The comment above already said it — unflagged in 22.13.0 on the 22 line "and 23.4.0 on the other line" — and
// the code did not implement the second half. It compared major first and returned `maj < 22` for anything off
// the 22 line, so 23.0 through 23.3 were ACCEPTED and then died at the `node:sqlite` import with "No such
// built-in module", which is precisely the cryptic failure this guard exists to replace with a sentence.
//
// The old test could not have caught it: its refused list was 22.5.0, 22.9.1, 22.12.99, 21.7.3, 20.11.0 and its
// accepted list included 23.4.0 — so it exercised the correct boundary on the pass side and never asked about the
// fail side. A hand-kept list of examples cannot notice the case nobody thought of, which is why the test now
// derives its cases from this table instead.
//
// Majors absent from the table shipped node:sqlite unflagged from `.0`, so they need no floor.
export const MIN_BY_MAJOR = { 22: [22, 13, 0], 23: [23, 4, 0] };

export function nodeTooOld(version = process.versions.node) {
  const [maj, min, pat] = version.split(".").map((n) => parseInt(n, 10) || 0);
  if (maj < MIN_NODE[0]) return true;          // 21 and earlier never had the module at all
  const floor = MIN_BY_MAJOR[maj];
  if (!floor) return false;                    // 24 and later: no flag cutoff ever existed
  if (min !== floor[1]) return min < floor[1];
  return pat < floor[2];
}

if (nodeTooOld()) {
  const running = Number(process.versions.node.split(".")[0]);
  // Name the floor for the line they are ACTUALLY on. Telling somebody on 23.2 that they need 22.13 invites them
  // to conclude they already satisfy it.
  const floor = (MIN_BY_MAJOR[running] ?? MIN_NODE).join(".");
  throw new Error(
    `4water Flow needs Node ${floor} or newer; this is ${process.versions.node}.\n` +
    `node:sqlite exists from 22.5.0 but was behind --experimental-sqlite until 22.13.0 on the 22 line and ` +
    `23.4.0 on the 23 line, so it cannot be used here.`,
  );
}
const { DatabaseSync } = await import("node:sqlite");

export function openDb(file = process.env.FOURWATER_DB || "4water.db") {
  let db;
  try {
    db = new DatabaseSync(file);
  } catch (e) {
    // SQLite says "unable to open database file" and nothing else — not the path it tried, not the variable that
    // set it. Measured on a missing directory and on a path that is a directory: exit 1, a stack trace naming
    // db.mjs, and no mention of either. For the most likely misconfiguration of this deployment — the named
    // volume not mounted, so /data does not exist — that is nothing an operator can act on.
    //
    // Everything else here already does better: the Node floor names the version it found, EADDRINUSE names
    // host:port and suggests the next one, a missing FOURWATER_SECRET says which variable. This was the gap.
    //
    // Rethrown rather than exited, because openDb is also called from tools and from tests; the caller decides
    // what a failure means. The message is what was missing.
    const shown = file === ":memory:" ? file : `${file}`;
    throw new Error(
      `4water Flow could not open its database at ${shown}\n` +
      `  ${e.message}\n` +
      `  The path comes from FOURWATER_DB (default: 4water.db beside the app).\n` +
      `  Usually this means the directory does not exist — in the container, that the 4water-data volume is not\n` +
      `  mounted at /data. SQLite creates the FILE but never the directory holding it.`,
      { cause: e },
    );
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");     // off by default in SQLite; the FKs below are decoration without it
  return db;
}

// Columns added to tables that ALREADY EXIST. CREATE TABLE IF NOT EXISTS does nothing to an existing table,
// so without this the schema can never evolve: adding `assignments.role` worked on a fresh database and threw
// "no such column: role" on every deployment that had one. Idempotent-on-a-fresh-database is NOT the same
// property as can-upgrade-an-old-one, and only the first was ever tested.
//
// SQLite's ALTER TABLE ADD COLUMN cannot add a NOT NULL column without a default, and cannot add a CHECK
// constraint — which is exactly why `role` is nullable with the constraint declared only in CREATE TABLE.
// New columns must be nullable or carry a default. Nothing here ever drops or renames: a migration that can
// lose data has no business running unattended at boot.
// Columns added after the first release, applied to databases that predate them. Adding one here AND to the
// CREATE TABLE above is the whole procedure; test/upgrade.test.mjs checks both halves.
//
// ⚠ NEVER `NOT NULL` without a DEFAULT. Measured on SQLite 3.53: `ADD COLUMN x TEXT NOT NULL` is ACCEPTED on an
// empty table and REJECTED on one with rows ("Cannot add a NOT NULL column with default value NULL"). Every test
// database is empty when migrate() runs, so such a column would pass the entire suite and then refuse to apply to
// 4water's live database — an upgrade that fails only in production, which is the worst place to learn it. Use
// `NOT NULL DEFAULT ''` or leave it nullable. (`UNIQUE` is refused either way, so that one fails honestly.)
//
// This is why test/upgrade.test.mjs puts real rows in the fixture before simulating the old schema: the ALTER has
// to run against a populated table, exactly as it will on the real one.
//
// EXPORTED so that test can drop every column on this list rather than a copy of it. It used to name two of them by
// hand, with a comment arguing that stating the coverage was clearer than deriving it — and then `attended` was
// added here, and the upgrade test went on passing without ever altering a table for it. The column the newest
// feature depends on was the one column the upgrade path had never touched.
export const ADDED_COLUMNS = [
  { table: "assignments", column: "role", ddl: "ALTER TABLE assignments ADD COLUMN role TEXT" },
  // Did they turn up? NULL means nobody has said — which is the honest majority state, because a planner marks
  // this after the fact and most shifts will never be marked at all. 1 attended, 0 did not.
  //
  // Nullable and no default, deliberately: see the warning above about NOT NULL on an existing table, and because
  // "not recorded" and "did not attend" are different facts. Defaulting to 0 would turn every unmarked shift into
  // a no-show and quietly wreck the number this column exists to feed.
  { table: "assignments", column: "attended", ddl: "ALTER TABLE assignments ADD COLUMN attended INTEGER" },
  // The calendar subscription's credential, stored only as a SHA-256 hash — a copy of this database must not
  // yield working calendar URLs. NULL means the volunteer has not asked for a feed.
  { table: "people", column: "calendar_token_hash", ddl: "ALTER TABLE people ADD COLUMN calendar_token_hash TEXT" },
];

function applyColumnAdditions(db) {
  const applied = [];
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const exists = db.prepare(`SELECT COUNT(*) n FROM pragma_table_info(?) WHERE name = ?`).get(table, column).n;
    if (exists) continue;
    db.exec(ddl);
    applied.push(`${table}.${column}`);
  }
  return applied;
}

// Idempotent in both directions that matter: safe to run against a fresh database, and able to bring an
// older one up to date. Returns what it changed, so a boot can say so rather than migrating silently.
export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seasons (
      id        INTEGER PRIMARY KEY,
      key       TEXT NOT NULL UNIQUE,
      from_date TEXT NOT NULL,
      to_date   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS people (
      id             INTEGER PRIMARY KEY,
      name           TEXT NOT NULL,
      contact        TEXT,
      -- 'l' leader / 'f' follower / 'b' both. A dance-specific preference, not a permission.
      preferred_role TEXT CHECK (preferred_role IN ('l','f','b')),
      status         TEXT NOT NULL DEFAULT 'active',
      -- Which login produced this person. NextCloud OIDC is primary, invite is the fallback for volunteers
      -- with no NextCloud identity. A COLUMN, never a branch in application logic.
      auth_provider  TEXT NOT NULL DEFAULT 'oidc',
      auth_subject   TEXT,
      -- SHA-256 of the volunteer's calendar-feed token. The raw token is shown once and never stored, exactly
      -- like an invitation. NULL until they ask for a feed.
      calendar_token_hash TEXT,
      UNIQUE (auth_provider, auth_subject)
    );

    CREATE TABLE IF NOT EXISTS person_roles (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      role_id   INTEGER NOT NULL REFERENCES roles(id),
      PRIMARY KEY (person_id, role_id)
    );

    -- FOUR OF THESE COLUMNS ARE WRITTEN AND READ BY NOTHING: parent, subtype, booth_label, consolidation.
    -- They carry values from 4water's real workbook export (consolidation codes S/B/D/W/H, and the activity
    -- hierarchy) and the seeder stores them faithfully, but no query selects them and no screen shows them.
    --
    -- Kept rather than dropped, on purpose. They are cheap, and re-deriving that mapping means going back to the
    -- source spreadsheets — a one-way loss against a few nullable TEXT columns. A consolidation view is a
    -- plausible next feature and this is the data it would need.
    --
    -- Said out loud because a handover artefact must not leave the reader guessing which fields do something.
    -- If you are about to rely on one of these, grep for it under src/ first: as of this line, nothing reads it.
    -- (No backticks in here. This whole schema is a JS template literal, so one would end the string and take
    --  every module that imports this file down with it — which is exactly how it was written the first time.)
    CREATE TABLE IF NOT EXISTS activities (
      id            INTEGER PRIMARY KEY,
      key           TEXT NOT NULL UNIQUE,     -- matches config/pattern.json; the join key for everything
      parent        TEXT,                     -- stored, unread
      subtype       TEXT,                     -- stored, unread
      label         TEXT NOT NULL,            -- display text, sourced from config, never from code
      booth_label   TEXT,                     -- stored, unread
      consolidation TEXT                      -- stored, unread
    );

    CREATE TABLE IF NOT EXISTS capabilities (
      person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      PRIMARY KEY (person_id, activity_id)
    );

    CREATE TABLE IF NOT EXISTS timeslots (
      id          INTEGER PRIMARY KEY,
      -- Weekday INDEX only, getUTCDay() convention. The readable name is a translation and lives in
      -- strings/, which is why no weekday name appears in this file. See test/seams.test.mjs.
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      hour        INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
      minute      INTEGER NOT NULL DEFAULT 0,
      UNIQUE (day_of_week, hour, minute)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY,
      season_id   INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      date        TEXT NOT NULL,              -- ISO yyyy-mm-dd
      timeslot_id INTEGER NOT NULL REFERENCES timeslots(id),
      activity_id INTEGER NOT NULL REFERENCES activities(id),
      UNIQUE (date, timeslot_id, activity_id)
    );

    -- Availability at TWO granularities, because the source workbooks have both ("per Day" and "per Hour").
    -- An hour-level row overrides the day-level row for that hour; see isAvailable() in queries.mjs.
    CREATE TABLE IF NOT EXISTS availability_day (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      available INTEGER NOT NULL CHECK (available IN (0,1)),
      PRIMARY KEY (person_id, date)
    );

    CREATE TABLE IF NOT EXISTS availability_hour (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      hour      INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
      available INTEGER NOT NULL CHECK (available IN (0,1)),
      PRIMARY KEY (person_id, date, hour)
    );

    -- person_id IS NULLABLE AND THAT IS LOAD-BEARING. A row with no person is an OPEN SLOT. "Nobody ever
    -- took it" and "someone handed it back" are the same state, so the vagtbørs is one query over this
    -- table and needs no separate exchange table, no state machine and no planner approval.
    CREATE TABLE IF NOT EXISTS assignments (
      id         INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      person_id  INTEGER REFERENCES people(id) ON DELETE SET NULL,
      -- Which role this slot is for: 'l' leader, 'f' follower, or NULL meaning the role does not matter.
      -- A partner-dance class needs one of each, so it gets TWO rows; a workshop gets one NULL-role row.
      -- Nullable on purpose, so rows written before roles existed remain valid and read as "anyone".
      role       TEXT CHECK (role IN ('l','f')),
      state      TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('proposed','confirmed')),
      -- Did they turn up? NULL means nobody has said, and that is the honest majority state: a planner marks
      -- this after the fact, and most shifts will never be marked at all. 1 attended, 0 did not.
      --
      -- NULL rather than a default of 0, because "not recorded" and "did not attend" are different facts.
      -- Defaulting to 0 would turn every unmarked shift into a no-show and wreck the number this exists to feed.
      attended   INTEGER CHECK (attended IN (0,1))
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id         INTEGER PRIMARY KEY,
      email      TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      role_id    INTEGER REFERENCES roles(id),
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      person_id  INTEGER REFERENCES people(id) ON DELETE SET NULL
    );

    -- Outgoing messages. Recorded whether they were delivered or not, so a webhook that has been quietly
    -- failing for a week looks different from a week with nothing to say.
    --
    -- The UNIQUE constraint is what makes the availability nudge idempotent: one row per (kind, person,
    -- period). It relies on SQLite treating NULLs in a UNIQUE index as distinct — board announcements carry
    -- person_id NULL, so any number of them coexist, while a per-person nudge collides with itself.
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY,
      kind       TEXT NOT NULL,
      person_id  INTEGER REFERENCES people(id) ON DELETE SET NULL,
      period     TEXT,
      channel    TEXT NOT NULL,
      body       TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('sent','failed','queued')),
      error      TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (kind, person_id, period)
    );

    -- Who changed the plan, or somebody else's record, and when. Two planners share one grid, and an
    -- administrator can hand out privilege or erase a person; none of that left a trace.
    --
    -- actor_name is DENORMALISED on purpose. A hard erasure removes the people row, and an audit trail whose
    -- actor has become NULL answers "somebody did this", which is not an audit trail. Keeping the name as it was
    -- makes the record answerable — and makes this table hold personal data, so it is covered by BOTH halves of
    -- the GDPR work: erasure pseudonymises the name to #id exactly as it does in the people table, and retention
    -- prunes on its own window. An audit log outside that work would defeat erasure; erasure that deleted audit
    -- rows would defeat the audit. Neither is acceptable, so each gives up the smaller thing.
    --
    -- NO BACKTICKS IN THIS COMMENT. The whole schema is one JS template literal, so a backtick here ends the
    -- string and takes down every module that imports this file. That is a documented mistake in this project and
    -- I made it again writing this very table: the signature is a SyntaxError at the db.exec line rather than
    -- anything pointing at the comment.
    --
    -- Deliberately NOT logged: a volunteer's own availability answers and their own profile edits. Those change
    -- nothing anybody else relies on, and recording every time somebody changed their mind about one date would
    -- buy thousands of rows of private detail for no accountability. What is logged is what changes the PLAN or
    -- somebody ELSE's record — see AUDITED in src/audit.mjs, which a test holds to the route table.
    CREATE TABLE IF NOT EXISTS audit (
      id         INTEGER PRIMARY KEY,
      at         TEXT NOT NULL,
      actor_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
      actor_name TEXT NOT NULL,
      action     TEXT NOT NULL,
      subject    TEXT,
      detail     TEXT
    );

    -- Notes on a session: the small amount of talking a rota needs. 4water asked for "a chat system of sorts", and
    -- this is the half a general chat tool cannot replace, because the conversation is ATTACHED TO THE SHIFT rather
    -- than scrolling past in a channel: "bring the speaker", "I will be ten minutes late", "swapped with Anna".
    -- Mattermost already runs with the same sign-in, so a third general chat would be the wrong thing to build.
    --
    -- Anchored to the SESSION, not the assignment. The conversation is about the class, and assignments come and go
    -- as people hand shifts back — a note tied to an assignment would vanish with it, which is precisely when the
    -- next person most needs to read it. ON DELETE CASCADE therefore also means season retention removes notes
    -- without anything having to remember they exist.
    --
    -- ⚠ THIS IS THE FIRST FREE TEXT ABOUT PEOPLE IN THE DATABASE, and that is a step change rather than a feature:
    -- structured data can be erased field by field, and free text cannot. docs/PRIVACY.md said "no free-text notes
    -- about people" and now has to say something more careful. What erasure can do is delete a person's OWN notes,
    -- which it does; what it cannot do is find their name inside somebody else's sentence. The cap is 280 characters
    -- to keep this a margin note rather than a correspondence archive nobody can honour a request against.
    CREATE TABLE IF NOT EXISTS notes (
      id          INTEGER PRIMARY KEY,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      person_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      body        TEXT NOT NULL,
      at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_session  ON notes(session_id);
    CREATE INDEX IF NOT EXISTS idx_notes_person   ON notes(person_id);
    CREATE INDEX IF NOT EXISTS idx_audit_at       ON audit(at);
    CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit(actor_id);
    CREATE INDEX IF NOT EXISTS idx_assign_session ON assignments(session_id);
    CREATE INDEX IF NOT EXISTS idx_assign_person  ON assignments(person_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_date  ON sessions(date);
    CREATE INDEX IF NOT EXISTS idx_avail_hour     ON availability_hour(person_id, date);
  `);
  // AFTER the creates, so a fresh database already has everything and this finds nothing to do.
  const added = applyColumnAdditions(db);
  if (added.length) console.log(`[migrate] added column(s): ${added.join(", ")}`);
  return db;
}

// There is deliberately NO score column. Score is a COUNT (see queries.mjs) — storing it would recreate
// exactly the staleness the spreadsheet already suffers from.
