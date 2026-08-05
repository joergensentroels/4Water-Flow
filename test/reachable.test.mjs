// Data written with no way to read it — the defect this project has now shipped FIVE times.
//
//   1. Notifications composed and filed with no screen. Fixed by the outbox.
//   2. An attendance control put on the planner grid, which filters to the future, so it rendered nothing.
//   3. Audit rows written, covered by five tests, described in the privacy notice, and no page at all.
//   4. `attendedCount` — the contribution figure 4water explicitly asked for — computed for the tests and shown
//      nowhere, in the very commit whose message explains why that number matters.
//   5. (the shape in general) every one of these had a green suite, because the tests were the callers.
//
// Five times is enough to stop writing paragraphs about it and check it. The obvious generalisation does not
// work: "every export needs a production caller" flags 63 exports here, almost all legitimately test-only
// (constants, pure helpers, the testkit itself). MEASURED, not assumed — a 63-entry exception list would be the
// hand-kept list this project keeps deleting.
//
// This is the narrow version that does work. Two properties, both derived:
//
//   - Module reachability is not enough. src/audit.mjs was imported by server.mjs for recordAudit the whole time
//     listAudit was unreachable, so a check at module granularity passes over defect 3. It has to be per
//     function, and an IMPORT must not count as a call — the name appearing in an import line is exactly what
//     made these look wired.
//   - Only functions that READ THE DATABASE are in scope. Those are the ones whose whole purpose is to put
//     something on a screen, which is what makes "no caller" a user-visible defect rather than dead code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
// JS comments AND SQL ones. The `--` half is not thoroughness for its own sake: the first version of this check
// stripped only JS comments, and a `-- attendedCount() computed this for the tests and nobody else` written inside
// a query — an explanation OF this very defect — made the identifier look called and the check pass over it. The
// pattern requires whitespace after `--` so that a JS decrement (`end--;` in calendar.mjs) survives; the test
// below asserts that it does, because eating real code here would hide a real call and report it as a fault.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
  .replace(/(^|\s)--\s[^\n]*/g, "$1");
const stripImports = (s) => s.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");

// What a request can reach: the transitive closure of local imports from the server.
const reachableModules = () => {
  const seen = new Set();
  const follow = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const m of read(rel).matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      try { readFileSync(path.join(ROOT, resolved)); follow(resolved); } catch { /* a node: builtin */ }
    }
  };
  follow("src/server.mjs");
  return [...seen];
};

// Deliberately test-only readers, each with the reason. Same shape as AUDITED/NOT_AUDITED: an entry here is a
// decision, and a reader missing from both this list and the call graph fails.
const TEST_ONLY = {
  workloadSpread:
    "The narrow fairness number the balancing test asserts on. rosterReview is what a human reads, and its own " +
    "comment says so — two readers of the same fact, one for a person and one for an assertion.",
  seedPeople:
    "Called by tools/demo.mjs and tools/bootstrap.mjs, which are command-line entry points and deliberately " +
    "outside the request path. Reaching them from a route would mean the app could reseed itself.",
  buildApp:
    "The app factory itself. Its caller is the boot block at the bottom of its own module, which this check " +
    "cannot see because it splits a file at top-level exports.",
};
// `nodeTooOld` and `PLANNER_WRITE_HONOURS` were excused here until the reader test grew a `db.prepare(` condition,
// at which point neither counted as a reader any more and the stale-entry half of this check said so. Left as a
// note because it is the good failure: an exception list that cannot go out of date is the only kind worth having.

