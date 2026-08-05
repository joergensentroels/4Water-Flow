// Parse every module before the suite runs. `npm test` calls this first.
//
// WHY, measured rather than assumed: a single unterminated template literal in src/pages/plan.mjs — a backtick
// inside a comment inside a template literal, which db.mjs warns about over the schema — made the whole suite
// UNRELIABLE rather than red. Most test files failed fast with a SyntaxError, a QUARTER OF THEM NEVER REPORTED AT
// ALL, and the run did not terminate: killed at two minutes on a suite that takes ninety seconds. A worker that
// never exits keeps queued files from being scheduled, so those files were not slow — they were never run.
//
// (Counts written as proportions on purpose: the docs gate forbids stating a test count in a source comment, since
// there is one home for that number and it goes stale everywhere else. It caught the first version of this
// paragraph, which said how many files there were.)
//
// The diagnosis cost most of a working session. `node --check` over every file costs about a second and names the
// file and line, so the failure that hid behind a hang now arrives before anything starts.
//
// This checks SYNTAX only, deliberately. It does not import anything: importing src/server.mjs would open a
// database, and a precheck with side effects is a worse problem than the one it solves.
import { readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every directory holding modules the suite loads. Derived by walking, so a new subdirectory of src/ is covered
// without anybody remembering this file exists — src/pages/ was already one such directory when this was written.
export const CHECKED_DIRS = ["src", "tools", "test"];

export function modulesToCheck(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".mjs")) out.push(next);
    }
  };
  for (const dir of CHECKED_DIRS) walk(dir);
  return out.sort();
}

// `node --check` prints the path and line, then several BLANK lines where the offending source and caret would be
// for a normal error, then the SyntaxError itself. Taking the first four lines therefore reported a file, a line
// number and three blanks — technically the location, and useless for reading. Non-empty lines only, and enough of
// them to reach the message that says what is wrong.
const check = (rel) => new Promise((resolve) => {
  execFile(process.execPath, ["--check", path.join(ROOT, rel)], (err, _out, stderr) => {
    if (!err) return resolve(null);
    const lines = String(stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/^at |^Node\.js v/.test(l));
    resolve({ rel, message: lines.slice(0, 4).join("\n") });
  });
});

// Bounded concurrency: one process per file at once is slower than the suite it guards, and 100 at once on a
// laptop is worse than either.
async function main() {
  const files = modulesToCheck();
  const failures = [];
  const queue = [...files];
  const workers = Array.from({ length: 8 }, async () => {
    for (let rel = queue.shift(); rel; rel = queue.shift()) {
      const bad = await check(rel);
      if (bad) failures.push(bad);
    }
  });
  await Promise.all(workers);

  if (failures.length === 0) {
    console.log(`precheck: ${files.length} modules parse`);
    return;
  }
  console.error(`precheck: ${failures.length} of ${files.length} modules do NOT parse.\n`);
  for (const f of failures.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.error(`  ${f.rel}\n${f.message.split("\n").map((l) => `      ${l}`).join("\n")}\n`);
  }
  console.error("Fix the syntax first: with a module in this state the suite does not merely fail, it leaves");
  console.error("files unrun and may not terminate at all.");
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
