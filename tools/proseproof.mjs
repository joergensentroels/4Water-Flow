// `node tools/proseproof.mjs` — prove that no check in the suite is satisfied by a COMMENT.
//
// WHY. About a dozen times in this project, a check that reads source text has been silenced by prose about the thing
// it checks. An SQL comment naming `attendedCount()` made a reachability audit think the function was wired. A comment
// in a test file naming an example config key made that key undetectable to the gate explaining it. Most recently a
// comment I wrote to explain changing CI's command from `node --test` to `npm test` kept an assertion green that was
// looking for `node --test` — the phrase appeared nowhere in anything CI executes, and the test passed.
//
// Each of those was found by accident. There is one mutation that finds the whole class at once: REMOVE EVERY COMMENT
// and run the suite. A check whose needle lived in prose loses its needle and fails. A check that reads code is
// unaffected. Nothing has to be listed, and nothing has to be guessed about which checks are at risk.
//
// Three formats, because the hazard is not specific to JavaScript and the one that actually bit was YAML:
//   - `.mjs` under src/ and tools/ — tokenised, not regexed, because `//` inside a string or a regex literal is not a
//     comment and breaking the code would blame the tests for the tool's mistake;
//   - `#` lines in .github/workflows/*.yml — where the CI defect lived;
//   - `_comment` in config/*.json — prose carried inside data, which an operator is told to read before editing.
//
// It runs in a throwaway git worktree at HEAD, so the working tree is never touched.
//
// EXPECTED failures are declared below with a reason, and the declaration is checked BOTH ways: a declared failure that
// stops failing is reported too, because otherwise the list becomes a set of excuses nobody re-reads.
//
// AND THE TOOL CONTROLS ITSELF. A clean result here is only worth stating if the sweep can detect the defect at all, so
// every run plants one: a needle in a comment, and a check that looks for it. If that planted check does NOT fail, the
// stripper did not work and this refuses to report anything.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, symlinkSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();
const NEEDLE = "proseproof-planted-needle-do-not-remove";

// A check that correctly depends on a comment, because the comment is its SUBJECT. Keyed by test name.
const EXPECTED = {
  "the config comment's own count of its placeholders is true":
    "its subject IS config/pattern.json's _comment — asserting the prose exists and that its own count is true. "
    + "Deleting the prose must fail this, and does, by name.",
  "the ids in _openQuestions match the numbered placeholders in the comment":
    "same subject as the check above, from the other side: it holds the machine-readable _openQuestions in step "
    + "with the numbered prose, so stripping the prose must fail it. It was SPLIT OUT of the document check for "
    + "this reason — that one reads _openQuestions and the documents, never prose, so it must keep passing here "
    + "and is deliberately not covered by this exemption.",
  "control: the planted needle": "the tool's own control; see NEEDLE above. It MUST fail or this run is void.",
};

// Tokeniser. Tracks strings, template literals and regex literals so a `//` inside one survives.
function stripJs(s) {
  let out = "", i = 0, ctx = null;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (ctx) {
      if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
      if (c === ctx) ctx = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { ctx = c; out += c; i++; continue; }
    if (c === "/" && d === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "/") {
      // A regex can only begin where a value can. Approximated from the previous non-space character, which is enough
      // here because every file is re-parsed with `node --check` afterwards and a mistake is caught rather than shipped.
      const prev = out.replace(/\s+$/, "").slice(-1);
      if (prev === "" || "(,=:[!&|?{};+~*%<>^".includes(prev)) { ctx = "/"; out += c; i++; continue; }
    }
    out += c; i++;
  }
  return out;
}

