// Increment J. `t()` returns the KEY when a translation is missing, so a typo does not throw — it renders
// "board.claimOk" on a button and nobody notices until a volunteer asks. This walks every t() call in the
// source and checks the key exists in both locales.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, loadStrings, loadPattern, makeT } from "../src/config.mjs";
import { BOARD_EMPTY_REASONS, SLOT_EMPTY_REASONS } from "../src/queries.mjs";
// 2023 rather than a current year on purpose: it is the last year with Store bededag, so the DK table's
// year-dependent entry is covered. A table read at 2026 would leave `holiday.prayerDay` unchecked while the
// app can still show it for an archived season.
import { COUNTRIES } from "../src/holidays.mjs";

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
    // Every action the audit log can record, READ FROM THE CALL SITES rather than listed. A new logAudit(...) with
    // no string here would put `audit.action.admin.whatever` on the change-log page — and that page is read by
    // somebody trying to answer a question about a person, which is the worst moment to show them a raw key.
    //
    // Note the nested dots: the family prefix is `audit.action` and the suffix is `planner.assign`, so the suffix
    // itself contains a dot. That is why this reads whole action names out of the source instead of splitting keys.
    "audit.action": [...new Set(sourceFiles().flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/\blogAudit\(\s*\w+\s*,\s*["']([\w.]+)["']/g)].map((m) => m[1])))],
    // Every public-holiday name any country table can produce, READ FROM THE TABLES. A holiday with no string
    // renders "holiday.assumption" on the Administration screen beside a button that deletes or creates real
    // classes — and adding France was one line of table, which is exactly the kind of change that forgets a
    // string. `extra` is included because src/holidays.mjs labels a board's own closing day with it.
    holiday: [...new Set([...Object.values(COUNTRIES).flatMap((f) => f(2023).map(([, key]) => key)), "extra"])],
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

  const isRead = (key) => {
    if (staticRefs.has(key)) return true;
    if (prefixes.some((p) => key.startsWith(p))) return true;
    // Some keys are referenced as bare strings in a lookup table rather than inside t() — the OUTCOME map in
    // pages/planner.mjs is one. An exact quoted occurrence counts, but a bare substring must not: "admin.status"
    // would otherwise be "found" inside the route path "/admin/status", because a regex dot matches a slash.
    return source.includes(`"${key}"`) || source.includes(`'${key}'`);
  };
  // `<key>.one` is chosen by makeT when n is 1 and is never written at a call site, so it is read exactly when its
  // plural is — via ANY of the mechanisms above, which is why this recurses rather than checking staticRefs alone.
  // The first version did check staticRefs alone and reported five singulars as dead weight: their plurals are
  // named in an OUTCOME table, not in a t() call, so the exemption missed exactly the strings it was written for.
  const unread = Object.keys(en).filter((key) =>
    !isRead(key) && !(key.endsWith(".one") && isRead(key.slice(0, -4))));

  assert.ok(staticRefs.size > 100, `only ${staticRefs.size} t() calls found — this check is not looking properly`);
  assert.deepEqual(unread, [],
    `these translations exist in both locales and nothing reads them:\n  ${unread.join("\n  ")}`);
});

// The fallback path inside makeT, which a coverage run showed had never executed — every key exists in both
// locales, which the two tests above guarantee, so the `else` branch was unreachable by construction.
//
// It is still load-bearing: it is what stops a missing key from throwing at a volunteer mid-form. The design is
// deliberate and worth pinning — fall back to English, and if English lacks it too, render the KEY rather than
// blank or `undefined`, because a visible "board.claimOk" is a bug report and an empty button is a mystery.
test("a key missing from a locale falls back to English, and a key missing from both renders as itself", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-t-"));
  try {
    // A tiny locale pair, so this exercises makeT's own logic rather than the shipped files.
    writeFileSync(path.join(dir, "en.json"), JSON.stringify({ "a.only": "English only", "a.both": "English" }));
    writeFileSync(path.join(dir, "da.json"), JSON.stringify({ "a.both": "Dansk" }));

    const da = makeT("da", dir);
    assert.equal(da("a.both"), "Dansk", "the locale wins when it has the key");
    assert.equal(da("a.only"), "English only", "a gap falls back to English rather than breaking the page");
    assert.equal(da("a.missing"), "a.missing",
      "absent from both renders the key — visible enough to be reported, unlike an empty string");

    // Placeholders still substitute on the fallback, or a fallen-back sentence would show raw {braces}.
    writeFileSync(path.join(dir, "en.json"), JSON.stringify({ "a.count": "{n} of {of}" }));
    writeFileSync(path.join(dir, "da.json"), JSON.stringify({}));
    assert.equal(makeT("da", dir)("a.count", { n: 2, of: 3 }), "2 of 3");
    // An unknown placeholder is left visible rather than blanked — same reasoning as rendering the key.
    assert.equal(makeT("da", dir)("a.count", { n: 2 }), "2 of {of}");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

// Equal placeholders do not make two strings say the same thing, and most of the difference is a matter of language
// that no test should have an opinion about. Part of it is not: a number, a path and an environment variable are
// facts about the CODE, so both locales have to agree about them. "kept for 24 hours" against "beholdes i 48 timer"
// means one of them is wrong, and nothing here would have noticed.
//
// Nothing was wrong when this was written — 268 strings compared, zero divergences. It exists because editing one
// locale and forgetting the other is the ordinary way a number goes stale, and because the check costs nothing.
test("the two locales agree about numbers, paths and environment variables", () => {
  const da = loadStrings("da");
  const en = loadStrings("en");
  // Sorted, because word order differs between the languages and only the SET of facts has to match. Placeholders
  // are blanked first: {n} is a number at runtime, not in the string.
  const numbers = (s) => (s.replace(/\{\w+\}/g, " ").match(/\b\d+(?:[.,]\d+)?\b/g) ?? []).sort();
  const paths = (s) => (s.match(/\/[a-z][\w./-]*/gi) ?? []).map((p) => p.replace(/[.,)]$/, "")).sort();
  const idents = (s) => (s.match(/\b(?:FOURWATER|OIDC|MATTERMOST)_[A-Z_]+\b/g) ?? []).sort();

  // Each extractor is shown capable of failing here, because a clean sweep and a broken extractor read identically
  // — and one shown NOT to cry wolf, because a check that reports every string is as useless as one that reports none.
  assert.notDeepEqual(numbers("kept for 24 hours"), numbers("beholdes i 48 timer"), "the number extractor is blind");
  assert.notDeepEqual(paths("go to /me"), paths("gå til /mig"), "the path extractor is blind");
  assert.notDeepEqual(idents("set FOURWATER_SECRET"), idents("sæt FOURWATER_SECRETS"), "the variable extractor is blind");
  assert.deepEqual(numbers("after 2 seasons"), numbers("efter 2 sæsoner"), "the same number in two languages must not be reported");

  // The one family where a number is part of a NAME rather than a claim about the app. Danish names most of the
  // Easter and Christmas feasts by ordinal — "2. påskedag" is Easter Monday, "1. juledag" is Christmas Day — so
  // this check reported five holiday names as locale disagreements. They are not: the number is the word.
  //
  // Exempted by PREFIX and no wider, because the check's stated purpose is catching a translation that is "wrong
  // about the app", and a retention period or a port number in the wrong locale is exactly that. The assertion
  // below keeps the exemption honest: it must not swallow a genuine mismatch inside the family.
  const nameOnly = (key) => key.startsWith("holiday.");
  assert.notDeepEqual(numbers("kept for 2 seasons"), numbers("beholdes i 3 sæsoner"),
    "the exemption must be by key prefix only — the extractor still has to work on holiday-adjacent strings");

  for (const key of Object.keys(en)) {
    if (typeof en[key] !== "string" || typeof da[key] !== "string") continue;
    if (nameOnly(key)) continue;
    for (const [what, fn] of [["numbers", numbers], ["paths", paths], ["variables", idents]]) {
      assert.deepEqual(fn(da[key]), fn(en[key]),
        `"${key}" states different ${what} in the two locales — one of them is wrong about the app:\n` +
        `  en: ${en[key]}\n  da: ${da[key]}`);
    }
  }
});

// ONE is a different sentence. Every count string in this app said "1 proposals locked in as final", "1 dates
// updated", "1 messages could not be sent" — twenty-nine strings interpolating {n}, about eighteen of which read
// wrong at exactly the number a volunteer administrator sees most often, because most of these events happen once.
//
// The keys where a bare number is genuinely fine, each with the reason. Written out rather than pattern-matched:
// whether "1 of 12 slots are unfilled" reads correctly is a judgement about English and Danish, not something a
// regex can settle. An unlisted count string with no singular fails, which is the whole point.
const NUMBER_INVARIANT = {
  "planner.toMark": "the number trails the noun — 'Shifts that have happened and are not marked: 1' is correct.",
  "planner.reviewAttended": "'turned up to 1 so far' — the count is the object, and it does not inflect.",
  // No weekday name in the example: the seams gate forbids them in string literals under src/ and test/, and it
  // caught this line. The string itself interpolates {day} from the weekday.* family, which is the point.
  "planner.reviewSameDay": "'1 of 12 on a {day}' — an n-of-N ratio, correct at any n in both languages.",
  "admin.showN": "'Show 1' is a button label with a bare quantity and no noun to agree with.",
  "audit.intro": "'…newest first. 1 in total.' — the number trails, deliberately reworded so it reads at one.",
  "profile.attended": "'Recorded as having turned up: 1 this season' — the number trails the colon.",
  "profile.answered": "'You have answered 1 of 60 dates this season' — the plural belongs to the 60, not the 1.",
  "status.gaps": "'1 of 20 slots in the next month are unfilled' — the noun agrees with the total, not the count.",
  "status.silent": "'1 of 12 active volunteers have not answered' — same n-of-N shape.",
  "status.silentMore": "'And 1 more.' — the noun is elided entirely, so there is nothing for it to agree with.",
  "outbox.all": "'Everything (1)' — a filter chip carrying a bare count in brackets.",
};

test("every count string has a singular form, or is declared invariant", () => {
  const en = loadStrings("en");
  const da = loadStrings("da");
  const counted = Object.keys(en).filter((k) => !k.endsWith(".one") && /\{n\}/.test(en[k]));
  assert.ok(counted.length >= 20, `only ${counted.length} strings interpolate {n} — this check is not looking`);

  const missing = counted.filter((k) => !(`${k}.one` in en) && !(k in NUMBER_INVARIANT));
  assert.deepEqual(missing, [],
    "these strings put {n} in front of a plural noun and have no singular form, so they will read '1 proposals' " +
    "on the screen after somebody's own click. Add `<key>.one`, reword so the number trails the noun, or add it " +
    "to NUMBER_INVARIANT with the reason:\n  " + missing.join("\n  "));

  // BOTH locales, because the fallback inside makeT deliberately prefers the Danish plural over the English
  // singular — right for a page nobody should read half in another language, and it means a missing da.one is
  // invisible at runtime rather than loud.
  const daMissing = counted.filter((k) => `${k}.one` in en && !(`${k}.one` in da));
  assert.deepEqual(daMissing, [], `these have an English singular and no Danish one:\n  ${daMissing.join("\n  ")}`);

  // Both directions: an invariant entry for a string that no longer counts anything, or that has since grown a
  // singular, is a decision about a file that has changed.
  const stale = Object.keys(NUMBER_INVARIANT).filter((k) => !counted.includes(k));
  assert.deepEqual(stale, [], `declared invariant but no longer a count string — remove: ${stale}`);
  const both = Object.keys(NUMBER_INVARIANT).filter((k) => `${k}.one` in en);
  assert.deepEqual(both, [], `declared invariant AND given a singular — decide which: ${both}`);

  for (const [k, why] of Object.entries(NUMBER_INVARIANT)) {
    assert.ok(why.length >= 40, `${k}: say why a bare number reads correctly there, not just that it does`);
  }
});

test("makeT picks the singular at exactly one, in the reader's own language", () => {
  for (const locale of ["en", "da"]) {
    const t = makeT(locale);
    const strings = loadStrings(locale);
    assert.notEqual(t("planner.locked", { n: 1 }), t("planner.locked", { n: 2 }).replace("2", "1"),
      `${locale}: n=1 must select a different sentence, not the plural with a 1 in it`);
    assert.equal(t("planner.locked", { n: 1 }), strings["planner.locked.one"].replace("{n}", "1"),
      `${locale}: n=1 must use this locale's own singular`);
    assert.equal(t("planner.locked", { n: 3 }), strings["planner.locked"].replace("{n}", "3"));

    // 0 is plural in both languages, and so is a string with no n at all.
    assert.equal(t("planner.locked", { n: 0 }), strings["planner.locked"].replace("{n}", "0"));
    assert.equal(t("planner.toMark", { n: 1 }), strings["planner.toMark"].replace("{n}", "1"),
      "an invariant string must not be affected by the plural machinery");
  }

  // The fallback stays in the reader's language: a key with a Danish plural and no Danish singular resolves to the
  // Danish plural rather than the English singular. Checked with a temporary locale directory so the real files
  // keep their complete pairs.
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-plural-"));
  try {
    writeFileSync(path.join(dir, "en.json"), JSON.stringify({ "x.count": "{n} things", "x.count.one": "one thing" }));
    writeFileSync(path.join(dir, "da.json"), JSON.stringify({ "x.count": "{n} ting" }));
    const t = makeT("da", dir);
    assert.equal(t("x.count", { n: 1 }), "1 ting",
      "a missing Danish singular must fall back to the Danish plural, never to the English singular");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// One concept, one Danish word. A translator — or me, six months from now — rendering `shift` as "tjans" in one
// string and "vagt" in the next costs a volunteer more than a clumsy sentence does: they stop being sure the two
// screens are talking about the same thing.
//
// Checked from the ENGLISH side, which is the only side where the concept is unambiguous. Two of the mappings are
// deliberately one-to-many and that is the interesting part: `slot` is **vagt** when it means a shift to be filled
// and **tidsrum** when it means a place in the weekly rhythm, and English uses one word for both.
//
// Both sides are stripped of placeholders and dotted identifiers first. Without that, `{activity}` counts as the
// English word "activity" and `holidays.country` as "holidays", and the check demands a Danish rendering of
// something that was never prose — which is exactly what the first version of this did, on five keys.
const GLOSSARY = {
  shift: ["vagt"],
  shifts: ["vagt"],
  slot: ["vagt", "plads", "tidsrum"],
  slots: ["vagt", "plads", "tidsrum"],
  session: ["mødegang", "vagt"],
  sessions: ["mødegang", "vagt"],
  calendar: ["kalender"],
  plan: ["plan"],
  season: ["sæson"],
  planner: ["planlægger"],
  volunteer: ["frivillig"],
  availability: ["tilgængelighed"],
  activity: ["aktivitet"],
  activities: ["aktiviteter"],
  holiday: ["helligdag", "lukket"],
  exchange: ["børs"],
  session: ["mødegang", "vagt"],
  proposal: ["forslag"],
  proposals: ["forslag"],
  administrator: ["administrator"],
  invitation: ["invitation"],
  // Two senses, and both are real: a permission role (planner/admin/volunteer) and a dance role (leader/follower).
  // Danish uses "rolle" for both, which is why one entry covers it — the ambiguity is in English, not the Danish.
  role: ["rolle", "fører", "følger"],
  note: ["note"],
  notes: ["note"],
  // TWO SENSES, and the check found the second one: "Details" is the link from the plan to a shift's own page
  // (**detaljer**), and "your details" / "contact details" is somebody's personal information (**oplysninger**).
  // English overloads the word and Danish does not, which is the same shape as `slot` being vagt or tidsrum — so
  // both renderings are listed rather than the Danish being called drift for being right.
  detail: ["detalj", "oplysning"],
  details: ["detalj", "oplysning"],
};
// English words common in the strings that name no domain concept, so no Danish rendering is prescribed. Listed so
// the coverage check below can insist the glossary knows about every frequent noun, rather than quietly skipping
// the ones nobody thought of.
const NOT_DOMAIN = new Set(["the", "and", "you", "your", "that", "this", "for", "are", "have", "has", "not", "can",
  "will", "with", "from", "they", "them", "their", "was", "were", "been", "which", "what", "when", "who", "why",
  "how", "there", "here", "one", "all", "any", "some", "more", "most", "than", "then", "but", "because", "into",
  "out", "off", "still", "yet", "does", "did", "just", "only", "also", "already", "again", "back", "now", "date",
  "dates", "day", "days", "time", "times", "week", "weeks", "month", "somebody", "nobody", "everybody", "people",
  "person", "name", "email", "page", "screen", "list", "message", "messages", "link", "log", "data", "under",
  "about", "answer", "answered", "ask", "add", "added", "remove", "removed", "change", "changed", "make", "made",
  "take", "taken", "takes", "run", "runs", "set", "see", "show", "shown", "showing", "read", "keep", "kept",
  "since", "before", "after", "first", "next", "last", "own", "same", "other", "each", "every", "few", "many",
  "something", "nothing", "anything", "yours", "ours", "app", "chat", "status", "version", "total", "number",
  // Ordinary verbs and adjectives that carry no concept of their own. `open` is the one worth naming: it is an
  // adjective about a slot ("ledig") and never a noun in this app, so prescribing a word for it would be wrong.
  "open", "could", "else", "created", "address", "sent", "exist", "look", "cannot", "write", "written"]);

const proseOnly = (s) => s
  .replace(/\{[^}]*\}/g, " ")
  .replace(/\b[\w-]+(?:\.[\w-]+)+\b/g, " ")
  .replace(/\b[A-Z][A-Z_]{2,}\b/g, " ");

test("one concept, one Danish word", () => {
  const en = loadStrings("en");
  const da = loadStrings("da");
  const drift = [];
  let checked = 0;

  for (const [term, allowed] of Object.entries(GLOSSARY)) {
    const re = new RegExp(`\\b${term}\\b`, "i");
    for (const key of Object.keys(en)) {
      if (typeof en[key] !== "string" || typeof da[key] !== "string") continue;
      if (!re.test(proseOnly(en[key]))) continue;
      checked++;
      const danish = proseOnly(da[key]).toLowerCase();
      if (!allowed.some((word) => danish.includes(word))) drift.push(`${key} (${term}): ${da[key]}`);
    }
  }
  assert.ok(checked >= 100, `only ${checked} term occurrences checked — the glossary or the matcher is not working`);
  assert.deepEqual(drift, [],
    "these Danish strings render an English domain term as something the glossary does not list. Either the Danish " +
    "has drifted from the word used everywhere else, or the concept legitimately has a second rendering and the " +
    "glossary should say so:\n  " + drift.join("\n  "));

  // The control: a string with no Danish term in it must NOT satisfy the matcher, or "no drift" means nothing.
  // No weekday name in the example — the seams gate forbids them in string literals and caught the first version
  // of this line, which is the fourth time it has caught me reaching for a day of the week as an illustration.
  const bogus = proseOnly("A shift nobody has taken").toLowerCase();
  assert.ok(!GLOSSARY.shift.some((w) => bogus.includes(w)), "the matcher accepts a string with no Danish term in it");
});

// The glossary is hand-written, so this is what stops it silently covering less than it appears to: every English
// word used often enough to be a domain term must be either IN the glossary or declared not-domain. A new concept
// added to the app fails here until somebody decides what it is called in Danish.
test("the glossary knows about every frequent word in the English strings", () => {
  const en = loadStrings("en");
  // Counted as LEMMAS, not tokens. The first version counted "volunteer" (7) and "volunteers" (5) separately, so
  // both fell under the threshold and `volunteer` could be dropped from the glossary without anything noticing —
  // which the control caught. Crude singular-stripping is enough here: the question is only whether a word is
  // frequent enough to be a concept.
  const lemma = (w) => w.replace(/s$/, "");
  const counts = new Map();
  for (const v of Object.values(en)) {
    if (typeof v !== "string") continue;
    for (const w of (proseOnly(v).toLowerCase().match(/[a-z]{3,}/g) ?? [])) {
      counts.set(lemma(w), (counts.get(lemma(w)) ?? 0) + 1);
    }
  }
  const frequent = [...counts].filter(([, n]) => n >= 8).map(([w]) => w);
  assert.ok(frequent.length >= 20, `only ${frequent.length} frequent words — the counter is not working`);

  const known = new Set([...Object.keys(GLOSSARY), ...NOT_DOMAIN].map(lemma));
  const unclassified = frequent.filter((w) => !known.has(w));
  assert.deepEqual(unclassified, [],
    "these words appear eight or more times in the English strings and the glossary has no opinion about them. If " +
    "one names a domain concept, add it with its Danish; if not, add it to NOT_DOMAIN. A glossary that does not " +
    "know about a frequent word cannot notice it drifting:\n  " + unclassified.join("\n  "));
});

// Two labels on ONE screen that mean opposite things must not be the same word.
//
// The plan page says "Open" against a slot nobody has taken, and the link to a shift's own page was also labelled
// "Open" — the same word, six characters apart, meaning "unfilled" and "look at this". In Danish they were never
// the same ("Ledig" and "Detaljer"), so the collision existed in the primary language only, which is the direction
// nobody checks. Found by reading the rendered page.
//
// Deliberately a NAMED PAIR rather than a general rule: plenty of unrelated strings legitimately share a word, and
// a check that flagged every repetition would be deleted within a week. This is the pair that bit.
test("no label on the plan means two opposite things", () => {
  for (const locale of ["en", "da"]) {
    const s = loadStrings(locale);
    assert.notEqual(s["plan.openSession"], s["slot.open"],
      `${locale}: the link to a shift and the word for an unfilled slot are both "${s["slot.open"]}" on the same ` +
      `page. One means "look at this", the other "nobody has taken it".`);
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
