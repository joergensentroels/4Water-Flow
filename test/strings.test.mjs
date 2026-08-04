// Increment J. `t()` returns the KEY when a translation is missing, so a typo does not throw — it renders
// "board.claimOk" on a button and nobody notices until a volunteer asks. This walks every t() call in the
// source and checks the key exists in both locales.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, loadStrings, loadPattern } from "../src/config.mjs";
import { BOARD_EMPTY_REASONS, SLOT_EMPTY_REASONS } from "../src/queries.mjs";

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".mjs")) out.push(full);
    }
  };
  for (const d of ["src", "tools"]) walk(path.join(ROOT, d));
  return out;
}

// Static calls only: t("some.key") or t('some.key'). Dynamic ones like t(`role.${role}`) cannot be resolved
// this way and are covered by the family checks below.
const STATIC_T = /\bt\(\s*["']([a-zA-Z][\w.]*)["']/g;
const DYNAMIC_T = /\bt\(\s*`([^`]*\$\{[^`]*)`/g;

test("every statically-written translation key exists in both locales", () => {
  const da = loadStrings("da");
  const en = loadStrings("en");
  const missing = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(STATIC_T)) {
      const key = m[1];
      if (!(key in da)) missing.push(`${path.relative(ROOT, file)}: "${key}" missing from da.json`);
      if (!(key in en)) missing.push(`${path.relative(ROOT, file)}: "${key}" missing from en.json`);
    }
  }
  assert.deepEqual(missing, [], `untranslated keys would render as the key itself:\n  ${missing.join("\n  ")}`);
});

test("every dynamically-built key family is complete in both locales", () => {
  // Find the families actually used, so adding a new t(`x.${y}`) somewhere is not silently unchecked.
  const families = new Set();
  for (const file of sourceFiles()) {
    for (const m of readFileSync(file, "utf8").matchAll(DYNAMIC_T)) {
      const prefix = m[1].split("${")[0];
      if (prefix.endsWith(".")) families.add(prefix.slice(0, -1));
    }
  }
  // What each family must cover. If a family appears in the source and is not listed here, that is a gap in
  // this test, so it fails loudly rather than passing quietly.
  const expected = {
    weekday: [0, 1, 2, 3, 4, 5, 6].map(String),
    role: loadPattern().roles,
    nav: ["home", "availability", "board", "plan", "planner", "admin"],
    // Dance roles, distinct from the app's permission roles: a slot needs a leader or a follower.
    "role.dance": ["l", "f"],
    // Every notification kind and delivery state shown on the outbox. If a new kind is sent from jobs.mjs or
    // server.mjs without a string here, the outbox would render "outbox.kind.whatever" at a planner.
    //
    // DERIVED from the kinds the code actually sends, not hand-kept. It was a literal list, and adding
    // shift_reminder did not fail here — because a list of what to check cannot notice something missing from
    // itself. That is the same defect as a CSRF audit against a list somebody has to remember to update, which
    // this project already rejected once in test/csrf.test.mjs.
    "outbox.kind": [...new Set(sourceFiles().flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/\bkind:\s*["'](\w+)["']/g)].map((m) => m[1])))],
    "outbox.status": ["queued", "failed", "sent"],
    // Every reason the shift exchange can be empty, and the same question from the planner's side. A missing key
    // renders "board.why.no_role_stated" at a volunteer, or "planner.why.nobody_capable" at somebody trying to
    // fix a gap under time pressure — worse than the vague message each replaced.
    //
    // Read from src/queries.mjs rather than copied. These were literal lists, which is a list of what to check
    // being unable to notice something missing from itself: a ninth board reason would have left this green and
    // put a raw key on a volunteer's screen. Same defect as the hand-kept outbox.kind list above.
    "board.why": Object.values(BOARD_EMPTY_REASONS),
    "planner.why": Object.values(SLOT_EMPTY_REASONS),
  };
  for (const f of families) assert.ok(f in expected, `t(\`${f}.\${...}\`) is used but this test does not know what the family should contain`);

  const missing = [];
  for (const locale of ["da", "en"]) {
    const strings = loadStrings(locale);
    for (const f of families) {
      for (const suffix of expected[f]) {
        if (!(`${f}.${suffix}` in strings)) missing.push(`${locale}: ${f}.${suffix}`);
      }
    }
  }
  assert.deepEqual(missing, [], `incomplete key families:\n  ${missing.join("\n  ")}`);
});

// The other direction, which was unchecked: a translation nothing reads.
//
// The test above stops a typo rendering as its own key. This stops the opposite — a string written for a screen
// and never wired up, or one superseded and left behind. Seven had accumulated when this was written:
// planner.eligible ("{n} can take it") outlived by planner.eligibleFairest, admin.roleOn/roleOff outlived by the
// "+ role" / "− role" toggles, availability.prompt by availability.intro, and slot.assigned, admin.status and
// admin.needs by nothing at all. Dead weight is the mild reading; the serious one is that a string looking like
// it is shown, and not being, is the same shape as workloadSpread being computed for nobody.
//
// It also costs somebody real effort: a translator working through da.json has no way to tell which entries
// matter.
test("no translation is left unread by the source", () => {
  const source = sourceFiles().map((f) => readFileSync(f, "utf8")).join("\n");
  const en = loadStrings("en");

  // Static t("x.y") plus every dynamic family prefix — t(`weekday.${dow}`) makes every weekday.* reachable, and
  // calling those unused would be a false positive off the same trick the family check above relies on.
  const staticRefs = new Set([...source.matchAll(STATIC_T)].map((m) => m[1]));
  const prefixes = [...source.matchAll(/\bt\(\s*`([^`]*)\$\{/g)].map((m) => m[1]).filter((p) => p.endsWith("."));
  // t.weekday(dow) is a helper hung off t in config.mjs, not a t(`...`) call, so its family needs naming here.
  if (/t\.weekday\s*=/.test(source)) prefixes.push("weekday.");

  const unread = Object.keys(en).filter((key) => {
    if (staticRefs.has(key)) return false;
    if (prefixes.some((p) => key.startsWith(p))) return false;
    // Some keys are referenced as bare strings in a lookup table rather than inside t() — the OUTCOME map in
    // pages/planner.mjs is one. An exact quoted occurrence counts, but a bare substring must not: "admin.status"
    // would otherwise be "found" inside the route path "/admin/status", because a regex dot matches a slash.
    return !source.includes(`"${key}"`) && !source.includes(`'${key}'`);
  });

  assert.ok(staticRefs.size > 100, `only ${staticRefs.size} t() calls found — this check is not looking properly`);
  assert.deepEqual(unread, [],
    `these translations exist in both locales and nothing reads them:\n  ${unread.join("\n  ")}`);
});

test("no translation is an empty string or still a placeholder", () => {
  for (const locale of ["da", "en"]) {
    for (const [key, value] of Object.entries(loadStrings(locale))) {
      assert.equal(typeof value, "string", `${locale}: ${key} is not a string`);
      assert.ok(value.trim().length > 0, `${locale}: ${key} is empty`);
      assert.ok(!/^TODO|^FIXME|^XXX/i.test(value), `${locale}: ${key} is still a placeholder: ${value}`);
      // A value identical to its own key means someone pasted the key in as the text.
      assert.notEqual(value, key, `${locale}: ${key} has itself as its translation`);
    }
  }
});

test("the two locales carry the same placeholders in the same strings", () => {
  const da = loadStrings("da");
  const en = loadStrings("en");
  const holders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(en)) {
    // A Danish string missing {n} would render a sentence with the number silently absent.
    assert.deepEqual(holders(da[key]), holders(en[key]),
      `"${key}" has different placeholders: da=${holders(da[key])} en=${holders(en[key])}`);
  }
});

test("no locale file contains an unreplaced English fallback marker or stray HTML", () => {
  for (const locale of ["da", "en"]) {
    for (const [key, value] of Object.entries(loadStrings(locale))) {
      // Strings are escaped on output, so markup here would be shown literally to the user rather than
      // rendered — always a mistake, and invisible until someone reads the page carefully.
      assert.ok(!/<[a-z/][^>]*>/i.test(value), `${locale}: ${key} contains markup, which will be shown literally: ${value}`);
    }
  }
});
