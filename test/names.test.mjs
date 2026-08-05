// A control's accessible name has to say what THAT control does. Two controls doing different things under
// one name is the failure audited here: the reader hears the same words twice and cannot choose between them.
//
// Both instances this project found were the same shape — a fix applied to one screen and not its sibling, or
// to one section and not the one added after it. So this audit derives the controls from the rendered page
// instead of checking a list somebody keeps by hand: a screen added later is covered without anybody
// remembering to come back here, which a hand-kept list cannot promise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, makeAvailableEverywhere, csrfFromCookie } from "../tools/testkit.mjs";
import { autoRoster } from "../src/roster.mjs";
import { recordAudit } from "../src/audit.mjs";

// aria-label wins over text content — that is how a browser resolves an accessible name, and it is why counting
// visible button text says nothing about what a screen reader announces.
const attr = (attrs, name) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
const flatten = (s) => s.replace(/<(select|textarea)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ")
                        .replace(/\s+/g, " ").trim();

// A control with no aria-label is not necessarily nameless: a wrapping <label>, or a <label for> pointing at
// its id, names it just as well. The audit has to know all three, or it reports a properly labelled control and
// the "fix" is an aria-label duplicating the visible text — which is worse than nothing, because aria-label
// overrides that text and the two can then drift until voice control no longer matches what is on screen.
function nameResolver(body) {
  const wrapping = [], forId = new Map();
  for (const m of body.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
    const text = flatten(m[2]);
    const target = attr(m[1], "for");
    if (target) forId.set(target, text);
    else wrapping.push({ inner: m[2], text });
  }
  return (attrs, text = "") => {
    const al = attr(attrs, "aria-label");
    if (al) return al;
    const id = attr(attrs, "id");
    if (id && forId.get(id)) return forId.get(id);
    const wrap = wrapping.find((w) => w.inner.includes(attrs));
    if (wrap && wrap.text) return wrap.text;
    return flatten(text);
  };
}

// What a control DOES: its form's action, plus every value that rides along when it is used. Controls with
// the same signature are interchangeable and may share a name; controls with different signatures may not.
// csrf is excluded because it is per-session noise, not part of what the control means.
function controls(body) {
  const nameOf = nameResolver(body);
  const out = [];
  for (const chunk of body.split(/<form\b/).slice(1).map((f) => f.split("</form>")[0])) {
    const action = attr(chunk, "action") ?? "?";
    const payload = [...chunk.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)"/g)]
      .filter((m) => m[1] !== "csrf").map((m) => `${m[1]}=${m[2]}`).join("&");
    for (const m of chunk.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
      const own = /name="([^"]*)"[^>]*value="([^"]*)"/.exec(m[1]);
      out.push({ kind: "button", name: nameOf(m[1], m[2]),
                 does: `${action}?${payload}${own ? `&${own[1]}=${own[2]}` : ""}` });
    }
    for (const m of chunk.matchAll(/<select([^>]*)>/g)) {
      out.push({ kind: "select", name: nameOf(m[1]), does: `${action}?${payload}&${attr(m[1], "name")}` });
    }
    for (const m of chunk.matchAll(/<input type="radio"([^>]*)>/g)) {
      out.push({ kind: "radio", name: nameOf(m[1]),
                 does: `${action}?${attr(m[1], "name")}=${attr(m[1], "value")}` });
    }
  }
  // Links are audited on the same footing as buttons, and were not at first. A screen reader user navigating by
  // links list gets every name stripped of the card, row or paragraph that explained it — which is exactly the
  // position a button is in. Skipping them left four "Download data" links pointing at four volunteers' personal
  // records, on a screen whose buttons had just been fixed. The href is the whole href: two links named alike
  // going to the same query differing only in a parameter are still two destinations.
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    out.push({ kind: "link", name: nameOf(m[1], m[2]), does: attr(m[1], "href") ?? "" });
  }
  return out;
}

// Both faults reported from one pass, rather than asserted one after the other. Asserting the ambiguities first
// let them shadow the nameless report permanently: a control with no name at all is also a control sharing the
// empty name with every other nameless control, so wherever there are two of them the first assertion throws and
// the second never runs. Probing an emptied link proved that — it was reported as ambiguous both times, and the
// check written for it had still never been seen to fire on a link. One list, so a failure says everything it knows.
function faults(body) {
  const byName = new Map();
  const out = [];
  for (const c of controls(body)) {
    if (c.name === "") out.push(`${c.kind} with no accessible name → ${c.does}`);
    const key = `${c.kind}: ${c.name}`;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(c.does);
  }
  for (const [key, does] of byName) {
    if (does.size > 1) {
      out.push(`${key} — ${does.size} different actions, e.g. ${[...does].slice(0, 2).join("  vs  ")}`);
    }
  }
  return out;
}

