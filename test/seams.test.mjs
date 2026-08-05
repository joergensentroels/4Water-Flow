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

// A different thing that must not appear in source, checked here because this file already walks it: characters
// you cannot see.
//
// `retention.mjs` writes a UTF-8 byte-order mark at the front of the CSV export, deliberately, and the comment
// explaining it said: "`\uFEFF` as an escape, never the literal character: a BOM pasted into source is invisible,
// so a later edit can delete or duplicate it with nothing on screen to show for it." The file then contained
// THREE literal U+FEFF characters and zero escapes — including the one in the template literal the export
// depends on. The rule and its violation were three lines apart, and no reading could have caught it, because
// the thing to notice renders as nothing.
//
// Scanned as characters rather than trusted to review. All four of these are invisible and none has a legitimate
// use in this codebase's source; where the export genuinely needs a BOM it writes the escape, which is ASCII.
const INVISIBLE = [
  { code: 0xfeff, name: "U+FEFF byte-order mark", escape: "\\uFEFF" },
  { code: 0x200b, name: "U+200B zero-width space", escape: "\\u200B" },
  { code: 0x2060, name: "U+2060 word joiner", escape: "\\u2060" },
  { code: 0x00ad, name: "U+00AD soft hyphen", escape: "\\u00AD" },
];

test("no source file contains an invisible character — write the escape instead", () => {
  const bad = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    for (const { code, name, escape } of INVISIBLE) {
      const hits = [...src].filter((c) => c.codePointAt(0) === code).length;
      if (hits) {
        bad.push(`${path.relative(ROOT, file)}: ${hits}× ${name} — write ${escape} so an edit can see it`);
      }
    }
  }
  assert.deepEqual(bad, [], `invisible characters in source:\n  ${bad.join("\n  ")}`);
});

test("and that scan genuinely fires — a BOM built at runtime is caught", () => {
  // Built from a code point so this test file stays free of the thing it forbids, which is the same trick the
  // planted-name test above uses. A scan for something invisible is exactly the kind that can silently look at
  // nothing, so it gets a control.
  const planted = `const x = "a${String.fromCodePoint(0xfeff)}b";`;
  const found = INVISIBLE.filter(({ code }) => [...planted].some((c) => c.codePointAt(0) === code));
  assert.equal(found.length, 1, "the scan must catch a planted BOM");
  assert.equal(found[0].code, 0xfeff);
  // And it must not fire on the escape, which is what source is supposed to contain.
  const innocent = 'const x = "a\\uFEFFb";';
  assert.equal(INVISIBLE.filter(({ code }) => [...innocent].some((c) => c.codePointAt(0) === code)).length, 0,
    "the escape sequence is six ASCII characters and must be legal");
});

// Escaping is the DEFAULT and `raw()` is the documented opt-out, which makes every raw() call site the whole of
// this app's XSS surface. The browser and accessibility passes cannot see this: they measured contrast, target
// size and whether pages render, none of which changes if a volunteer's name arrives unescaped.
//
// Audited by hand first, and every one of the four is a static literal — three `raw(' aria-current="true"')`
// attributes and one hardcoded SVG droplet. Nothing takes user-controlled input. So this test does not fix a
// defect; it holds a property that is currently true and would be silent if broken, which is the same reason the
// seams scanner above exists. `raw(person.name)` would render exactly as well as `${person.name}` right up to the
// first volunteer who puts a bracket in their name.
//
// The other bypass worth naming, and why it is not one: `send()` does not escape a plain string. The routes that
// pass one are /healthz ("ok"), the ICS feed, the JSON exports and the season CSV — each with its own
// Content-Type and, because SECURITY_HEADERS sets `X-Content-Type-Options: nosniff`, no chance of being sniffed
// as HTML. Every HTML response goes through `html`, which escapes.
test("every escaping opt-out is a literal — raw() never receives user input", () => {
  const offenders = [];
  let sites = 0;

  // `src/` ONLY, and that is the right scope rather than a convenience. The claim is about what the application
  // renders into a response; `test/http.test.mjs` passes dynamic values to raw() deliberately, because proving the
  // opt-out works is its job. Scanning tests flagged that, plus this file's own fixtures — the first run reported
  // six offenders and not one was in src/.
  //
  // Worth noting for the next person: assembling a fixture at runtime does NOT hide it from a scanner that reads
  // string contents rather than parsing, which is what this one does. `["raw(", …].join("")` still leaves the text
  // in the file. That trick works against the seams extractor above, which skips comments and reads literals as
  // values, and not against this.
  for (const file of sourceFiles().filter((f) => f.includes(`${path.sep}src${path.sep}`))) {
    if (file.endsWith(`${path.sep}http.mjs`)) continue;      // where raw() is DEFINED, not used
    const src = readFileSync(file, "utf8");
    // Walk to the balanced closing paren so a multi-line SVG argument is read whole.
    for (const m of src.matchAll(/\braw\(/g)) {
      sites++;
      let i = m.index + m[0].length, depth = 1, arg = "";
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) break; }
        arg += c;
        i++;
      }
      const trimmed = arg.trim();
      const quoted = /^["'`]/.test(trimmed);
      // A template literal is fine only if nothing is interpolated into it.
      const interpolated = trimmed.startsWith("`") && trimmed.includes("${");
      if (!quoted || interpolated) {
        offenders.push(`${path.relative(ROOT, file)}: raw(${trimmed.slice(0, 60).replace(/\s+/g, " ")}…)`);
      }
    }
  }

  assert.ok(sites >= 3, `only found ${sites} raw() call sites — this check is not looking properly`);
  assert.deepEqual(offenders, [],
    `raw() bypasses escaping, so its argument must be a literal with nothing interpolated into it:\n  ` +
    `${offenders.join("\n  ")}\n  If you need dynamic markup, build it from html\`\` so the values are escaped.`);
});

