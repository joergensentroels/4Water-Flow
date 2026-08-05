// The one file-walk the derived audits share — and the floor that makes blinding it impossible.
//
// WHY THIS EXISTS, measured rather than argued. `sourceFiles()` was defined twice, in test/seams.test.mjs and
// test/strings.test.mjs, near-identically. Replacing both bodies with `return []` and running the whole suite:
// **only three tests in the whole suite noticed.** Every other audit built on the walk reported success over
// nothing at all — and two of the three noticed by accident rather than by design.
//
// The two DoD-6 gates passed INCLUDING THEIR OWN CONTROLS. Each has a sibling test named "and the gate genuinely
// fails when a name IS planted" / "and that scan genuinely fires" — and each of those builds its own input string
// and runs the detector on it. So the control proves the REGEX works. It says nothing about whether any file was
// ever read. A planted-input control and an empty walk are perfectly compatible: the detector is fine, the
// collector found nothing, and both tests are green.
//
// That is the same shape as the plural gate keyed to {n} and the outcome scan keyed to `flashFor`: a clean result
// and a blind one produce identical output. The difference here is that the fix can be structural rather than
// per-audit. A floor asserted inside each test would work and would have to be remembered eleven times; a floor
// inside the WALK cannot be forgotten, because there is nowhere else to get the file list from.
//
// It THROWS rather than returning a short list. An audit that never asserts anything about its own collection is
// still safe, which is the point — the guarantee must not depend on the caller having thought about it.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";

// A smoke floor, not a census. The repository has upwards of eighty modules; this only has to notice the walk
// returning nothing or nearly nothing, and a number that tracked the true count would be one more figure to keep
// true. Deliberately low so that deleting a file is never a test failure.
export const MIN_MODULES = 20;

// WHICH TOP-LEVEL DIRECTORIES HOLD CODE, read off the disk rather than listed.
//
// Three audits kept this as a literal: SCAN_DIRS in test/seams.test.mjs and two `["src", "tools", "test"]` walks in
// test/docs.test.mjs. All three happen to be complete today. That is the problem — a fourth directory of modules
// would be skipped by the department-vocabulary gate, the invisible-character scan, the raw() audit and the
// translation-key check simultaneously, and every one of them would still pass.
//
// It is the same trap as the environment collector's prefix families, the plural collector keyed to {n}, and the
// document file-checker matching seven directory names: a list that enumerates CATEGORIES feels derived because it
// iterates and has no hardcoded answers, and it is still a hand-kept list. The tell is a constant naming kinds
// rather than describing structure. So this describes the structure: a top-level directory is code if it contains
// a module.
export function codeDirs() {
  const out = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .filter((name) => {
      const holds = (dir) => readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .some((f) => (f.isDirectory() ? holds(path.join(dir, f.name)) : f.name.endsWith(".mjs")));
      return holds(name);
    })
    .sort();
  if (out.length < 2) {
    throw new Error(`codeDirs() found ${out.length} directory/ies holding modules, expected at least 2 — ` +
                    `every derived audit walks this, so a short answer narrows all of them at once.`);
  }
  return out;
}

export function sourceFiles({ dirs = ["src", "tools"], exempt = [], min = MIN_MODULES } = {}) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!exempt.includes(name)) walk(full);
      } else if (name.endsWith(".mjs")) out.push(full);
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  if (out.length < min) {
    throw new Error(
      `sourceFiles() found ${out.length} module(s) under ${dirs.join(", ")}, and at least ${min} are expected.\n` +
      `  Every derived audit in test/ builds its evidence from this list, so a walk that returns nothing turns\n` +
      `  each of them into a green test over an empty set. Measured once: only three tests noticed.\n` +
      `  Either the directories moved, or this walk is broken — both are worse than a failing audit.`);
  }
  return out;
}

// Files under test/ itself, for the audits that check the tests rather than the app. Same floor, same reasoning:
// test/image.test.mjs asks whether any test depends on a gitignored file, and over an empty directory the answer
// is always no.
export function testFiles({ min = MIN_MODULES } = {}) {
  const dir = path.join(ROOT, "test");
  const out = readdirSync(dir).filter((n) => n.endsWith(".mjs")).map((n) => path.join(dir, n));
  if (out.length < min) {
    throw new Error(`testFiles() found ${out.length} test module(s), expected at least ${min} — the walk is broken.`);
  }
  return out;
}