// Everyone available and capable of everything, so the planner renders a candidate list for every open slot and
// the season's whole set of controls exists to be audited. Both are ordinary admin grants, not a harness
// shortcut: with nobody capable the planner renders no selects at all and the audit would pass vacuously.
//
// TWO pending invites, and a roster run, for the same reason. Both gaps were found by probing this audit rather
// than by reading it: with one invite the Revoke buttons cannot collide, and with nothing assigned the planner
// renders no Unassign buttons at all — so removing the fix from either left the audit green. An audit is only
// looking where the fixture gives it two of the thing.
const populated = async () => {
  const w = await makeWorld({ volunteers: 4, roles: { 0: ["admin", "planner"] } });
  for (const p of w.people) {
    makeAvailableEverywhere(w.db, p);
    w.db.prepare(`INSERT OR IGNORE INTO capabilities (person_id, activity_id) SELECT ?, id FROM activities`).run(p);
  }
  // Rostered from four weeks out, so the near weeks stay open and the later ones are filled. Both shapes have
  // to be on the page at once: an all-open season renders no Unassign button and an all-filled one renders no
  // candidate <select>, and the probe caught this fixture in each of those states in turn — the first pass
  // missed the Unassign fix, and rostering the whole season then missed the select fix instead. Done by moving
  // the roster's horizon rather than by editing rows, which is what a planner who has not got to next week yet
  // actually leaves behind.
  const inFourWeeks = new Date(`${w.today}T00:00:00Z`);
  inFourWeeks.setUTCDate(inFourWeeks.getUTCDate() + 28);
  autoRoster(w.db, { seasonId: w.seasonId, fromDate: inFourWeeks.toISOString().slice(0, 10) });
  const admin = await w.signIn(w.people[0]);
  for (const email of ["first@example.org", "second@example.org"]) {
    const r = await w.post("/admin/invite", admin, new URLSearchParams({ csrf: csrfFromCookie(admin), email }));
    assert.equal(r.status, 303, `inviting ${email} must succeed, or the invite list is not being audited`);
  }

  // TWO NOTES BY THE SAME PERSON on one session, so /session renders two Delete buttons.
  //
  // Deriving the page list brought /session and /audit into this audit for the first time, and they arrived with
  // ONE control each: a link on the audit page, a link and a button on the session page. One control cannot collide
  // with anything, so both pages were covered in name only — the same vacuous pass this file's second test was
  // written to prevent, reintroduced by the change that was supposed to widen coverage.
  //
  // Two notes is the shape that matters, because two Delete buttons doing different things is precisely the fault
  // audited here: each must say WHICH note it deletes. notes.mjs puts the note's first words in the aria-label, so
  // the app is right — it had simply never been asked.
  const session = w.db.prepare("SELECT id FROM sessions WHERE season_id=? ORDER BY date LIMIT 1").get(w.seasonId).id;
  for (const body of ["bringing the spare cable", "can arrive fifteen minutes early"]) {
    const r = await w.post(`/session/${session}/note`, admin,
      new URLSearchParams({ csrf: csrfFromCookie(admin), body }));
    assert.equal(r.status, 303, "posting a note must succeed, or /session has nothing to audit");
  }

  // And enough audit rows to spill past one page, so /audit renders BOTH its Newest and Older links rather than
  // neither. The rows come from the invites and notes above plus this padding; recordAudit is called directly
  // because driving 100 real actions through HTTP would take longer than the rest of this file.
  for (let i = 0; i < 120; i++) {
    recordAudit(w.db, { actorId: w.people[0], actorName: "Padding Admin", action: "admin.status",
                        subject: `person:${w.people[1]}`, detail: "padding so the log paginates" });
  }
  return { w, admin, session };
};

// Query strings for the pages that need one to show their interesting state. Everything else is fetched bare, and
// `:id` placeholders are filled with 1.
const WITH_QUERY = { "/planner": "/planner?weeks=all" };

