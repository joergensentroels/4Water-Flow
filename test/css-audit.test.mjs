// The stylesheet is the one artifact here that nothing executes.
//
// Every other audit in this directory walks the app and asserts something about behaviour. CSS has no behaviour a
// test can observe: `node:test` cannot lay out a box, so the only honest verification is a browser, and the browser
// pass is a human step in CONTRIBUTING.md. What a test CAN do is catch the two failure modes that are visible in the
// text — and both of them shipped, four times between them, on the three newest screens:
//
//   1. A class written in markup with no rule anywhere. `<ul class="notes">` on /session rendered with the
//      browser's defaults — `list-style: disc` and `padding-left: 40px`, bullets and an 11%-of-a-phone indent —
//      while every other list here is flush with hairline separators. `.notebody` and `.notemeta` likewise, so a
//      note's author and its text came out the same size and colour.
//   2. A form control styled only through an ancestor it does not always have. `label select` left the planner's
//      dropdown 19px tall; then `textarea` arrived with NO rule at all and the note box fell back to the browser's
//      intrinsic `cols=20` sizing — 157x51 in a card whose every sibling was 309px.
//
// Both are decidable from the source, and neither was noticed by 465 passing tests. Measured in a browser at 375px,
// which is how all four were found in the first place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
import { modulesToCheck } from "../tools/precheck.mjs";
import { makeWorld } from "../tools/testkit.mjs";

const css = () => readFileSync(path.join(ROOT, "static", "app.css"), "utf8");

// Comments stripped first: a class named in a comment is not a rule, and this project has been caught three times
// by a check that a comment could satisfy.
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");

// Every selector in the file, INCLUDING the first rule inside each @media block.
//
// The first version matched /(^|\})\s*([^{}@]+)\{/ and silently missed exactly those: after `@media (...) {` the
// next selector is preceded by `{`, not by `}` or the start of the file. It was excluding real rules and reporting
// a smaller, cleaner number — an omission that reads exactly like coverage, which is the failure this whole file
// exists to catch. Scanning for `{` and taking the text back to the previous brace has no such blind spot.
export function selectorsIn(text) {
  const src = withoutComments(text);
  const out = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{" || src[i] === "}") {
      const chunk = src.slice(start, i).trim();
      // A selector list precedes `{`. An at-rule prelude (@media ...) is not a selector and is skipped.
      if (src[i] === "{" && chunk && !chunk.startsWith("@")) {
        for (const s of chunk.split(",")) if (s.trim()) out.push(s.trim());
      }
      start = i + 1;
    }
  }
  return out;
}

// A selector is SELF-SUFFICIENT when it is a single compound: it applies wherever the element appears, with no
// requirement on an ancestor. `.chip` is; `.chiprow .chip` is not. Attribute selectors are blanked first so the
// space inside `[aria-current="page"]` is not read as a descendant combinator.
const selfSufficient = (sel) => !/[\s>+~]/.test(sel.replace(/\[[^\]]*\]/g, ""));

// Both the class AND the element carrying it, because those are two different questions and only the second one
// matters. See the tag-match test below for what the difference cost.
function classesUsedInMarkup() {
  const used = new Map();
  for (const rel of modulesToCheck().filter((r) => r.startsWith("src/"))) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    // Only literal class attributes. A computed one (`class="${x}"`) cannot be resolved here and is not guessed at.
    // `[^>]*?` spans newlines by design: several tags here wrap before their class attribute.
    for (const m of text.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?class="([^"$]*)"/g)) {
      for (const c of m[2].split(/\s+/).filter(Boolean)) {
        if (!used.has(c)) used.set(c, new Map());
        if (!used.get(c).has(m[1])) used.get(c).set(m[1], new Set());
        used.get(c).get(m[1]).add(rel);
      }
    }
  }
  return used;
}

const filesFor = (tags) => [...new Set([...tags.values()].flatMap((s) => [...s]))];