test("and that audit fires on an interpolated raw(), which is the case that matters", () => {
  // Assembled at runtime, so this file contains no offending call of its own — the same reason the planted-name
  // and invisible-character tests above build their fixtures rather than writing them.
  const bad = ["raw(", "person.name", ")"].join("");
  const alsoBad = "raw(" + "`<b>${" + "name}</b>`" + ")";
  const good = "raw(' aria-current=\"true\"')";

  const judge = (text) => {
    const m = /\braw\(/.exec(text);
    if (!m) return "no call";
    const arg = text.slice(m.index + m[0].length, text.lastIndexOf(")")).trim();
    if (!/^["'`]/.test(arg)) return "offends";
    return arg.startsWith("`") && arg.includes("${") ? "offends" : "fine";
  };

  assert.equal(judge(bad), "offends", "a bare identifier must be caught");
  assert.equal(judge(alsoBad), "offends", "and so must an interpolated template literal");
  assert.equal(judge(good), "fine", "while a constant attribute is exactly what raw() is for");
});

test("every string the UI asks for exists in the primary locale", () => {
  const da = loadStrings("da");
  const en = loadStrings("en");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(da).sort(), "locale files must cover the same keys");
});

// ---- one environment variable, one reader ---------------------------------------------------------------
//
// The environment IS a seam, and until this existed it was the only one with no gate on it. Two modules reading
// the same variable means two fallbacks, two normalisations and two chances to disagree — and the disagreement is
// invisible from inside either module, because each one is self-consistent.
//
// It had already happened twice. FOURWATER_BASE_URL was read at three sites with three copies of
// `String(env.X || "").replace()` and no validation anywhere, which is also why increment AI went looking for a
// variable that did not exist rather than finding the one that did. And FOURWATER_DB resolved to <cwd>/4water.db
// in src/db.mjs but <ROOT>/4water.db in tools/backup.mjs — so an app started from any other directory wrote one
// database while its backup dutifully copied another, and reported success.
//
// Derived, not a list of forbidden duplicates: a hand-kept list cannot fail for a variable nobody thought of.
// Every multi-reader needs an entry here, and the entry is a sentence about why sharing is safe.
const SHARED_ENV_JUSTIFIED = {
  // Two different questions, deliberately. server.mjs decides whether dev sign-in is permitted at all (and adds
  // NODE_ENV !== "production" to that decision); auth.mjs re-asserts it inside the provider, so constructing the
  // dev provider directly cannot bypass the decision. Defence in depth, not a shared fallback — neither has one.
  FOURWATER_AUTH: "src/server.mjs decides, src/auth.mjs re-asserts; no default on either side",
  // demo.mjs never opens anything with these — it echoes the value back in the command line it prints, and its
  // own defaults are demo.db and demo-pattern.json on purpose, so a demo cannot land on the real database.
  FOURWATER_DB: "src/db.mjs resolves via dbFileFor; tools/demo.mjs only echoes it in printed instructions",
  FOURWATER_PATTERN: "src/config.mjs resolves via patternFileFor; tools/demo.mjs only echoes it",
};

test("no environment variable is read from two modules without a recorded reason", () => {
  const readers = new Map();
  for (const file of sourceFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (rel.startsWith("test/")) continue;              // tests set env deliberately; they are not the deployment
    for (const m of readFileSync(file, "utf8")
      .matchAll(/(?:env|process\.env)[.[]"?(FOURWATER_\w+|OIDC_\w+|MATTERMOST_\w+|NEXTCLOUD_\w+)"?\]?/g)) {
      if (!readers.has(m[1])) readers.set(m[1], new Set());
      readers.get(m[1]).add(rel);
    }
  }

  // Controls, because "0 unjustified" from a collector that found nothing reads exactly like a clean codebase.
  assert.ok(readers.size >= 10, `only ${readers.size} environment variables found — the collector is not reading`);
  assert.ok(readers.get("FOURWATER_SECRET")?.size >= 1, "the collector cannot see FOURWATER_SECRET");
  assert.ok([...readers.values()].some((s) => s.size > 1),
    "no variable has multiple readers at all — either the codebase converged completely, in which case delete " +
    "SHARED_ENV_JUSTIFIED, or this collector is grouping by the wrong key and can never fail");

  const shared = [...readers].filter(([, files]) => files.size > 1);
  const unjustified = shared
    .filter(([name]) => !SHARED_ENV_JUSTIFIED[name])
    .map(([name, files]) => `${name} <- ${[...files].sort().join(", ")}`);
  assert.deepEqual(unjustified, [],
    "these environment variables are read from more than one module and nothing says why that is safe. Each " +
    "reader carries its own fallback, and two fallbacks for one variable drift silently — the app and its backup " +
    "disagreed about which file was the database for exactly this reason. Resolve it once in src/config.mjs, or " +
    "add an entry to SHARED_ENV_JUSTIFIED saying why sharing is correct here:\n  " + unjustified.join("\n  "));

  // And every justification must describe something real. An entry for a variable that has since converged is a
  // stale exemption, and a stale exemption is how the next duplicate gets waved through.
  const stale = Object.keys(SHARED_ENV_JUSTIFIED).filter((name) => (readers.get(name)?.size ?? 0) < 2);
  assert.deepEqual(stale, [],
    `SHARED_ENV_JUSTIFIED exempts these and they no longer have two readers. Delete the entries:\n  ${stale.join("\n  ")}`);
});