// DERIVED from the route table, not listed.
//
// This was a hand-written array of ten paths under a comment reading "every page an authenticated person can
// reach" — and by the time anybody read that comment again it was false. `/session/:id` and `/audit` had been added
// since, so the two NEWEST screens in the app were the only ones this audit had never seen, which is precisely the
// wrong way round. A list of pages to check cannot notice a page absent from itself; that shape has now been
// removed from six checks in this repository and it keeps arriving in a new place.
//
// A GET route counts as a page when it answers 200 with HTML. That drops /healthz, the calendar feed, the CSV and
// the JSON exports without naming any of them, so a new non-HTML route needs no entry here either.
// The OIDC endpoints are skipped by name rather than by their status code. They are protocol steps, not screens:
// /auth/oidc answers 503 unless a provider is configured, which the server logs as an error, and both count a
// failure against the same limiter that guards sign-in. Excluding them keeps this audit from filling the test output
// with errors about a thing it is not testing, and from spending throttle budget to learn they are not pages.
const NOT_A_SCREEN = /^\/auth\//;

async function pagesToAudit(w, cookie) {
  const out = [];
  for (const r of w.routes()) {
    if (r.method !== "GET" || NOT_A_SCREEN.test(r.pattern)) continue;
    const path = WITH_QUERY[r.pattern] ?? r.pattern.replace(/:(\w+)/g, () => "1");
    const res = await w.get(path, cookie);
    if (res.status !== 200) continue;                      // a bounce to /signin or a 404 is not a page
    const body = await res.text();
    if (/<html/i.test(body)) out.push({ path, body });
  }
  return out;
}

test("no two controls on a page share an accessible name while doing different things", async () => {
  const { w, admin: cookie } = await populated();
  try {
    const pages = await pagesToAudit(w, cookie);
    // Class-J guard: "no faults" must not be able to mean "no pages". The list this replaced held ten.
    assert.ok(pages.length >= 10,
      `only ${pages.length} HTML pages were reached, so this audit now covers less than the list it replaced: ` +
      pages.map((p) => p.path).join(", "));
    for (const { path, body } of pages) {
      const bad = faults(body);
      assert.deepEqual(bad, [], `${path}:\n  ${bad.join("\n  ")}`);
    }
  } finally { w.close(); }
});

// The audit above is only worth its runtime if the pages it visits carry controls, and — the lesson from the
// invite list — carry MORE THAN ONE of the repeating ones. A page rendering a single Revoke button satisfies
// the audit while telling it nothing. So this asserts the fixture's shape, not the app's behaviour.
test("the audited pages really do carry repeated controls for the audit to collide", async () => {
  const { w, admin: cookie, session } = await populated();
  try {
    const on = async (page) => controls(await (await w.get(page, cookie)).text());
    const repeats = (cs) => {
      const byAction = new Map();
      for (const c of cs) byAction.set(c.does.split("?")[0], (byAction.get(c.does.split("?")[0]) ?? 0) + 1);
      return [...byAction.values()].filter((n) => n > 1).length;
    };

    assert.ok((await on("/availability")).length >= 20, "the availability form must offer a season's worth of radios");
    assert.ok((await on("/planner?weeks=all")).length >= 20, "the planner must offer a select and a button per slot");
    assert.ok((await on("/board")).length >= 2, "the board must offer more than one claimable slot");
    assert.ok((await on("/planner?weeks=all")).filter((c) => c.does.startsWith("/planner/unassign")).length >= 2,
      "the roster must have filled slots, or the planner's Unassign buttons cannot collide");
    assert.ok((await on("/planner?weeks=all")).filter((c) => c.does.startsWith("/planner/assign")).length >= 2,
      "and open slots too, or its candidate selects cannot collide");
    assert.ok(repeats(await on("/admin")) >= 4, "the admin screen must repeat its per-person controls");
    assert.ok((await on("/admin")).filter((c) => c.does.startsWith("/admin/invite/revoke")).length >= 2,
      "two pending invites, or the invite list's Revoke buttons cannot collide and are not being audited");
    assert.ok((await on("/admin")).filter((c) => c.kind === "link" && c.does.includes("/export.json")).length >= 2,
      "two per-person export links, or the link half of the audit is not looking at the one place it caught");

    // The two pages the derived page list brought in. They arrived with ONE control each — a link on the audit page,
    // a link and a button on the session page — so widening the coverage had covered them in name only. These
    // assertions are what stop that happening again silently, and they are the reason the fixture now writes two
    // notes and pads the log past a page.
    const sessionControls = await on(`/session/${session}`);
    assert.ok(sessionControls.filter((c) => c.does.startsWith("/note/")).length >= 2,
      "two notes by the same person, or /session's Delete buttons cannot collide and the page is audited vacuously");
    const auditControls = await on("/audit");
    assert.ok(auditControls.filter((c) => c.kind === "link" && c.does.startsWith("/audit")).length >= 2,
      "the log must spill past one page, or /audit renders neither its Newest nor its Older link and has nothing " +
      "for the audit to look at");
  } finally { w.close(); }
});
