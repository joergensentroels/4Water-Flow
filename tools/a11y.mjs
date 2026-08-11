// WCAG rules, checked mechanically, against the real pages this app serves.
//
// Why this exists: a hand-written UX runthrough of these screens produced seven findings and THREE were false —
// each one from reading a page in a single state and taking the absence of something there for the absence of the
// capability. The same review's one accessibility observation was also a false alarm, from Playwright's snapshot
// collapsing 153 radio buttons into anonymous nodes. Judgement is the wrong instrument for "does every input have
// an accessible name". axe-core reads the accessibility tree and answers it the same way every time.
//
// WHAT THIS CANNOT DO, stated up front because a checker that quietly skips a rule reports a clean bill of health
// it never established: jsdom has no layout engine, so every rule needing geometry is UNRUNNABLE here — colour
// contrast above all, which is exactly the item the manual review listed as "not checked". Those rules are named
// in SKIPPED below and reported in the output, so the gap stays visible instead of reading as a pass.
import { JSDOM } from "jsdom";
import axe from "axe-core";

// Rules that need real layout. Disabled deliberately, listed so the report can say so.
export const SKIPPED = {
  "color-contrast": "needs computed colour and geometry; jsdom has neither. Check in a real browser.",
  "target-size": "needs box geometry.",
  "scrollable-region-focusable": "needs to know what actually scrolls.",
};

// One page, audited. Returns { violations, incomplete, passes } — `incomplete` matters as much as `violations`:
// it is axe saying it could not decide, which is not the same as saying there is nothing wrong.
export async function auditHtml(html, { url = "http://localhost/" } = {}) {
  // `outside-only` gives us window.eval so axe can be injected, WITHOUT executing the page's own scripts.
  // "dangerously" would run them, which is a larger claim than this tool needs to make: the accessibility tree is
  // structural, and 4water renders it on the server.
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  try {
    // axe attaches to the global it is given. Running it inside the page's own window is the whole point: the
    // accessibility tree it walks is the one a screen reader would.
    window.eval(axe.source);
    const results = await window.axe.run(window.document, {
      resultTypes: ["violations", "incomplete"],
      rules: Object.fromEntries(Object.keys(SKIPPED).map((id) => [id, { enabled: false }])),
    });
    // Array.from, not .map() alone. axe runs inside the jsdom window, so everything it returns belongs to THAT
    // realm — and a jsdom Array does not share a prototype with a Node one. assert.deepStrictEqual compares
    // prototypes, so `[]` from here failed against `[]` from a test with the diff reading "actual: [] expected: []",
    // which is not a message anybody can act on. Copying across the boundary is the fix.
    return {
      violations: Array.from(results.violations).map((v) => ({
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        nodes: Array.from(v.nodes).map((n) => ({ target: n.target.join(" "), html: String(n.html || "").slice(0, 160) })),
      })),
      incomplete: Array.from(results.incomplete).map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })),
    };
  } finally { window.close(); }
}

// Rendered for a human or a test failure message. Counts what it examined, so a run that audited nothing cannot
// read as a run that found nothing.
export function reportText(pages) {
  const lines = [];
  let violations = 0, nodes = 0;
  for (const p of pages) {
    violations += p.violations.length;
    for (const v of p.violations) nodes += v.nodes.length;
  }
  lines.push(`${pages.length} page(s) audited, ${violations} rule(s) violated across ${nodes} element(s).`);
  lines.push(`Not checked here (no layout engine): ${Object.keys(SKIPPED).join(", ")}.`);
  for (const p of pages) {
    if (!p.violations.length && !p.incomplete.length) continue;
    lines.push(`\n${p.name}`);
    for (const v of p.violations) {
      lines.push(`  VIOLATION ${v.id} (${v.impact}) — ${v.help}`);
      for (const n of v.nodes.slice(0, 4)) lines.push(`      ${n.target}\n        ${n.html}`);
      if (v.nodes.length > 4) lines.push(`      …and ${v.nodes.length - 4} more element(s)`);
    }
    for (const v of p.incomplete) lines.push(`  could not decide: ${v.id} — ${v.help} (${v.nodes} element(s))`);
  }
  return lines.join("\n");
}
