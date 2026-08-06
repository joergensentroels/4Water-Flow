// `node tools/deadassert.mjs` — find assertions in the suite that never execute.
//
// WHY. This project's largest defect class is checks that ran and had nothing to look at, and its sharpest recent
// instance was an assertion that could not fail: `assert.ok(["roster_done","roster_gaps"].includes(code))`, a
// disjunction over the only two answers the route can emit. A green suite is compatible with any number of assertions
// that never even run — inside an `if` nothing satisfies, after an early `return`, in a loop over an empty array, or
// past a `continue` that skips the interesting mode. One of those shipped here: an erasure test covering two modes
// where the fixture's single admin made the second mode hit a guard and `continue`, so half the test was decoration.
//
// A NEVER-EXECUTED ASSERTION IS THE ONE KIND OF DEAD CHECK A MACHINE CAN FIND WITHOUT JUDGEMENT. Whether an assertion
// is *strong* is a question about meaning; whether it *ran* is a fact, and V8 already records it.
//
// `--experimental-test-coverage` will not report this: it excludes test files from its own report by design, and
// `--test-coverage-include=test/**` produces an empty table. So this reads the RAW V8 coverage that Node writes when
// NODE_V8_COVERAGE is set, which is not filtered.
//
// It also inherits the limit that misled this project once already and is worth stating twice: V8 coverage only sees
// the process it is collected in. Tests that `spawn` the server (oidc-endtoend, journey, first-run) record their own
// assertions here — those run in the runner — but nothing about the server's code. That is fine for this tool's
// question and fatal for the other one; see CONTRIBUTING.md.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { testFiles } from "./sourcewalk.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every `assert…` call site, with the byte offset the coverage data is keyed on. Matching the START of the statement
// is what makes the offset meaningful: a multi-line assertion's later lines can sit inside a nested range.
const callSites = (src) => [...src.matchAll(/\bassert(?:\.\w+)?\s*\(/g)].map((m) => {
  const lineStart = src.lastIndexOf("\n", m.index) + 1;
  const before = src.slice(0, lineStart);
  // A DORMANT MARKER, read out of the source rather than kept in a list here. Some assertions correctly never run:
  // one branch of a partition whose fixture takes the other, or a check that only fires if certain prose exists. A
  // list of exemptions in this file would be keyed on line numbers and stale within a commit; a comment sits next to
  // the assertion, moves with it, and has to state a reason. Checked in BOTH directions below — a marker on an
  // assertion that does execute is as much a defect as an unmarked one that does not.
  const prev = before.slice(before.lastIndexOf("\n", before.length - 2) + 1);
  const marker = /\/\/\s*deadassert: dormant\s*[—-]\s*(.+)$/.exec(prev.trim());
  return {
    offset: m.index,
    line: src.slice(0, m.index).split("\n").length,
    text: src.slice(m.index, src.indexOf("\n", m.index) === -1 ? undefined : src.indexOf("\n", m.index)).trim(),
    dormant: marker ? marker[1].trim() : null,
  };
});

// V8 reports nested ranges: the innermost one containing an offset is the one that describes it. Taking the outermost
// would call every assertion inside a function that ran "covered", which is the opposite of the question.
const countAt = (fns, offset) => {
  let best = null;
  for (const fn of fns) {
    for (const r of fn.ranges) {
      if (offset < r.startOffset || offset >= r.endOffset) continue;
      if (!best || (r.endOffset - r.startOffset) < (best.endOffset - best.startOffset)) best = r;
    }
  }
  return best ? best.count : null;   // null = no range covers it, which means the script never loaded
};

let reportedTests = null;   // what the runner said, kept because a document claims it and nothing could check that

function collect(args) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-cov-"));
  try {
    try {
      const out = execFileSync(process.execPath, ["--test", ...args],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_V8_COVERAGE: dir } });
      reportedTests = Number(out.match(/^\s*(?:ℹ\s*)?tests (\d+)\s*$/m)?.[1]) || null;
    } catch (e) {
      // A failing suite still writes coverage, and a report about a red suite is misleading rather than useful.
      const out = String(e.stdout ?? "") + String(e.stderr ?? "");
      if (/^\s*(?:ℹ\s*)?fail [1-9]/m.test(out)) throw new Error("deadassert: the suite is failing — fix that first");
    }
    // Merge across processes by keeping the HIGHEST count seen for a range, because the runner shards test files
    // across several processes and a file that ran in one and not another must not be reported as dead.
    const perFile = new Map();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const json = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      for (const script of json.result) {
        if (!script.url.startsWith("file:")) continue;
        const file = fileURLToPath(script.url);
        if (!perFile.has(file)) perFile.set(file, []);
        perFile.get(file).push(...script.functions);
      }
    }
    return perFile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const perFile = collect(process.argv.slice(2));