// For each class, which element names may carry it and still be styled. "*" means a selector with no tag qualifier,
// which matches anything. Only the selector's LAST compound decides what it styles.
function elementsStyledPerClass(text) {
  const allowed = new Map();
  for (const sel of selectorsIn(text)) {
    const last = sel.replace(/\[[^\]]*\]/g, "").split(/[\s>+~]+/).filter(Boolean).pop();
    if (!last) continue;
    const tag = (last.match(/^([a-z][a-z0-9]*)/) ?? [])[1] ?? "*";
    for (const m of last.matchAll(/\.([A-Za-z][\w-]*)/g)) {
      if (!allowed.has(m[1])) allowed.set(m[1], new Set());
      allowed.get(m[1]).add(tag);
    }
  }
  return allowed;
}

// Classes that are markup or test hooks rather than styling hooks, each with the reason it needs no rule of its own.
// Two entries, and both were checked in a browser rather than assumed.
const UNSTYLED_ON_PURPOSE = new Map([
  ["auditrow", "styled by `ul.audit > li`, which is the element rule for the list it can only appear in — measured "
    + "at 375px: list-style none, hairline border, no indent. The class name is what audit tests select on"],
  ["attended", "a <small> in the roster review carrying a count. The `small` default is the intended treatment; "
    + "there is no box to size"],
]);

