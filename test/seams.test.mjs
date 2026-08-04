// DoD 6: the gate that keeps one department's vocabulary out of the code. Without an enforcing test,
// "don't hardcode Copenhagen" is an aspiration that decays quietly over a few slices and is discovered
// the day someone asks for a French instance.
//
// It scans STRING LITERALS ONLY, not whole files. That is the actual risk model: a literal can reach a
// user's screen, a comment cannot — and scanning comments too would forbid writing "0 = Sunday" next to
// the column that means exactly that, which makes the code worse to read for no safety gain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, loadPattern, loadStrings } from "../src/config.mjs";

const SCAN_DIRS = ["src", "test", "tools"];   // tools/ holds real code too, so it is not exempt from the rule
const EXEMPT = ["config", "strings"];      // the seams themselves are where these names belong

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!EXEMPT.includes(name)) walk(full);
      } else if (name.endsWith(".mjs")) out.push(full);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  return out;
}

// Extract string literals with a single-pass scanner rather than a regex. A regex cannot tell a quote
// inside a // comment from a real literal, and the first version of this gate reported three offences that
// were all prose in comments. The rule is only as good as the extractor, so this part has to be exact.
// Known limitation: a regex literal containing a quote character (/'/), which this codebase does not use,
// would be misread as the start of a string.
function literalsIn(src) {
  const out = [];
  for (let i = 0, n = src.length; i < n; ) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let buf = "";
      i++;
      while (i < n) {
        if (src[i] === "\\") { buf += src[i + 1] ?? ""; i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        buf += src[i++];
      }
      out.push(buf);
      continue;
    }
    i++;
  }
  return out;
}

// Activity labels are matched case-SENSITIVELY, because the lowercase `key` (e.g. the value in
// pattern.json's "key" field) is a legitimate shared identifier that also appears in config. It is the
// human-readable label that must never be baked in. Weekday names are matched case-insensitively as whole
// words, since no legitimate identifier here is a weekday.
function forbiddenNames() {
  const pattern = loadPattern();
  const labels = pattern.activities.map((a) => a.label);
  const weekdays = [];
  for (const locale of ["da", "en"]) {
    const s = loadStrings(locale);
    for (let d = 0; d <= 6; d++) if (s[`weekday.${d}`]) weekdays.push(s[`weekday.${d}`]);
  }
  return { labels, weekdays };
}

function offences(literals, { labels, weekdays }) {
  const found = [];
  for (const lit of literals) {
    for (const label of labels) if (lit.includes(label)) found.push({ lit, name: label });
    for (const day of weekdays) {
      if (new RegExp(`\\b${day.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "iu").test(lit)) found.push({ lit, name: day });
    }
  }
  return found;
}

test("DoD 6 — no activity label or weekday name appears in a string literal under src/ or test/", () => {
  const names = forbiddenNames();
  const bad = [];
  for (const file of sourceFiles()) {
    for (const o of offences(literalsIn(readFileSync(file, "utf8")), names)) {
      bad.push(`${path.relative(ROOT, file)}: "${o.lit.slice(0, 60)}" contains "${o.name}"`);
    }
  }
  assert.deepEqual(bad, [], `hardcoded department vocabulary:\n  ${bad.join("\n  ")}`);
});

test("DoD 6 — and the gate genuinely fails when a name IS planted", () => {
  const names = forbiddenNames();
  // Built at runtime from config so this test file contains no forbidden literal of its own.
  const label = names.labels[0];
  const day = names.weekdays[0];

  const plantedLabel = `const heading = ${JSON.stringify(`Tonight: ${label}`)};`;
  assert.equal(offences(literalsIn(plantedLabel), names).length, 1, "a planted activity label must be caught");

  const plantedDay = `const when = ${JSON.stringify(`every ${day} at 19:00`)};`;
  assert.equal(offences(literalsIn(plantedDay), names).length, 1, "a planted weekday name must be caught");

  // And it must not fire on the legitimate cases: a translation key, or the lowercase activity key.
  const innocent = `t("weekday.3"); const k = ${JSON.stringify(loadPattern().activities[0].key)};`;
  assert.deepEqual(offences(literalsIn(innocent), names), [], "translation keys and activity keys are legal");
});

test("every string the UI asks for exists in the primary locale", () => {
  const da = loadStrings("da");
  const en = loadStrings("en");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(da).sort(), "locale files must cover the same keys");
});
