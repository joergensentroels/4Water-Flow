// A pattern file whose season contains today, written wherever the caller asks.
//
// Three tests that boot the real server needed one, and all three reached for `demo-pattern.json` in the
// repository root — a file `.gitignore` excludes, because tools/demo.mjs generates it. So all three failed with
// ENOENT on a fresh clone, including test/journey.test.mjs, the acceptance gate written precisely because a
// green suite twice reported success over a deployment that could not work. Nobody noticed because this repo has
// no remote yet: CI has never executed once, and there has never been a clone.
//
// This is NOT the world-building harness. test/journey.test.mjs deliberately touches tools/testkit.mjs nowhere,
// because twice that harness supplied setup production skipped and the tests passed over a broken deployment.
// The rule this respects is that nothing may hand the app state a real deployment would not have. A pattern
// file is the one thing an operator DOES hand it — `FOURWATER_PATTERN` is a documented setting — so writing one
// is standing in for the operator, not for the application.
//
// Dates are computed from the current date rather than fixed. A fixed season rots: the shipped one ends in June
// and produced a silently empty planner horizon more than once during this project, which is a test passing for
// no reason.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function writeSeasonSpanningToday(file, { key = "fixture", before = 30, after = 120, today = null } = {}) {
  const now = today ?? new Date().toISOString().slice(0, 10);
  // Raw JSON in, raw JSON out. Going through loadPattern and back would re-serialise a VALIDATED object, and
  // nothing guarantees that round-trips into a loadable file — the activities, weekly rhythm and roles are
  // copied verbatim from the committed config so no activity name, weekday or clock time appears here either.
  const raw = JSON.parse(readFileSync(path.join(ROOT, "config", "pattern.json"), "utf8"));
  raw.season = { ...raw.season, key, from: addDays(now, -before), to: addDays(now, after) };
  writeFileSync(file, JSON.stringify(raw, null, 2));
  return { file, from: raw.season.from, to: raw.season.to, key };
}
