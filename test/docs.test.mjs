// The documents, checked against the code.
//
// Four stale claims have turned up in this project one at a time, each found by accident: docs/PRIVACY.md telling
// the board four gaps were open after they had been closed; three UI strings asserting causes that were false;
// RUNBOOK quoting a webhook timeout the code no longer used, twenty minutes after I wrote it; and RUNBOOK calling
// CI a thing that had happened when it had never run. Prose fails exactly like code, and unlike code it is never
// re-executed — so nothing catches it.
//
// This checks only claims a machine can settle: a file path, a route, an environment variable, a config key, an
// exported name. "The app is phone-first" is not checkable here and is not the point. What IS the point is that
// the handover documents cannot quietly drift away from the software they describe.
//
// Deliberately NOT checked here: PLAN.md's "N tests green". Knowing the real number means running the suite, and
// spawning it from inside itself does not terminate — several tests spawn child servers, and spawnSync waits for
// every inherited pipe to close, so a grandchild that outlives the runner holds one open forever. That claim is
// checked by hand when the number changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
// codeDirs() rather than a literal list of directories — see tools/sourcewalk.mjs for why a list that enumerates
// categories is still a hand-kept list, and for the three audits that each kept their own copy of this one.
import { codeDirs } from "../tools/sourcewalk.mjs";

// The documents checked here, FOUND rather than listed. This was a hand-written array of six paths, and it did
// happen to name all six — but a seventh document added later would have been unchecked and nothing would have
// said so. That is the same shape as the notification kinds, the board reasons and the planner reasons: a list of
// what to check cannot notice something absent from itself. This file guards the largest defect class in the
// project, so it is the last place that shape should have survived.
//
// Only `.git` and `node_modules` are skipped, so a document added under `.github` is covered too.
const docFiles = () => {
  const out = [];
  const walk = (rel) => {
    for (const f of readdirSync(rel ? path.join(ROOT, rel) : ROOT, { withFileTypes: true })) {
      if (f.name === ".git" || f.name === "node_modules") continue;
      const next = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) walk(next);
      else if (f.name.endsWith(".md")) out.push(next);
    }
  };
  walk("");
  return out.sort();
};
const DOCS = docFiles();

// The floor, and it is deliberately not the same thing as the old array. That was a CEILING — only these are
// checked. This is a FLOOR: these must be among what was found, and anything else found is checked as well. It
// exists because a walk that returns nothing makes every assertion below loop zero times and pass, which is the
// failure mode this whole file was written to argue against.
const MUST_COVER = ["CONTRIBUTING.md", "PLAN.md", "README.md", "RUNBOOK.md", "docs/OIDC.md", "docs/PRIVACY.md"];

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

// A documented config key is legitimate either because the shipped config has it, or because the code reads it —
// an optional setting a deployment has not set belongs in the documents and not in config/pattern.json.
//
// "the code reads it" used to mean the leaf word appearing ANYWHERE in source, and two things were wrong with that.
// A comment satisfied it, so a made-up setting whose last word appeared in any sentence anywhere passed. And the
// scan covers test/ as well, which means a comment IN THIS FILE naming an example key made that key undetectable —
// the check was defeated by the prose explaining it, silently, rather than failing. That is the seventh time in
// this project that writing the forbidden thing into the explanation has cost something, and the first time it
// disarmed a check instead of tripping one.
//
// So: comments are stripped, and the leaf has to appear as a property access or an object key. Code, not prose,
// which is what the sentence meant all along. No example key is named here on purpose — describe, do not quote.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const configKeyKnown = (facts, dotted) => {
  if (facts.configKeys.has(dotted)) return true;
  const leaf = dotted.split(".").pop();
  return new RegExp(`[.?]\\s*${leaf}\\b|["'\`]${leaf}["'\`]\\s*:`).test(facts.code);
};