test("every class the markup uses is either styled or declared unstyled with a reason", () => {
  const used = classesUsedInMarkup();
  assert.ok(used.size > 20, `expected the app to use many classes, found ${used.size} — if this is 0 the scan is broken`);

  const mentioned = new Set([...withoutComments(css()).matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  assert.ok(mentioned.has("card"), "control: the scan cannot find `.card`, which app.css certainly styles");

  const unaccounted = [...used.keys()].filter((c) => !mentioned.has(c) && !UNSTYLED_ON_PURPOSE.has(c)).sort();
  assert.deepEqual(unaccounted, [],
    `these classes appear in markup and nowhere in app.css, so they render with browser defaults: ` +
    unaccounted.map((c) => `.${c} (${filesFor(used.get(c)).join(", ")})`).join("; ") +
    `. Either style them or add them to UNSTYLED_ON_PURPOSE with the reason`);

  // The other direction, so an exception cannot outlive the markup that justified it.
  const stale = [...UNSTYLED_ON_PURPOSE.keys()].filter((c) => !used.has(c));
  assert.deepEqual(stale, [], `declared unstyled but no longer used in any markup — remove the entry: ${stale}`);
});

// The stronger form of the test above, and the reason it is a separate one: "is this class mentioned somewhere in the
// stylesheet" is not the question. `.inline` was mentioned — twice, as `label.inline` — while notes.mjs put it on a
// `<form>`, where no rule could reach it. The delete button under every note therefore kept the global
// `width: 100%` and rendered 343x48: a destructive per-item action, marked `.secondary`, sized like the primary one.
// The class name was in the file and the element was not styled, which the check above cannot tell apart.
test("every class is styled on the element that actually carries it, not merely mentioned", () => {
  const used = classesUsedInMarkup();
  const allowed = elementsStyledPerClass(css());
  assert.ok(allowed.get("card")?.size > 0, "control: no element found for `.card`, so the selector parse is broken");
  assert.ok(allowed.get("inline")?.has("label"),
    "control: `.inline` should be recorded as styled on `label` — if not, the tag qualifier is not being read");

  const mismatched = [];
  for (const [cls, tags] of used) {
    const styledOn = allowed.get(cls);
    // Absent from `allowed` means either no rule at all (the previous test's business) or the class appears ONLY as
    // an ancestor qualifier, like `.chiprow` in `.chiprow .chip`. The second is legitimate and deliberate: such a
    // class is a hook that makes a descendant rule apply, and it is doing its job while carrying no declarations of
    // its own. Skipping both here is correct rather than an oversight.
    if (!styledOn || UNSTYLED_ON_PURPOSE.has(cls)) continue;
    if (styledOn.has("*")) continue;                            // an unqualified selector matches any element
    for (const [tag, files] of tags) {
      if (styledOn.has(tag)) continue;
      mismatched.push(`<${tag} class="${cls}"> in ${[...files].join(", ")} — app.css only styles ` +
        `${[...styledOn].map((t) => `${t}.${cls}`).join(", ")}`);
    }
  }
  assert.deepEqual(mismatched, [],
    `these elements carry a class whose every rule is qualified with a DIFFERENT element, so they are unstyled ` +
    `while looking styled: ${mismatched.join(" | ")}. Either drop the tag qualifier from the rule or add one for ` +
    `this element`);
});

test("the tag-qualifier reader distinguishes label.x from form.x, and treats a bare .x as matching anything", () => {
  const sample = `label.thing { color: red } form.other button { width: auto } .anywhere { margin: 0 }
    nav.tabs a.deep { color: blue } @media (min-width: 40rem) { section.inmedia { padding: 0 } }`;
  const allowed = elementsStyledPerClass(sample);
  assert.deepEqual([...allowed.get("thing")], ["label"], "a tag-qualified class was not tied to its element");
  assert.deepEqual([...allowed.get("anywhere")], ["*"], "an unqualified class must be recorded as matching anything");
  assert.deepEqual([...allowed.get("deep")], ["a"],
    "only the LAST compound decides what a selector styles — `nav.tabs a.deep` styles an <a>, not a <nav>");
  assert.equal(allowed.has("tabs"), false,
    "`.tabs` is an ancestor in that selector, not the styled element, so it must not be credited here");
  assert.deepEqual([...allowed.get("inmedia")], ["section"], "a rule inside @media was missed");
  // And the failure it exists to catch: a class styled for one element, used on another. `form.other button` styles
  // the BUTTON, so `.other` must not appear here at all — crediting it to <form> would hide exactly the notes.mjs
  // defect. (`.get` returning undefined rather than an empty set is what the first version of this line got wrong.)
  assert.equal(allowed.has("other"), false,
    "`.other` is only an ancestor qualifier in that selector, so it styles no element and must not be credited");
});

test("every form control has a rule that does not depend on an ancestor", () => {
  const selectors = selectorsIn(css());
  assert.ok(selectors.length > 40, `expected many selectors, parsed ${selectors.length}`);
  assert.ok(selectors.some((s) => s === "nav.tabs a"),
    "control: the parse cannot see `nav.tabs a`, so it is not reading this file properly");

  // A control that only ever matches `label X` renders unstyled wherever the markup does not wrap it in a label —
  // which is what happened to `select` (19px tall) and then to `textarea` (no rule at all).
  //
  // `input` is deliberately NOT in this list, because it has two styled patterns rather than one and neither is a
  // bare rule: a text field inside a label, reached by `label input`, and a radio hidden by `.choice input` beside
  // the `<label for>` that is the visible 48px target. Both were measured at 375px. That is an assumption about
  // markup rather than a property of the stylesheet — the same kind of assumption that held for `select` until it
  // did not — so the test below CHECKS that every input really is label-associated rather than trusting it.
  for (const el of ["select", "textarea", "button"]) {
    const bare = selectors.filter((s) => selfSufficient(s) && new RegExp(`(^|[,\\s])${el}([.:\\[]|$)`).test(s));
    assert.ok(bare.length > 0,
      `<${el}> is styled only through an ancestor, so it renders with browser defaults anywhere the markup does ` +
      `not provide that ancestor. This is the defect that left the planner's select 19px tall and the note ` +
      `textarea 157px wide. Give it a rule that stands on its own`);
  }
});

// The premise the exemption above rests on, corrected by being run.
//
// The first version asserted that every non-hidden input sits INSIDE a label, and it failed immediately on
// /availability against completely correct markup — 153 radios that are deliberately siblings of their labels. That
// screen uses the hidden-input pattern: `<input type="radio" id=x>` next to `<label for=x>` carrying the glyph,
// with `.choice input { position: absolute; opacity: 0; width: 1px; height: 1px }` hiding the control and
// `.choice label` as the visible 48px target. So there are TWO styled patterns for an input here, not one, and the
// premise as first written was false about the app rather than a finding about it.
//
// The invariant that IS true, and worth more than the one I set out to check: every non-hidden input is associated
// with a label, either as an ancestor or by `for=`. That covers both patterns, it is the accessibility requirement
// rather than a proxy for it, and an input satisfying neither is both unstyled and unnamed.
test("every visible input is associated with a label, by ancestor or by for=", async () => {
  const w = await makeWorld({ volunteers: 3, roles: { 0: ["admin", "planner"] } });
  try {
    const cookie = await w.signIn(w.people[0]);
    const offenders = [];
    let pagesChecked = 0;
    for (const r of w.routes()) {
      if (r.method !== "GET") continue;
      const res = await w.get(r.pattern.replace(/:(\w+)/g, "1"), cookie);
      const body = await res.text();
      if (!/<html/i.test(body)) continue;              // /healthz, the calendar feed, the CSV — not pages
      pagesChecked++;
      const stray = unlabelledInputs(body);
      if (stray.length) offenders.push(`${r.pattern}: ${stray.join(" ")}`);
    }
    // Class-J guard: "no offenders" must not be able to mean "no pages were looked at".
    assert.ok(pagesChecked >= 8, `only ${pagesChecked} HTML pages were fetched, so this proves almost nothing`);
    assert.deepEqual(offenders, [],
      `these inputs have no label — not as an ancestor and not by \`for=\` — so they carry the browser's default ` +
      `box and no accessible name: ${offenders.join(" | ")}. Give each one a label, and if it is meant to be a ` +
      `bare styled field then also add a self-sufficient \`input\` rule to app.css and move "input" back into the ` +
      `form-control test above`);
  } finally { w.close(); }
});

// Labels do not nest in this app, so removing every label element and looking at what inputs remain finds the ones
// with no label ANCESTOR; the `for=` set then accounts for the sibling pattern. Exported for the control below,
// because a scan that removes too much, or collects too many ids, reports zero offenders forever.
export function unlabelledInputs(html) {
  const referenced = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gi)].map((m) => m[1]));
  const withoutLabels = html.replace(/<label\b[\s\S]*?<\/label>/gi, "");
  return [...withoutLabels.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0])
    .filter((tag) => !/type="hidden"/i.test(tag))
    .filter((tag) => { const id = tag.match(/\bid="([^"]+)"/i); return !id || !referenced.has(id[1]); });
}