test("every database reader is reachable from a route, or listed as deliberately not", () => {
  const modules = reachableModules();
  assert.ok(modules.length >= 20, `only ${modules.length} modules reachable from server.mjs — not looking properly`);

  // Exported things whose body selects from the database. Split at top-level exports: crude, and the crudeness is
  // accounted for by TEST_ONLY rather than pretended away.
  // A reader must PREPARE A STATEMENT and contain uppercase SQL. Both conditions, and each earns its place:
  // `db.prepare(` rules out prose, and dropping the case-insensitive flag rules out English that happens to read
  // like SQL. The first version had /FROM|JOIN/i and flagged `AUDITED` — a list of route descriptions, one of
  // which says "a slot was removed FROM THE weekly rhythm". A check that cannot tell a sentence from a query
  // would have had prose in its exception list forever.
  const readers = [];
  for (const file of modules) {
    for (const part of stripComments(read(file)).split(/^(?=export\s)/m)) {
      // A FUNCTION, not a data literal. `export const ADDED_COLUMNS = [...]` is a list of DDL strings, and it was
      // flagged the moment it was exported — because the chunk between it and the next top-level export happens to
      // contain a non-exported helper that queries. Splitting a file at top-level exports is crude enough that the
      // discriminator has to be the declaration itself: `function x`, or `const x = (` for an arrow.
      const m = /^export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\()/.exec(part);
      if (m && /db\.prepare\(/.test(part) && /\b(FROM|JOIN)\s+\w+/.test(part)) {
        readers.push({ file, name: m[1] ?? m[2], body: part });
      }
    }
  }
  assert.ok(!readers.some((r) => r.name === "AUDITED"),
    "AUDITED is a list of English sentences, not a query. If it is being counted as a database reader, the " +
    "detection is matching prose and every count below is wrong.");
  assert.ok(readers.length >= 40, `only ${readers.length} database readers found — the scan is not working`);
  assert.ok(readers.some((r) => r.name === "listAudit"),
    "listAudit must be in scope for this check — it is the reader that motivated it");

  const code = new Map(modules.map((f) => [f, stripImports(stripComments(read(f)))]));
  const unreachable = readers.filter((r) => {
    const word = new RegExp(`\\b${r.name}\\b`);
    return ![...code].some(([f, src]) => word.test(f === r.file ? src.replace(r.body, "") : src));
  });

  const undeclared = unreachable.filter((r) => !(r.name in TEST_ONLY)).map((r) => `${r.file}: ${r.name}`);
  assert.deepEqual(undeclared, [],
    "these read the database and nothing outside an import statement calls them, so whatever they compute cannot " +
    "reach a screen. Wire them to a page, delete them, or add them to TEST_ONLY with the reason:\n  " +
    undeclared.join("\n  "));

  // Both directions. An entry excused here that IS now called reads as a decision about the current code and is
  // not one — and the entry for attendedCount was removed by wiring it up rather than by editing this list.
  const stale = Object.keys(TEST_ONLY).filter((n) => !unreachable.some((r) => r.name === n));
  assert.deepEqual(stale, [], `excused but now reachable — remove from TEST_ONLY: ${stale}`);

  for (const [name, why] of Object.entries(TEST_ONLY)) {
    assert.ok(why.length >= 60, `${name}: record WHY a reader with no screen is right here, not just that it is`);
  }
});

// The check above is only worth anything if a reader with no caller actually fails it. This proves the mechanism
// on a synthetic case, because the real one has just been fixed and cannot fail any more.
test("the reachability check can see an unwired reader", () => {
  const modules = reachableModules();
  const code = new Map(modules.map((f) => [f, stripImports(stripComments(read(f)))]));
  // A name that appears in no module at all stands in for a freshly written, unwired reader.
  const word = new RegExp("\\bthisReaderIsWiredToNothing\\b");
  assert.ok(![...code.values()].some((src) => word.test(src)),
    "the detector reports a caller for a function that does not exist — it is matching something it should not");

  // And the positive half: a name that IS called must be seen, or the check would excuse everything.
  const wired = new RegExp("\\blistAudit\\b");
  assert.ok([...code].some(([f, src]) => f !== "src/audit.mjs" && wired.test(src)),
    "listAudit is called by the audit page's route — if this fails, the import-stripping is eating real calls");
});

// The same shape one layer out: a CONFIG key nothing reads.
//
// `board.requiresApproval` sat in config/pattern.json and was read by no code at all. Setting it to true would look
// like turning on approval-before-claim and do nothing whatsoever — a switch wired to no lamp, which is worse than a
// missing switch because the operator believes the room is lit. It is deleted now; this stops the next one.
//
// DESCRIPTIVE keys are the legitimate exception. A file saying which department it belongs to promises no behaviour
// and is useful when there are several files, which the multi-department plan says there will be. The difference
// that matters is whether a reader would expect the app to DO something differently.
const DESCRIPTIVE_CONFIG = {
  department:
    "A label saying whose configuration file this is, for when Copenhagen and Lyon each run their own. It promises " +
    "no behaviour, so nothing reading it is correct rather than an oversight.",
};

test("every config setting is read by the code, or is declared descriptive", () => {
  const files = [];
  const walk = (rel) => {
    for (const f of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const n = `${rel}/${f.name}`;
      if (f.isDirectory()) walk(n);
      else if (f.name.endsWith(".mjs")) files.push(n);
    }
  };
  walk("src"); walk("tools");
  const code = files.map((f) => stripComments(read(f))).join("\n");
  const reads = (leaf) =>
    new RegExp(`\\.${leaf}\\b|\\[\\s*["']${leaf}["']\\s*\\]|\\b${leaf}\\s*[,:}=]`).test(code);

  // CONTROLS FIRST, and this is not ceremony: the first version of this probe reported all 23 keys as unread — a
  // broken detector, not a broken config — and only checking a known-read key exposed it. Had the list been short
  // enough to look plausible, it would have been believed.
  assert.ok(reads("timezone"), "the detector cannot see `calendar.timezone`, which is read in src/calendar.mjs");
  assert.ok(!reads("notAKeyAtAll"), "the detector reports a key that does not exist as read");

  const keys = [];
  const rec = (o, prefix = "") => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_comment")) continue;
      keys.push(prefix + k);
      if (v && typeof v === "object" && !Array.isArray(v)) rec(v, `${prefix}${k}.`);
    }
  };
  rec(JSON.parse(read("config/pattern.json")));
  assert.ok(keys.length >= 15, `only ${keys.length} config keys found — the collector is not working`);

  const dead = keys.filter((k) => !reads(k.split(".").at(-1)) && !(k in DESCRIPTIVE_CONFIG));
  assert.deepEqual(dead, [],
    "these config keys are read by nothing. An operator setting one would expect something to change and nothing " +
    "would. Wire it up, delete it, or add it to DESCRIPTIVE_CONFIG with the reason:\n  " + dead.join("\n  "));

  const stale = Object.keys(DESCRIPTIVE_CONFIG).filter((k) => !keys.includes(k));
  assert.deepEqual(stale, [], `declared descriptive but no longer a config key — remove: ${stale}`);
});

// The comment stripper has to remove SQL comments without removing code, and both halves have bitten. Kept as a
// test rather than a careful regex, because "it looked right" is how the first version shipped blind.
test("stripping comments removes a SQL comment and leaves a JS decrement alone", () => {
  const sql = stripComments("SELECT 1\n  -- attendedCount() is mentioned here\n  FROM t");
  assert.ok(!/attendedCount/.test(sql), "a SQL comment must not be able to make an identifier look called");
  assert.match(sql, /SELECT 1/, "and the query around it must survive");

  const js = stripComments("while (x > 0) end--;\nconst n = 1;");
  assert.match(js, /end--;/, "a JS decrement is not a comment — eating it would hide real calls after it");
  assert.match(js, /const n = 1;/);

  // Over the real file that has one, because the synthetic case above cannot notice a pattern that only misfires
  // in context.
  assert.match(stripComments(read("src/calendar.mjs")), /end--/,
    "src/calendar.mjs has the only decrement in the project and it must still be there after stripping");
});