function sourceFacts() {
  const files = [];
  const walk = (rel) => {
    for (const f of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (f.isDirectory()) walk(`${rel}/${f.name}`);
      else files.push(`${rel}/${f.name}`);
    }
  };
  for (const d of codeDirs()) walk(d);
  const all = files.filter((f) => f.endsWith(".mjs")).map(read).join("\n");
  return {
    all,
    // The same source with comments removed, for questions about what the code DOES rather than what it says.
    code: stripComments(all),
    routes: new Set([...all.matchAll(/app\.(get|post)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`)),
    exported: new Set([...all.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1])),
    // NEXTCLOUD_ was missing from this prefix list, and the list is the whole reach of every env check in this
    // file. So the three variables that configure the OFF-SITE BACKUP UPLOAD were not merely undocumented — they
    // were outside what any gate here could see. A collector built from a hand-written list of prefixes has the
    // same blind spot as a hand-written list of things to check: it cannot fail for a family nobody listed.
    env: new Set([...all.matchAll(/(?:env|process\.env)[.[]"?(FOURWATER_\w+|OIDC_\w+|MATTERMOST_\w+|NEXTCLOUD_\w+)"?\]?/g)].map((m) => m[1])),
    configKeys: (() => {
      const seen = new Set();
      const rec = (o, prefix = "") => {
        for (const [k, v] of Object.entries(o)) {
          if (k === "_comment") continue;
          seen.add(prefix + k);
          if (v && typeof v === "object" && !Array.isArray(v)) rec(v, `${prefix}${k}.`);
        }
      };
      rec(JSON.parse(read("config/pattern.json")));
      return seen;
    })(),
  };
}

// Before anything else: the set of documents being checked has to be non-empty and has to include the ones that
// carry real claims. Every test below iterates DOCS, so a walk that finds nothing would make all of them pass
// while checking not one sentence — the exact shape of vacuous success this file exists to prevent.
test("the documents checked here are found on disk, and none of the known ones went missing", () => {
  assert.ok(DOCS.length >= MUST_COVER.length,
    `the walk found ${DOCS.length} markdown files; every check in this file iterates that list, so a short one ` +
    `means the checks below are looking at less than they claim: ${DOCS.join(", ")}`);
  const missing = MUST_COVER.filter((d) => !DOCS.includes(d));
  assert.deepEqual(missing, [],
    `these documents carry claims and are no longer being read — renamed, moved, or deleted: ${missing}`);
  // And every found document must be readable, since a claim check that throws is not a claim check that passes.
  for (const d of DOCS) assert.ok(read(d).length > 0, `${d} is empty`);
});

// THE OTHER DIRECTION, and it is the one that finds omissions.
//
// The big claim check below runs documents → code: every dotted config key a document names must exist. That
// cannot notice a key NO document names, because there is no claim to follow — the same asymmetry that let
// docs/PRIVACY.md omit three tables while every sentence in it was true.
//
// Run once, it found five: `season.key`, which is how the app finds the season in the database and therefore the
// most consequential field on the Administration screen; three `holidays.*` keys, undocumented by the commit that
// added them; and `board.requiresApproval`, which was read by NOTHING — a switch wired to no lamp, since setting
// it true would have looked like turning on approval-before-claim. That one was deleted rather than documented.
//
// SETTINGS, meaning the dotted keys. A section name on its own is a container, not a knob, and it is also an
// ordinary English word — "activities", "roles", "season" — so requiring those to be "documented" would pass on
// any document that happens to use the word. The leaves are where an operator's mistake lives.
//
// The rule is the DOTTED PATH VERBATIM, and getting there took two tries. The first version also accepted the leaf
// appearing within 400 characters of its section name, on the reasoning that "under `holidays`: country, extra…" is
// how a person writes. The mutation probe then showed the cost: deleting the RUNBOOK's entire holiday section left
// the check green, because the words "holidays" and "country" still co-occurred elsewhere. A check satisfied by
// vocabulary is a check that prose can silence — the failure this project keeps finding — so verbatim it is, and
// three keys got a line of documentation rather than an exemption.
test("every config setting is documented somewhere an operator reads", () => {
  const prose = DOCS.map(read).join("\n");
  const settings = [...sourceFacts().configKeys].filter((k) => k.includes("."));
  assert.ok(settings.length >= 10, `only ${settings.length} dotted config keys found — the collector is not working`);

  // Both controls, because "0 undocumented" from a blind detector reads exactly like a documented config.
  assert.ok(prose.includes("retention.notificationDays"), "the detector cannot see a key that IS documented");
  assert.ok(!prose.includes("nonsense.notAKey"), "the detector reports a key that does not exist as documented");

  const undocumented = settings.filter((k) => !prose.includes(k));
  assert.deepEqual(undocumented, [],
    "these settings exist in config/pattern.json and no document names them. An operator can only find them by " +
    "reading the source, and a setting nobody documents is one nobody can be told is wrong. Name it in RUNBOOK.md " +
    "or docs/PRIVACY.md — the dotted path, so this check can see it:\n  " + undocumented.join("\n  "));
});

// The same asymmetry, one seam over. The check above ran config → documents; the big claim check runs documents →
// code for environment variables ("names X, which nothing reads"). Nothing ran environment → documents, so a
// variable the app depends on and no document mentions was invisible to every gate in this suite.
//
// Run once, it found five of fourteen: FOURWATER_DB and FOURWATER_PATTERN, which are WHERE THE DATABASE AND THE
// CONFIG FILE ARE; FOURWATER_BACKUP_KEEP, which decides how much history survives; OIDC_SCOPE, which can break
// login; and FOURWATER_BASE_URL, documented in RUNBOOK.md but not for the thing this increment added.
//
// Both directions now exist for both seams, which is the point: a gate that only follows claims can never find
// a silence.
test("every environment variable the app reads is documented somewhere an operator reads", () => {
  const prose = DOCS.map(read).join("\n");
  const env = [...sourceFacts().env].sort();
  assert.ok(env.length >= 10, `only ${env.length} environment variables found — the collector is not working`);

  // Both controls. "0 undocumented" from a blind detector is indistinguishable from a fully documented app.
  assert.ok(prose.includes("FOURWATER_SECRET"), "the detector cannot see a variable that IS documented");
  assert.ok(!prose.includes("FOURWATER_NOT_A_VARIABLE"), "the detector reports a nonexistent variable as documented");

  const undocumented = env.filter((v) => !prose.includes(v));
  assert.deepEqual(undocumented, [],
    "the app reads these and no document names them. An operator can only discover them by reading the source, " +
    "which means nobody can be told they have one set wrong — and two of the first five found this way were the " +
    "paths to the database and the config file. Name each in RUNBOOK.md (or docs/PRIVACY.md), verbatim:\n  " +
    undocumented.join("\n  "));
});

// config/pattern.json carries a long `_comment` that an operator is told to read before hand-editing, and it is
// prose like any other — but it is not markdown, so nothing above reaches it.
//
// It announced "TWO THINGS BELOW ARE PLACEHOLDERS", listed three, and closed with "Both are editable". A count in
// prose that went stale when a third item was added, in the one file the RUNBOOK sends somebody to edit by hand —
// the same failure as the throttle comment that said "two endpoints" for a whole increment after the third arrived.
//
// Announcing a count is allowed here, and has to be TRUE, which is stronger than banning it: the numbers must run
// 1..n with nothing skipped, and any "N things" or "N items" claim must equal n.
test("the config comment's own count of its placeholders is true", () => {
  const comment = JSON.parse(read("config/pattern.json"))._comment;
  assert.ok(Array.isArray(comment) && comment.length > 5, "the config comment is missing or has shrunk to nothing");

  const numbered = comment.map((l) => /^\s*(\d+)\./.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  assert.ok(numbered.length >= 2, `expected a numbered list of placeholders, found ${numbered.length} items`);
  assert.deepEqual(numbered, numbered.map((_, i) => i + 1),
    `the numbered placeholders skip or repeat a number: ${numbered.join(", ")}`);

  const text = comment.join("\n");
  const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const COUNTS = /\b(one|two|three|four|five|six|\d+)\s+(?:things?|items?|placeholders?)\b/gi;
  const claimsIn = (prose) =>
    [...prose.matchAll(COUNTS)].map((m) => ({ said: m[0], n: WORD[m[1].toLowerCase()] ?? Number(m[1]) }));

  // POSITIVE CONTROL FIRST. The comment states no count today — the stale "TWO THINGS BELOW" that caused this test was
  // corrected when it was written — so the loop below has nothing to iterate, and tools/deadassert.mjs reported its
  // assertion as never executed. Dormant is the correct state for this check, and it is indistinguishable from a regex
  // that has stopped matching. So the detector is aimed at a planted claim before it is aimed at the real prose.
  const planted = claimsIn("This section has three placeholders you must edit, and 12 items to read.");
  assert.deepEqual(planted.map((c) => c.n), [3, 12],
    "the count-in-prose detector no longer reads a count out of prose, so the check below is not dormant but blind");

  for (const { said, n } of claimsIn(text)) {
    // deadassert: dormant — the comment states no count today, so there is nothing to compare; the planted control above
    assert.equal(n, numbered.length,
      `the comment says "${said}" while listing ${numbered.length}. Either correct it or describe the list ` +
      `without counting it — a count in prose is what went stale here before.`);
  }
  // "Both" is a count of two wearing a different hat, and it is how the stale version survived a reading.
  if (numbered.length !== 2) {
    assert.ok(!/\bboth\b/i.test(text),
      `the comment says "both" while listing ${numbered.length} placeholders — that is a count of two in disguise`);
  }

  // And the DOCUMENTS that point at this list must not count it either. The gate above shipped checking the
  // comment's internal consistency and nothing else, and within one commit three documents said "three
  // placeholders" while the comment listed four — because a fourth was added to the comment and the readers were
  // not touched. One fact, one home: the config file is the list, and prose describes it.
  // Narrowly: a count of "placeholders", or a count of "values" that the same sentence calls invented. The first
  // version of this matched any count of values and flagged "Only one value is mandatory" in the .env setup, which
  // is the second over-greedy count rule I have written in two commits — both caught by running the rule against
  // the real documents rather than by reasoning about it.
  const COUNT = "(?:one|two|three|four|five|six|\\d+)";
  const counting = [];
  for (const doc of DOCS) {
    const text = read(doc);
    for (const m of text.matchAll(new RegExp(`\\b${COUNT}\\s+placeholders?\\b`, "gi"))) counting.push(`${doc}: "${m[0]}"`);
    // The gap between the count and the word "invented" may cross a filename but not a sentence boundary, so a dot
    // is allowed only when the next character is not whitespace. `[^.]` alone could not span `config/pattern.json`,
    // which is precisely where these sentences point — third iteration on this expression, each failure found by
    // running it against the real documents rather than by reading it.
    const NEAR = "(?:[^.\\n]|\\.(?=\\S)){0,60}?";
    for (const m of text.matchAll(new RegExp(`\\b${COUNT}\\s+(?:configuration\\s+)?values?\\b${NEAR}\\b(?:invented|placeholder)`, "gi"))) {
      counting.push(`${doc}: "${m[0].slice(0, 60)}…"`);
    }
  }
  assert.deepEqual(counting, [],
    "these documents count the placeholders instead of pointing at the file that lists them, which is how the " +
    "number goes stale — describe them, or say \"the values marked as placeholders in config/pattern.json\":\n  " +
    counting.join("\n  "));
});

// One place may state the test count, and it is PLAN.md.
//
// Three documents used to, and when this was written all three disagreed with reality at once: RUNBOOK claimed a
// hundred-and-something automated checks, RUNBOOK claimed a different three-hundred-and-something further down,
// PLAN claimed that same wrong number, and the suite was a fourth. My own doc-claims sweep missed two of them
// because it only matched PLAN's exact phrasing — a checker with a blind spot shaped like the thing it was
// checking.
//
// The numbers are described rather than quoted on purpose: the source scan below now covers this file too, and
// quoting them here would make this comment an offender. That is not a workaround, it is the rule applying to
// itself — the point was never the specific digits, it was that four places disagreed.
//
// The count cannot be verified from inside the suite (running it from within itself does not terminate — see the
// note at the top of this file), so this asserts the STRUCTURE instead: exactly one document may carry a number,
// which makes the external check a single-place check rather than a hunt. Same fix as the Node floor and the
// webhook timeout — one fact, one home.
test("only PLAN.md states a test count, so there is one number to keep true", () => {
  const COUNTISH = /\b\d{2,4}\+?\s+(?:automated\s+)?(?:tests?|checks?)\b/gi;
  const offenders = [];
  for (const doc of DOCS) {
    const hits = [...read(doc).matchAll(COUNTISH)].map((m) => m[0].trim());
    if (!hits.length) continue;
    if (doc === "PLAN.md") {
      assert.equal(hits.length, 1, `PLAN.md must state the count exactly once, found: ${hits.join(", ")}`);
      continue;
    }
    offenders.push(`${doc}: ${hits.join(", ")}`);
  }
  assert.deepEqual(offenders, [],
    `these documents state a test count as well as PLAN.md, so at least one of them will be stale:\n  ` +
    `${offenders.join("\n  ")}\n  Say "the whole suite" instead, and leave the number to PLAN.md.`);
});

// And the same rule for SOURCE, because the test above only ever looked at the six markdown files — so the rule
// had a hole exactly the size of a code comment. `src/config.mjs` sat in it, justifying the `-rc.1` suffix with a
// count that was two dozen out of date.
//
// It hid behind a second thing worth naming: the number and the word were split across a line wrap, with a `// `
// between them. A scan extended to source but not taught about comment continuations walks straight past that — I
// ran exactly that scan first and it reported the file as clean.
//
// So there are TWO patterns rather than one clever normalisation. The first draft unwrapped continuations before
// matching, which sounds tidier and was wrong twice: `\s*` swallowed blank lines and joined unrelated paragraphs
// into sentences neither had said, and even fixed it still matched starting at the second newline of a blank line.
// Matching the wrapped shape directly cannot do that, because it requires the digits and the word to be adjacent
// across exactly one break. Both controls below were written to fail first.
// `\r?\n`, and that is not defensive boilerplate. The first version was `[ \t]*\n`, which passed its unit control
// — built with `\n` in a template literal — and then failed to catch a wrapped count planted in a real file,
// because the working copy on the machine this was written on uses CRLF and `\r` is neither a space nor a tab. The
// control looked at something production does not have. Exactly the shape of the two defects that shipped from
// this repo: a harness supplying what the real thing lacks. The CRLF control below exists for that reason.
const COUNT_SAME_LINE = /\b\d{2,4}\+?[ \t]+(?:automated[ \t]+)?(?:tests?|checks?)\b/gi;
const COUNT_WRAPPED = /\b\d{2,4}\+?[ \t]*\r?\n[ \t]*\/\/[ \t]*(?:automated[ \t]+)?(?:tests?|checks?)\b/gi;
const countsIn = (text) => [...text.matchAll(COUNT_SAME_LINE), ...text.matchAll(COUNT_WRAPPED)]
  .map((m) => m[0].replace(/\s*\n\s*\/\/\s*/, " ").trim());

test("no source comment states a test count either, however it is wrapped", () => {
  const files = [];
  const walk = (rel) => {
    for (const f of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (f.isDirectory()) walk(`${rel}/${f.name}`);
      else if (f.name.endsWith(".mjs")) files.push(`${rel}/${f.name}`);
    }
  };
  for (const d of codeDirs()) walk(d);
  assert.ok(files.length >= 20, `only ${files.length} source files — this is not looking properly`);

  const offenders = [];
  for (const rel of files) {
    for (const hit of countsIn(read(rel))) offenders.push(`${rel}: "${hit}"`);
  }
  assert.deepEqual(offenders, [],
    `source states a test count, which PLAN.md alone is allowed to do — it will be stale within an increment:\n  ` +
    `${offenders.join("\n  ")}\n  Say "the whole suite".`);
});

test("and that scan sees through a line wrap, which is how the last one was missed", () => {
  // The fixtures are ASSEMBLED, never written out, so this file does not contain the thing it forbids — the same
  // reason seams.test.mjs builds its planted activity name from config at runtime instead of typing it. Writing
  // the literal here would make the scan above fail on its own control, which is a special kind of silly. It did,
  // twice, before the fixtures were built this way.
  const n = 300 + 30;
  const word = "tests";

  // Exactly the shape that was in config.mjs: the digits end one line, the word begins the next behind a `//`.
  const wrapped = `// this is feature-complete and covered by ${n}\n// ${word}, and it has never been built\n`;
  assert.equal([...wrapped.matchAll(COUNT_SAME_LINE)].length, 0, "control: a same-line scan really does miss this");
  assert.deepEqual(countsIn(wrapped), [`${n} ${word}`], "and the wrapped pattern is what catches it");

  // It must NOT invent a claim by joining two unrelated comments. The first version of this check normalised
  // continuations away before matching, and did exactly that: a blank line between two paragraphs was swallowed
  // and their text glued into a sentence neither had said. Fixing `\s*` to `[ \t]*` was not enough either — the
  // pattern could still start matching at the SECOND newline of the blank line. Requiring adjacency across one
  // break is what actually closes it.
  assert.deepEqual(countsIn(`// there were ${n}\n\n// ${word} are green\n`), [],
    "a blank line between them is two separate statements, not a wrapped one");
  assert.deepEqual(countsIn(`// there were ${n}\n//\n// ${word} are green\n`), [],
    "and an empty comment line is a paragraph break, not a wrap");

  // The plain same-line case still has to work, or the wrapped pattern has quietly replaced it.
  assert.deepEqual(countsIn(`// the suite has ${n} ${word} today\n`), [`${n} ${word}`]);

  // CRLF, because that is what defeated the first version. This fixture is the whole reason the pattern carries
  // `\r?`: with `\n` only, the scan reported a real file containing a planted wrapped count as clean, while this
  // test's LF fixture passed. A control built from different bytes than the thing under test is not a control.
  assert.deepEqual(countsIn(`// covered by ${n}\r\n// ${word}, and it has never been built\r\n`),
    [`${n} ${word}`], "a Windows working copy must not be invisible to this scan");
  assert.deepEqual(countsIn(`// there were ${n}\r\n\r\n// ${word} are green\r\n`), [],
    "and the blank-line rule has to hold with CRLF too");
});

// The commands the RUNBOOK tells an operator to type, checked against what exists.
//
// This is the least-verified part of the whole project: the image has never been built, so nothing has ever run a
// `docker compose` line from these documents. Everything referenced does currently exist — checked by hand — and
// the point of pinning it is that renaming a compose service or a volume would leave the succession plan quietly
// wrong, in the file somebody reads precisely when they are least able to debug it.
test("every service, volume and port the documents tell an operator to use actually exists", () => {
  const compose = read("compose.yml");
  // Service keys are two-space indented under `services:`; volumes are declared in their own top-level block.
  const services = new Set([...compose.matchAll(/^ {2}([a-z][\w-]*):/gm)].map((m) => m[1]));
  assert.ok(services.has("app"), "compose.yml must define the app service this test reasons about");

  // Volumes come from the top-level `volumes:` block, NOT from "any two-space key with nothing after the colon" —
  // which is what this used to do, and which quietly swept up the service keys as well. `volumes` therefore
  // contained `app` and `backup`, so the `-v` check below was asserting membership in a set that was wrong; it
  // passed because the one real volume happened to be in there too. A set that is a superset of the truth makes an
  // "exists" check into a formality, and this one went unnoticed until a stricter check downstream tripped on it.
  const volumeBlock = compose.split(/^volumes:\s*$/m)[1] ?? "";
  const declarations = [...volumeBlock.matchAll(/^ {2}([\w-]+):[ \t]*\n((?:(?: {4,}| *#).*\n|[ \t]*\n)*)/gm)];
  const volumes = new Set(declarations.map((m) => m[1]));
  assert.ok(volumes.size >= 1 && !volumes.has("app"),
    `the volumes block yielded ${[...volumes].join(", ") || "nothing"} — that is services, or nothing, not volumes`);

  // Which of them have their RUNTIME name pinned. A volume's real name is not its compose key: Compose prefixes it
  // with the project name — the checkout's directory — unless the declaration says `name:` or `external: true`.
  const pinned = new Set(
    declarations.filter((m) => /^ {4}(?:name:|external:[ \t]*true)/m.test(m[2])).map((m) => m[1]));

  const problems = [];
  let checked = 0;
  for (const doc of DOCS) {
    const text = read(doc);

    // `docker compose <verb> [flags] <service>`. Stops at a BACKTICK as well as a newline: these appear both in
    // fenced blocks and as inline spans mid-sentence, and matching to end-of-line swallowed the closing backtick
    // plus the prose after it — so `docker compose logs app` looked like it named no service, because `app` was
    // followed by a backtick rather than whitespace. Three false positives before this was corrected.
    for (const m of text.matchAll(/docker compose (?:run|exec|stop|start|restart|logs)[^\n`]*/g)) {
      const line = m[0];
      const named = [...services].filter((s) => new RegExp(`(?:^|\\s)${s}(?:\\s|$)`).test(line));
      checked++;
      if (!named.length) problems.push(`${doc}: names no known compose service:\n    ${line.trim()}`);
    }

    // Named volumes, which is how the restore procedure reaches /data.
    for (const m of text.matchAll(/-v ([\w-]+):\//g)) {
      checked++;
      if (!volumes.has(m[1])) problems.push(`${doc}: uses volume "${m[1]}", which compose.yml does not declare`);
    }

    // And the name has to be the name. The check above verifies the key EXISTS in compose.yml; it cannot notice
    // that Compose will serve a differently-named volume at runtime, which is a distinction with an operator-
    // visible difference. The restore procedure passed `-v 4water-data:/data`, and `-v` takes a raw Docker name,
    // not a Compose one — so with an unpinned declaration it would have created a new empty volume, mounted it
    // over /data, copied a backup into nothing, and started the app on the database being replaced. `docker
    // volume ls` would also not have shown the name this runbook uses. Both failures land in the same hour.
    for (const v of volumes) {
      if (!new RegExp(`\\b${v}\\b`).test(text)) continue;
      checked++;
      if (!pinned.has(v)) {
        problems.push(`${doc}: names the volume "${v}", but compose.yml leaves its runtime name to Compose, ` +
          `which prefixes it with the project name — so the volume an operator can see is not the one documented. ` +
          `Add "name: ${v}" to the declaration, or stop naming it here.`);
      }
    }

    // The port an operator curls has to be the one the image publishes, or the health check they are told to run
    // reports a failure that is entirely their tooling.
    for (const m of text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/healthz/g)) {
      checked++;
      const published = compose.match(/127\.0\.0\.1:(\d+):\d+/)?.[1];
      if (m[1] !== published) {
        problems.push(`${doc}: says to curl port ${m[1]}, but compose publishes ${published}`);
      }
    }
  }
  assert.ok(checked >= 5, `only ${checked} operator commands were checked — this is not looking properly`);
  assert.deepEqual(problems, [], `the succession plan tells an operator to use things that do not exist:\n  ` +
    `${problems.join("\n  ")}`);
});

// Everything above reads markdown. An operator also reads .env.example, compose.yml, the Dockerfile and the
// _comment in config/pattern.json, and those name the same kinds of thing — paths, environment variables, config
// keys, routes. The previous commit found a stale count in that comment, which is what made the gap visible: prose
// was being checked by file extension rather than by whether anybody reads it.
//
// Only the extractors that need no allow-list are applied here. The function-name one is deliberately left out: a
// sweep with it reported `getUTCDay()` in the config comment (a JavaScript built-in, documenting the weekday
// convention) and `sort()` in the CI workflow (a shell command). Both are false positives, and the markdown version
// of that check only survives them by carrying a hand-kept list of exceptions. Four precise checks that cost
// nothing beat five with a list to maintain.
//
// Nothing was stale when this was written. It exists because .env.example naming a variable nothing reads is
// exactly the failure the markdown gate was built for, and that file was outside it.
test("the prose an operator reads outside the documents is also true", () => {
  const facts = sourceFacts();
  const cfg = JSON.parse(read("config/pattern.json"));
  const sources = { "config/pattern.json (_comment)": (cfg._comment ?? []).join("\n") };
  for (const f of [".env.example", "compose.yml", "Dockerfile"]) {
    if (existsSync(path.join(ROOT, f))) sources[f] = read(f);
  }
  for (const dir of [".github/workflows"]) {
    if (!existsSync(path.join(ROOT, dir))) continue;
    for (const n of readdirSync(path.join(ROOT, dir))) sources[`${dir}/${n}`] = read(`${dir}/${n}`);
  }
  assert.ok(Object.keys(sources).length >= 4,
    `only ${Object.keys(sources).length} non-document prose files found — this check would be looking at almost nothing`);

  const problems = [];
  let checked = 0;
  const claim = (ok, message) => { checked++; if (!ok) problems.push(message); };
  const norm = (s) => s.replace(/:[\w]+/g, ":x");

  for (const [name, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/\b((?:src|tools|test|docs|config|strings|static)\/[\w./-]+\.\w{2,4})\b/g)) {
      claim(existsSync(path.join(ROOT, m[1])), `${name} names ${m[1]}, which does not exist`);
    }
    for (const m of text.matchAll(/\b(FOURWATER_\w+|OIDC_\w+|MATTERMOST_\w+)\b/g)) {
      claim(facts.env.has(m[1]), `${name} names ${m[1]}, which nothing reads`);
    }
    for (const m of text.matchAll(/\b((?:season|calendar|board|export|notify|retention)\.[\w.]+)\b/g)) {
      claim(configKeyKnown(facts, m[1]),
        `${name} names config ${m[1]}, which is neither in config/pattern.json nor read anywhere`);
    }
    for (const m of text.matchAll(/\b(GET|POST)\s+(\/[\w/:.-]*)/g)) {
      claim([...facts.routes].some((r) => norm(r) === norm(`${m[1]} ${m[2]}`)),
        `${name} names route ${m[1]} ${m[2]}, which is not registered`);
    }
  }

  assert.ok(checked >= 10, `only ${checked} claims extracted from non-document prose — the extractors are not reading it`);
  assert.deepEqual(problems, [],
    `${problems.length} claim(s) outside the documents are not true:\n  ${problems.join("\n  ")}`);
});

// Every relative path a document names must be a file the REPOSITORY carries.
//
// The gate below checks paths prefixed src/ tools/ test/ docs/ config/ strings/ static/ — a list of directories,
// so anything outside it is invisible. `../4water-scheduling-spec.md` is outside it, and README.md, RUNBOOK.md and
// PLAN.md pointed at it four times between them. That file is the discovery document: the one thing that says what
// this software is supposed to DO. It is not tracked here, so on a fresh clone, in the container, or for whoever
// inherits this, all four references dangle — **referenced four times and shipped zero**.
//
// Same shape as the environment collector missing a prefix and the plural collector keyed to {n}: a check keyed to
// a list of known cases cannot fail for a case outside the list. Keyed to the SHAPE here — a relative path with a
// file extension — so a reference to anywhere at all is in scope.
//
// Resolved against the DOCUMENT's own directory, because docs/PRIVACY.md naming ../RUNBOOK.md is correct and must
// not be reported. And an extension is required, so `/board/../admin` in prose about the open-redirect fix is not
// mistaken for a file — which it was, in the first draft of this check.
test("every relative path the documents name is a file the repository carries", () => {
  const listed = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  const tracked = new Set(String(listed.stdout ?? "").split(/\r?\n/).filter(Boolean)
    .map((f) => f.split("\\").join("/")));
  assert.ok(tracked.size > 40, `only ${tracked.size} tracked files — git is unavailable, so this check is blind`);
  assert.ok(tracked.has("README.md"), "the collector cannot see a file it certainly carries");

  const dangling = [];
  let checked = 0;
  for (const doc of DOCS) {
    const dir = path.dirname(doc);
    for (const m of read(doc).matchAll(/`((?:\.\.\/)+[\w][\w./-]*\.\w{2,4})`/g)) {
      checked++;
      const resolved = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, m[1]));
      if (!tracked.has(resolved)) dangling.push(`${doc} points at ${m[1]} (${resolved}), which this repository does not carry`);
    }
  }
  assert.ok(checked >= 1, "no relative paths found in any document — the extractor is not reading them");
  assert.deepEqual(dangling, [],
    "a reader who clones this cannot follow these. Either commit the file, or say in the text that it is not part " +
    "of this repository and where to get it — a path that resolves only on the author's machine is worse than no " +
    "path, because it reads as followable:\n  " + dangling.join("\n  "));
});

test("every claim the documents make about the code is true", () => {
  const facts = sourceFacts();
  const problems = [];
  let checked = 0;
  const claim = (ok, message) => { checked++; if (!ok) problems.push(message); };

  for (const doc of DOCS) {
    assert.ok(existsSync(path.join(ROOT, doc)), `${doc} is in this check's list but does not exist`);
    const text = read(doc);

    for (const m of text.matchAll(/`((?:src|tools|test|config|strings|static|docs)\/[\w./-]+)`/g)) {
      claim(existsSync(path.join(ROOT, m[1])), `${doc} names ${m[1]}, which does not exist`);
    }

    for (const m of text.matchAll(/`(GET|POST) (\/[\w/:.-]*)`/g)) {
      const wanted = `${m[1]} ${m[2]}`;
      // Compared with parameter names normalised, so documenting /invite/:token against a route declared
      // /invite/:tok is not a failure — the shape is the claim, not the variable name.
      const norm = (s) => s.replace(/:[\w]+/g, ":x");
      claim([...facts.routes].some((r) => norm(r) === norm(wanted)),
        `${doc} documents route ${wanted}, which is not registered`);
    }

    for (const m of text.matchAll(/`(FOURWATER_\w+|OIDC_\w+|MATTERMOST_\w+)`/g)) {
      claim(facts.env.has(m[1]), `${doc} documents ${m[1]}, which nothing reads`);
    }

    for (const m of text.matchAll(/`((?:season|calendar|board|export|notify|retention)\.[\w.]+)`/g)) {
      // Either it is in the shipped config, or the code reads that name — an optional setting a deployment has
      // not set is legitimately documented and legitimately absent from config/pattern.json.
      claim(configKeyKnown(facts, m[1]),
        `${doc} documents config ${m[1]}, which is neither in config/pattern.json nor read anywhere`);
    }

    for (const m of text.matchAll(/`(\w+)\(\)`/g)) {
      const name = m[1];
      if (!/^[a-z]/.test(name)) continue;                                   // SQL keywords, constructors
      if (["npm", "node", "curl", "git", "docker", "openssl"].includes(name)) continue;   // shell, not ours
      // Also `const name = (…) =>`, which is how every helper scoped inside buildApp is written — gate and
      // postGate among them. Only exports and `function name` counted before, so documenting the two functions
      // that decide who may reach what was reported as a false claim. The checker was the narrow one: a rule
      // that a document may not name a closure-scoped helper pushes documentation away from the code.
      const scoped = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=`).test(facts.all);
      claim(facts.exported.has(name) || facts.all.includes(`function ${name}`) || scoped,
        `${doc} refers to ${name}(), which does not exist in src/ or tools/`);
    }
  }

  // A checker that extracts nothing reports success exactly like one that verified everything, and this project
  // has already produced a probe that reported a true and completely meaningless zero.
  assert.ok(checked >= 40, `only ${checked} claims were extracted — this test is not checking anything`);
  assert.deepEqual(problems, [], `${problems.length} documented claim(s) are not true:\n${problems.join("\n")}`);
});

// ---- the two lifetimes the documents state, measured rather than read ---------------------------------------------
//
// PLAN.md's test count was stale by sixty-five and nothing could check it, which prompted asking what OTHER numeric
// claims these documents make. 58 of them, and almost all are deliberately HISTORICAL — "this measured 23px before the
// fix" must not change, and a check that failed on those would be demanding the history be falsified. Two are claims
// about the CURRENT system that a machine can settle, and both were unguarded:
//
//   RUNBOOK.md   "It is single-use and expires after 14 days."
//   docs/OIDC.md "Sessions last 30 days, and the CSRF token lasts exactly as long."
//
// Both are read OUT OF THE PROSE and then measured against behaviour, not against a constant. Neither constant is
// exported, and exporting one to let a test read it would widen a module's surface to make a weaker check: comparing
// two literals proves they match, while driving the boundary proves the app does what the sentence promises. It also
// means rewording the prose to a different number fails here rather than silently passing.
test("the invitation lifetime RUNBOOK states is the one the code enforces", async () => {
  const { createInvite, inviteStatus } = await import("../src/auth.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const { migrate } = await import("../src/db.mjs");

  const said = Number(/single-use and expires after (\d+) days/.exec(read("RUNBOOK.md"))?.[1]);
  assert.ok(said > 0, "RUNBOOK no longer states an invitation lifetime — reword this pattern or the check is blind");

  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    const at = (days) => new Date(Date.now() - days * 86400000);
    const fresh = createInvite(db, { email: "a@example.org", now: at(said - 1) });
    const stale = createInvite(db, { email: "b@example.org", now: at(said + 1) });
    assert.equal(inviteStatus(db, fresh.token).ok, true,
      `an invitation ${said - 1} days old must still work, or the stated window is shorter than the document says`);
    assert.equal(inviteStatus(db, stale.token).reason, "expired",
      `an invitation ${said + 1} days old must be refused, or the window is longer than the document says`);
  } finally { db.close(); }
});

test("the session lifetime docs/OIDC.md states is the one the cookie carries", async () => {
  const { cookieHeader } = await import("../src/session.mjs");
  const said = Number(/Sessions last (\d+) days/.exec(read("docs/OIDC.md"))?.[1]);
  assert.ok(said > 0, "docs/OIDC.md no longer states a session lifetime — reword this pattern or the check is blind");
  // The header a browser actually receives, which is the only place this promise is kept.
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookieHeader("token-value"))?.[1]);
  assert.ok(maxAge > 0, "the cookie carries no Max-Age at all");
  assert.equal(maxAge / 86400, said, `the cookie lasts ${(maxAge / 86400).toFixed(1)} days, the document says ${said}`);
});
