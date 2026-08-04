// Schema and migration. Node's built-in SQLite only — no npm dependencies anywhere in this project.
import { DatabaseSync } from "node:sqlite";

export function openDb(file = process.env.FOURWATER_DB || "4water.db") {
  const db = new DatabaseSync(file);
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
const ADDED_COLUMNS = [
  { table: "assignments", column: "role", ddl: "ALTER TABLE assignments ADD COLUMN role TEXT" },
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
      UNIQUE (auth_provider, auth_subject)
    );

    CREATE TABLE IF NOT EXISTS person_roles (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      role_id   INTEGER NOT NULL REFERENCES roles(id),
      PRIMARY KEY (person_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id            INTEGER PRIMARY KEY,
      key           TEXT NOT NULL UNIQUE,     -- matches config/pattern.json; the join key for everything
      parent        TEXT,
      subtype       TEXT,
      label         TEXT NOT NULL,            -- display text, sourced from config, never from code
      booth_label   TEXT,
      consolidation TEXT
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
      state      TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('proposed','confirmed'))
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
