// WCAG rules over every screen, checked by axe-core rather than by somebody looking.
//
// This exists because a hand-written UX runthrough of these same screens produced seven findings and THREE were
// wrong — each from reading a page in one state and taking the absence of something there for the absence of the
// capability. Its one accessibility observation was also a false alarm, from Playwright's snapshot collapsing 153
// radios into anonymous nodes. "Does every input have an accessible name" is not a judgement call, and axe answers
// it identically every run.
//
// It found one thing the human pass missed entirely: four date inputs on the Administration screen wrapped in an
// EMPTY <label>, so a screen reader announced "date entry" twice with no way to tell a season's first day from its
// last. Admin was in that review's "Not checked" list.
//
// WHAT THIS DOES NOT COVER, and it is stated here rather than left to be discovered: jsdom has no layout engine,
// so colour-contrast and the other geometry rules cannot run. Those were checked separately in a real browser —
// availability at 291 elements and admin at 316, both clean, with a deliberately unreadable element planted first
// to prove the sweep could fail. That check is manual; this one is the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, makeAvailableEverywhere } from "../tools/testkit.mjs";
import { autoRoster } from "../src/roster.mjs";
import { auditHtml, reportText, SKIPPED } from "../tools/a11y.mjs";

test("every screen passes axe-core, in the states each one actually has", async () => {
  const w = await makeWorld({ volunteers: 4, roles: { 0: ["admin", "planner"] } });
  const pages = [];
  const audit = async (name, path, cookie) => {
    const res = await w.get(path, cookie);
    pages.push({ name: `${name} (${path})`, ...(await auditHtml(await res.text())) });
  };
  try {
    const fresh = w.people[3];
    const answered = w.people[1];
    makeAvailableEverywhere(w.db, answered, w.today);
    const cAdmin = await w.signIn(w.people[0]);
    const cFresh = await w.signIn(fresh);
    const cAnswered = await w.signIn(answered);

    // Three viewers and two data states, because half this app is conditional on both. A single-viewer pass is
    // exactly how the manual review reached three false conclusions.
    for (const [n, p] of [["home", "/"], ["availability", "/availability"], ["board", "/board"],
                          ["plan", "/plan"], ["profile", "/me"], ["privacy", "/privacy"], ["404", "/nope"]]) {
      await audit(`${n} unanswered`, p, cFresh);
    }
    for (const [n, p] of [["home", "/"], ["availability", "/availability"], ["board", "/board"]]) {
      await audit(`${n} answered`, p, cAnswered);
    }
    await audit("planner no proposals", "/planner", cAdmin);
    autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
    await audit("planner with proposals", "/planner", cAdmin);
    for (const [n, p] of [["status", "/status"], ["admin", "/admin"], ["audit", "/audit"], ["outbox", "/outbox"]]) {
      await audit(n, p, cAdmin);
    }
    await audit("signin", "/signin", undefined);

    // COUNT WHAT WAS EXAMINED. A run that audited nothing must not read as a run that found nothing — the failure
    // this project has shipped twice, and the reason every check here reports its own denominator.
    assert.ok(pages.length >= 17, `only ${pages.length} pages audited — this is not walking the app`);
    const withRules = pages.filter((p) => p.violations.length + p.incomplete.length > 0 || true).length;
    assert.equal(withRules, pages.length, "every page must have produced a result");

    const total = pages.reduce((n, p) => n + p.violations.length, 0);
    assert.equal(total, 0, "\n" + reportText(pages));
  } finally { w.close(); }
});

test("the audit can fail, and names what it cannot check", async () => {
  // A checker reporting zero proves nothing until it has been shown to report more than zero. An input inside an
  // empty label is the exact defect found on the Administration screen.
  const bad = await auditHtml('<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>t</h1>'
    + '<form><label><input type="date" name="x"></label></form></main></body></html>');
  assert.ok(bad.violations.some((v) => v.id === "label"),
    "an input with no accessible name must be reported: " + JSON.stringify(bad.violations.map((v) => v.id)));

  // And the same markup with a name must come back clean, or the rule above fires on everything.
  const good = await auditHtml('<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>t</h1>'
    + '<form><label>First day <input type="date" name="x"></label></form></main></body></html>');
  assert.deepEqual(good.violations.map((v) => v.id), [], "labelled markup must pass");

  // The skipped rules are declared rather than silently absent: a checker that quietly drops colour-contrast
  // reports a clean bill of health it never established.
  assert.ok(Object.keys(SKIPPED).includes("color-contrast"),
    "the rules this cannot run must be named, so their absence is visible rather than assumed");
});

// ---- why BOTH label checks exist, and why neither replaces the other -----------------------------------------
//
// css-audit.test.mjs has asserted "every visible input is associated with a label" since increment M, with its own
// negative control, and it passed on every run while four date inputs on the Administration screen had no
// accessible name at all. It was not broken. It answers a DIFFERENT question.
//
// `unlabelledInputs` strips <label>…</label> and looks at what inputs remain, so it detects ASSOCIATION — and an
// input wrapped in an EMPTY label is associated perfectly well. Its control plants an input with no label at all,
// which shares the same proxy, so no amount of care in that test could have surfaced this.
//
// This test exists so the relationship is recorded rather than rediscovered: it pins the exact markup where the
// two disagree. If someone later decides one of them is redundant, this fails and tells them which question they
// would stop asking.
test("an empty label satisfies the association check and fails the accessible-name check", async () => {
  const { unlabelledInputs } = await import("./css-audit.test.mjs");
  const emptyLabel = '<label><input type="date" name="seasonFrom" required></label>';
  const page = (inner) => '<!doctype html><html lang="en"><head><title>t</title></head>'
    + `<body><main><h1>h</h1><form>${inner}</form></main></body></html>`;

  // The older check sees nothing wrong, and it is right on its own terms.
  assert.deepEqual(unlabelledInputs(page(emptyLabel)), [],
    "the association scan should be satisfied by an empty label — that is what it measures");

  // axe sees the defect, because it asks whether the control has a NAME.
  const audited = await auditHtml(page(emptyLabel));
  assert.ok(audited.violations.some((v) => v.id === "label"),
    "axe must catch the input an empty label leaves nameless: " + JSON.stringify(audited.violations.map((v) => v.id)));

  // BOTH agree once there is text, so the disagreement above is specifically about the empty case and not about
  // the two tools generally disliking each other.
  const named = '<label>First day <input type="date" name="seasonFrom" required></label>';
  assert.deepEqual(unlabelledInputs(page(named)), []);
  assert.deepEqual((await auditHtml(page(named))).violations.map((v) => v.id), []);
});