let exitCode = 1;   // pessimistic: a crash before the verdict must not read as success
const wt = mkdtempSync(path.join(os.tmpdir(), "4water-proseproof-"));
rmSync(wt, { recursive: true, force: true });           // git insists on creating it itself
try {
  git("worktree", "add", "-q", "--detach", wt, "HEAD");
  const at = (rel) => path.join(wt, rel);

  // node_modules is not in git, so a fresh worktree has none — and the moment this project gained its first
  // devDependency (axe-core, for the accessibility gate) the whole of test/a11y.test.mjs failed here with
  // ERR_MODULE_NOT_FOUND and was reported as a check that "lost its needle". It had lost nothing; it could not
  // load. A tool that runs the suite somewhere else has to give it the same packages, or every dependency added
  // from here on reads as a prose defect. Linked rather than copied — it is large and only read here.
  if (existsSync(path.join(ROOT, "node_modules"))) {
    try {
      // "junction" is a WINDOWS link type. It was hardcoded, so this line could only ever work on the machine it
      // was written on: on Linux it throws and the refusal below fires, which is why this tool exited 2 on every
      // CI run it has ever had while passing locally. Same shape as the two path assertions in Bureau that asserted
      // Windows semantics as universal. A junction is the right choice on Windows — it needs no privileges, where a
      // directory symlink does — so the platform is asked rather than assumed.
      symlinkSync(path.join(ROOT, "node_modules"), at("node_modules"),
                  process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      // Refuse rather than report: a run where some tests cannot load produces failures indistinguishable from
      // real ones, which is worse than no run.
      console.error(`proseproof: could not link node_modules into the worktree (${e.code || e.message}).`
        + "\n            Tests needing a devDependency would fail for that reason alone, so this run is void.");
      process.exit(2);
    }
  }

  // Plant the control BEFORE stripping: a needle inside a comment in a file the stripper covers, and a check that
  // looks for it in the raw bytes. This is the defect's exact shape, so the sweep must kill it.
  appendFileSync(at("tools/precheck.mjs"), `\n// ${NEEDLE}\n`);
  writeFileSync(at("test/zz-proseproof-control.test.mjs"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\n`
    + `import { readFileSync } from "node:fs";\nimport path from "node:path";\nimport { ROOT } from "../src/config.mjs";\n`
    + `test("control: the planted needle", () => {\n`
    + `  assert.match(readFileSync(path.join(ROOT, "tools/precheck.mjs"), "utf8"), /${NEEDLE}/,\n`
    + `    "the needle exists only inside a comment, so a raw read finds it and a stripped file does not");\n});\n`);

  let jsChanged = 0, jsSkipped = [];
  for (const rel of git("ls-files", "src/*.mjs", "tools/*.mjs").split("\n").filter(Boolean)) {
    const before = readFileSync(at(rel), "utf8");
    const after = stripJs(before);
    if (after === before) continue;
    writeFileSync(at(rel), after);
    try { execFileSync(process.execPath, ["--check", at(rel)], { stdio: "ignore" }); jsChanged++; }
    catch { writeFileSync(at(rel), before); jsSkipped.push(rel); }
  }

  let ymlLines = 0;
  for (const rel of git("ls-files", ".github/workflows/*.yml", "*.yml").split("\n").filter(Boolean)) {
    const before = readFileSync(at(rel), "utf8").split("\n");
    const after = before.filter((l) => !/^\s*#/.test(l));
    ymlLines += before.length - after.length;
    writeFileSync(at(rel), after.join("\n"));
  }

  let jsonProse = 0;
  for (const rel of git("ls-files", "config/*.json").split("\n").filter(Boolean)) {
    const j = JSON.parse(readFileSync(at(rel), "utf8"));
    if (!j._comment) continue;
    jsonProse += Array.isArray(j._comment) ? j._comment.length : 1;
    delete j._comment;
    writeFileSync(at(rel), `${JSON.stringify(j, null, 2)}\n`);
  }

  console.log(`proseproof: stripped comments from ${jsChanged} module(s), ${ymlLines} yaml comment line(s), `
    + `${jsonProse} line(s) of config prose.`);
  if (jsSkipped.length) console.log(`            ${jsSkipped.length} module(s) left alone, strip broke parsing: ${jsSkipped.join(", ")}`);

  let out = "";
  // The reporter is PINNED, and that is the whole point of naming it here. Node chooses a reporter by whether
  // stdout is a TTY: the spec reporter interactively, TAP when piped -- and it changed which it picks between
  // 22 and 24. This tool parses the runner's output, so an unpinned reporter means parsing a shape that
  // depends on the Node version and the terminal. On 22.14 the spec regex matched nothing, so no failing test
  // was ever seen, so the control "did not fire" and this refused to report -- correctly, but for a reason
  // that was about the parser rather than about the sweep. It fails safe and could not succeed.
  try { out = execFileSync(process.execPath, ["--test", "--test-reporter=spec"], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); }

  // Failing test NAMES, from the runner's own summary block rather than from counting ✖ marks in the stream.
  const failed = [...out.matchAll(/^\s*✖\s+(.+?)\s+\(\d[\d.]*ms\)/gm)].map((m) => m[1]);
  const unique = [...new Set(failed)];
  const unexpected = unique.filter((n) => !(n in EXPECTED));
  const stale = Object.keys(EXPECTED).filter((n) => !unique.includes(n));

  // The exit code is COMPUTED here and applied after the worktree is gone. `process.exit()` inside a try does not run
  // the finally — it terminates immediately — so the first version of this leaked a worktree on every run, which the
  // tool's own output gave no hint of. Cleanup that has never been watched is not cleanup.
  if (!unique.includes("control: the planted needle")) {
    console.error("\nproseproof: THE CONTROL DID NOT FAIL. The planted needle survived the strip, so the sweep is not\n"
      + "            removing comments and a clean result here would mean nothing. Refusing to report.");
    exitCode = 2;
  } else {
    console.log("            control fired: a needle that lived only in a comment was detected.");
    if (unexpected.length === 0) {
      console.log(`\n            no check in the suite is satisfied by a comment. ${unique.length - 1} declared `
        + "exception(s), each because the prose is its subject.");
    } else {
      console.log(`\n            ${unexpected.length} check(s) LOST THEIR NEEDLE when the comments went — each was `
        + "reading prose, not code:\n");
      for (const n of unexpected) console.log(`  ✖ ${n}`);
    }
    if (stale.length) {
      console.log("\n            declared exception(s) that no longer fail — remove them from EXPECTED:");
      for (const n of stale) console.log(`  ${n}: ${EXPECTED[n]}`);
    }
    exitCode = unexpected.length === 0 && stale.length === 0 ? 0 : 1;
  }
} finally {
  try { git("worktree", "remove", "--force", wt); } catch { rmSync(wt, { recursive: true, force: true }); }
}
process.exit(exitCode);
