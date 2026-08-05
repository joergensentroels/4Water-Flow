// The privacy notice, held against the schema.
//
// docs/PRIVACY.md is the one document with a reader outside this project — a board deciding what the association
// may hold — and it has been wrong twice. The first time it told them four GDPR gaps were open after they were
// closed. The second was worse and it was mine: the attendance commit added `assignments.attended`, and the notice
// went on saying the app stores "no attendance or performance records". A privacy notice that OVERSTATES what is
// held is a smaller problem than one that understates it; this understated it, in the section a board would read
// to decide there was nothing to think about.
//
// Nothing caught it, because every existing check compares prose to code the prose NAMES. A claim about what does
// not exist names nothing, so there is nothing to follow. The two checks here go the other way — from the schema
// to the document — which is the only direction that can notice an omission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "../src/config.mjs";
import { migrate } from "../src/db.mjs";

const NOTICE = readFileSync(path.join(ROOT, "docs/PRIVACY.md"), "utf8");

const schema = () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table").map((r) => r.name);
  const columns = new Map(tables.map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)]));
  db.close();
  return { tables, columns };
};

// Tables that hold nothing about a person, each with the reason. The same shape as AUDITED/NOT_AUDITED: the
// decision is written down, and the check holds it against the schema in both directions, so a new table is a
// failure until somebody has decided which side it falls on.
const NOT_PERSONAL = {
  seasons: "a from-date and a to-date for a season. Nothing about anybody.",
  roles: "the four role names themselves — volunteer, planner, admin — not who holds them.",
  activities: "the catalogue of activities the department runs, configured by an admin.",
  timeslots: "the weekly rhythm: a day of the week and a time. Not tied to a person.",
  sessions: "the calendar of individual sessions generated from the weekly rhythm.",
};
// No entry for `sqlite_sequence`: it is not in this schema, because nothing declares AUTOINCREMENT. Writing one
// anyway was the first thing the stale-entry half of this check caught, on its first run, before any of it was
// committed — an exemption for something that does not exist reads as a decision about the real schema.

// Rows of the "What is stored" table, so an incidental mention of a table name in prose elsewhere in the document
// does not count as having disclosed it. Being described in the data table is the disclosure.
const disclosed = () => {
  const section = NOTICE.split(/^## /m).find((s) => s.startsWith("What is stored")) ?? "";
  const named = new Set();
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    for (const m of line.matchAll(/`([a-z_]+)(?:\.[a-z_]+)?`/g)) named.add(m[1]);
  }
  return named;
};

test("every table holding personal data is described in the notice", () => {
  const { tables } = schema();
  const named = disclosed();
  assert.ok(named.size >= 6, `only ${named.size} tables named in the data table — this check is not reading it`);

  const undisclosed = tables.filter((t) => !named.has(t) && !(t in NOT_PERSONAL));
  assert.deepEqual(undisclosed, [],
    "these tables exist and the privacy notice neither describes them nor says they hold nothing about a person. " +
    "Add a row to the data table in docs/PRIVACY.md, or an entry to NOT_PERSONAL here with the reason:\n  " +
    undisclosed.join("\n  "));

  // The other direction: an exemption for a table that no longer exists reads as a decision somebody made about
  // the current schema, and it is not.
  const stale = Object.keys(NOT_PERSONAL).filter((t) => !tables.includes(t));
  assert.deepEqual(stale, [], `exempted but not a table any more — remove: ${stale}`);

  for (const [t, why] of Object.entries(NOT_PERSONAL)) {
    assert.ok(why.length >= 40, `${t}: say WHY it holds nothing about a person, not just that it does not`);
  }
});

// The notice a VOLUNTEER reads, which is the one that matters most and the one that was missing the most. It listed
// name, contact, capabilities, availability and shifts — not attendance, and not the audit trail, both of which are
// statements somebody else makes about them. docs/PRIVACY.md had the same hole, so fixing only the board's document
// would have left the person it is about less informed than the board.
//
// The mapping from a table to a phrase cannot be derived — "whether you turned up" is not `attended` by any string
// operation. What IS derived is the OBLIGATION: a personal-data table with no phrase listed here fails this test
// rather than passing quietly, so the next column somebody adds cannot slip past. Same shape as the dynamic key
// families in test/strings.test.mjs, where an unlisted family is a failure and not a gap.
const NOTICE_PHRASES = {
  people: [/name/i, /navn/i],
  capabilities: [/activities you can run/i, /aktiviteter du kan/i],
  person_roles: [/planners and administrators/i, /planlæggere og administratorer/i],
  availability_day: [/when you can help/i, /hvornår du kan hjælpe/i],
  availability_hour: [/when you can help/i, /hvornår du kan hjælpe/i],
  assignments: [/turned up/i, /mødte op/i],
  invitations: [/invit/i],
  notifications: [/messages/i, /beskeder/i],
  audit: [/logged/i, /logget/i],
};