// The floor that makes a silent failure loud: if the walk or the coverage merge came back with nothing, this tool
// reports "no dead assertions" in exactly the same words as a clean run. sourcewalk's testFiles() already throws
// below its own minimum; this checks the half sourcewalk cannot see.
const files = testFiles({});
let totalSites = 0;
const dead = [];
const dormant = [];
const staleMarkers = [];
const unseen = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const sites = callSites(src);
  totalSites += sites.length;
  const fns = perFile.get(file);
  if (!fns) { unseen.push(path.relative(ROOT, file)); continue; }
  for (const s of sites) {
    const count = countAt(fns, s.offset);
    const where = { file: path.relative(ROOT, file), ...s };
    if (count === 0) (s.dormant ? dormant : dead).push(where);
    else if (s.dormant) staleMarkers.push(where);
  }
}

if (totalSites < 500) {
  console.error(`deadassert: only ${totalSites} assertion call sites found across ${files.length} files — the reader `
    + "is broken, not the suite. Refusing to report a clean result.");
  process.exit(1);
}
if (unseen.length) {
  console.error(`deadassert: no coverage recorded for ${unseen.length} test file(s): ${unseen.join(", ")}`);
  console.error("            Those files' assertions cannot be judged, so this run is not a clean bill of health.");
}

console.log(`deadassert: ${totalSites} assertion call sites across ${files.length} test files.`);
if (dead.length === 0) {
  console.log(`            every one of them executed at least once, except ${dormant.length} marked dormant.`);
} else {
  console.log(`            ${dead.length} NEVER EXECUTED — a green suite says nothing about these:\n`);
  for (const d of dead) console.log(`  ${d.file}:${d.line}\n    ${d.text.slice(0, 120)}`);
  console.log("\n  Either give the fixture an input that reaches them, or mark each with a reason on the line above:");
  console.log("    // deadassert: dormant — why this correctly never runs");
}
// The other direction, which is what stops the markers becoming a list of stale excuses: a marker on an assertion that
// DOES run is itself a defect. It means the fixture changed and nobody removed the note, and the next reader will trust
// it. Same shape as the exemption lists elsewhere in this suite — both directions or it is not a check.
if (staleMarkers.length) {
  console.log(`\n  ${staleMarkers.length} dormant marker(s) on assertions that DO execute — remove the marker:`);
  for (const s of staleMarkers) console.log(`  ${s.file}:${s.line}  (${s.dormant})`);
}
if (dormant.length && !dead.length) {
  console.log("\n  Dormant, each with its stated reason:");
  for (const d of dormant) console.log(`  ${d.file}:${d.line} — ${d.dormant}`);
}
// ---- and the one claim a test was never able to check --------------------------------------------------------
//
// test/docs.test.mjs states plainly why PLAN.md's "N tests green" is checked BY HAND: knowing the real count means
// running the suite, and a suite that spawns itself does not terminate. That reasoning is correct and it left the figure
// unguarded — PLAN.md said 460 against a real 525, sixty-five stale, in the status line of the handover document.
//
// The irony is recorded in PLAN.md's own increment-AH row: three documents stating the test count were consolidated
// "down to one". Reducing the number of places a fact lives does not stop the last one going stale; only a check does.
// And the restriction was never about tools. This one has just run the suite, so the number is right here.
//
// Matched on "N tests green" specifically, not on any number near the word "tests" — several rows deliberately quote
// HISTORICAL counts while describing how they went stale, and a check that failed on those would be demanding the
// history be falsified.
const docsClaiming = [];
const trackedDocs = execFileSync("git", ["-C", ROOT, "ls-files", "*.md"], { encoding: "utf8" })
  .trim().split(/\r?\n/).filter(Boolean);
for (const rel of trackedDocs) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  for (const m of text.matchAll(/(\d+) tests green/g)) docsClaiming.push({ rel, said: Number(m[1]) });
}
const wrongClaims = docsClaiming.filter((c) => c.said !== reportedTests);
console.log("");
if (reportedTests === null) {
  console.log("            (no test count read from the runner, so document claims were not checked)");
} else if (docsClaiming.length === 0) {
  // BLIND, and said so: the phrase may have been reworded, in which case this check is looking at nothing.
  console.log('            BLIND: no document says "N tests green", so nothing was compared. If that claim was'
    + " reworded, teach this pattern the new wording — a check that matches nothing passes forever.");
} else if (wrongClaims.length === 0) {
  console.log(`            ${docsClaiming.length} document claim(s) of the test count agree with the runner `
    + `(${reportedTests}).`);
} else {
  console.log(`            ${wrongClaims.length} document(s) state a test count the suite does not report `
    + `(${reportedTests}):`);
  for (const c of wrongClaims) console.log(`  ${c.rel}: says ${c.said}`);
}

process.exit(dead.length === 0 && staleMarkers.length === 0 && unseen.length === 0
  && wrongClaims.length === 0 && (reportedTests === null || docsClaiming.length > 0) ? 0 : 1);