test("the unlabelled-input scan finds one when there is one, and not when there is not", () => {
  const ancestor = `<label>Name <input type="text" name="n"></label>`;
  const sibling = `<input type="radio" id="r1" name="r"><label for="r1"><span>x</span></label>`;
  const bare = `<p>Name</p><input type="text" name="n">`;
  const hidden = `<input type="hidden" name="csrf" value="x">`;
  const wrongTarget = `<input type="radio" id="r1"><label for="SOMETHING-ELSE">x</label>`;
  assert.deepEqual(unlabelledInputs(ancestor), [], "an input inside a label was reported");
  assert.deepEqual(unlabelledInputs(sibling), [], "an input paired by for= was reported");
  assert.equal(unlabelledInputs(bare).length, 1, "a bare input was NOT reported — the scan is blind");
  assert.deepEqual(unlabelledInputs(hidden), [], "a hidden input was reported; it has no box and needs no name");
  assert.equal(unlabelledInputs(wrongTarget).length, 1,
    "a label pointing at a different id counted as pairing — the for= set is being read too loosely");
  // Two labels in a row: a greedy strip would swallow everything between the first <label> and the last </label>,
  // hiding any bare input sitting between them.
  const between = `<label>A <input name="a"></label><input name="stray"><label>B <input name="b"></label>`;
  assert.equal(unlabelledInputs(between).length, 1, "the label strip is greedy and swallowed a stray input");
});

test("the selector parse sees inside @media blocks, which the first version did not", () => {
  // A negative control with a known answer: the first rule after an at-rule prelude must be found. The original
  // parse required `}` or start-of-file before a selector and skipped exactly this one.
  const sample = `a { color: red; }\n@media (min-width: 40rem) {\n  .inside-media { color: blue; }\n  .second { x: y; }\n}`;
  const found = selectorsIn(sample);
  assert.ok(found.includes(".inside-media"),
    `the first selector inside an @media block was missed: ${JSON.stringify(found)}`);
  assert.ok(found.includes(".second"), "the later selectors inside the block were missed too");
  assert.ok(!found.some((s) => s.startsWith("@")), `an at-rule prelude was returned as a selector: ${found}`);

  // And the real file has rules inside media blocks, so the fix matters here rather than only in the sample.
  assert.match(css(), /@media[^{]*\{\s*[^@}]/, "app.css has no rule inside an @media block — this test is moot");
});