test("the volunteer's own notice covers every category held about them", () => {
  const { tables } = schema();
  const personal = tables.filter((t) => !(t in NOT_PERSONAL));
  const unmapped = personal.filter((t) => !(t in NOTICE_PHRASES));
  assert.deepEqual(unmapped, [],
    "these tables hold personal data and nothing here says how the in-app notice covers them. Decide what the " +
    "volunteer should be told, add it to strings/*.json, and list the phrase:\n  " + unmapped.join("\n  "));

  // Read the strings the page actually renders, not the whole file: a phrase sitting in an unused key would
  // otherwise satisfy this check while no volunteer ever saw it.
  const shown = readFileSync(path.join(ROOT, "src/views.mjs"), "utf8");
  const keys = [...shown.matchAll(/t\("(privacy\.[a-zA-Z]+)"\)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, `only ${keys.length} privacy strings are rendered — this check is not reading them`);

  const missing = [];
  for (const locale of ["da", "en"]) {
    const strings = JSON.parse(readFileSync(path.join(ROOT, `strings/${locale}.json`), "utf8"));
    const text = keys.map((k) => strings[k] ?? "").join("\n");
    for (const [table, patterns] of Object.entries(NOTICE_PHRASES)) {
      if (!patterns.some((p) => p.test(text))) missing.push(`${locale}: nothing tells the volunteer about ${table}`);
    }
  }
  assert.deepEqual(missing, [], `the in-app privacy notice is incomplete:\n  ${missing.join("\n  ")}`);
});

// Stem far enough that "attendance" and "attended" meet, and no further. Deliberately crude: this compares a claim
// in prose against column names, and both are written by the same hand on the same day, so the interesting failures
// are near-misses of exactly this kind rather than genuine morphology.
const stem = (w) => w.toLowerCase().replace(/[^a-z]/g, "")
  .replace(/(ances|ance|ings|ing|ed|es|s)$/, "");

const STOPWORDS = new Set(["no", "or", "of", "any", "kind", "about", "the", "a", "an", "and", "is", "are",
                           "this", "that", "there", "not", "nor", "them", "it"]);

test("nothing the notice says is NOT stored is in the schema", () => {
  const { tables, columns } = schema();
  // Every word a table or column name is made of, stemmed. Column names are split on "_" because
  // `calendar_token_hash` should make a claim about "hashes" checkable.
  const vocabulary = new Set();
  for (const t of tables) {
    for (const part of t.split("_")) vocabulary.add(stem(part));
    for (const c of columns.get(t)) for (const part of c.split("_")) vocabulary.add(stem(part));
  }
  assert.ok(vocabulary.has("attend"), "the vocabulary must contain the attendance column, or this proves nothing");

  const m = /\*\*What is deliberately NOT stored:\*\*([\s\S]*?)\n\n/.exec(NOTICE);
  assert.ok(m, "the notice no longer has a 'deliberately NOT stored' paragraph — has it moved, or gone?");
  // Parentheses hold asides about how something works, not claims about what is absent.
  const sentence = m[1].replace(/\([^)]*\)/g, " ").split(".")[0];

  const claims = sentence.split(/,| or /).map((s) => s.trim()).filter((s) => /^no\b/.test(s));
  assert.ok(claims.length >= 3, `expected several 'no X' claims, found ${claims.length} in: ${sentence}`);

  // A claim contradicts the schema when EVERY significant word in it names something in the schema. Requiring all
  // of them is what keeps "no payment details" quiet: `audit.detail` exists, "payment" does not, so the phrase as
  // a whole is not a claim about that column. Matching on the head noun alone would flag it every time.
  const contradicted = claims.filter((c) => {
    const words = c.split(/[\s-]+/).map(stem).filter((w) => w && !STOPWORDS.has(w));
    return words.length > 0 && words.every((w) => vocabulary.has(w));
  });
  assert.deepEqual(contradicted, [],
    "the notice claims these are not stored, and the schema says otherwise. This is the defect that shipped once " +
    "already — the notice said 'no attendance records' while assignments.attended existed:\n  " +
    contradicted.join("\n  "));
});
