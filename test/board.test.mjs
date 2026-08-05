// Increment D: the vagtbørs through HTTP. The queries themselves are covered in queries.test.mjs; what
// matters here is that the routes enforce the same rules and that a race resolves to exactly one winner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie, waitFor, makeAvailableEverywhere } from "../tools/testkit.mjs";
import { makeNotifier, notifyConfig, stubTransport } from "../src/notify.mjs";
import { setAvailabilityDay } from "../src/queries.mjs";

const withWorld = (opts, fn) => async () => {
  const w = await makeWorld(opts);
  try { await fn(w); } finally { w.close(); }
};

// Make a person eligible for every upcoming session date, so the board has something on it.
function makeAvailable(w, personId) {
  const dates = w.db.prepare("SELECT DISTINCT date FROM sessions WHERE date >= ? ORDER BY date").all(w.today);
  for (const { date } of dates) setAvailabilityDay(w.db, personId, date, true);
}
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");

test("the board requires a session", withWorld({}, async ({ get }) => {
  const r = await get("/board");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/signin?next=%2Fboard",
    "carrying the destination: every slot-open notification links here, and it is read on a phone with no session");
}));

test("with no availability entered, the board is empty and says so", withWorld({}, async ({ people, signIn, get }) => {
  const body = await (await get("/board", await signIn(people[0]))).text();
  assert.match(body, /no open slots you can take|ingen ledige vagter/i,
    "silence about availability must produce an explained empty board, not a blank one");
}));

test("an available volunteer sees open slots and can claim one", withWorld({}, async (w) => {
  const { people, signIn, csrfFrom, post, get, db } = w;
  makeAvailable(w, people[0]);
  const cookie = await signIn(people[0]);
  const { token, body } = await csrfFrom("/board", cookie);

  const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);
  const r = await post(`/board/${id}/claim`, cookie, new URLSearchParams({ csrf: token }));
  assert.equal(r.status, 303);
  assert.equal(reasonOf(r), "claimed");
  assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, people[0]);

  // And it now appears under "your slots" rather than the open list.
  const after = await (await get("/board", cookie)).text();
  assert.match(after, new RegExp(`action="/slot/${id}/hand-back"`));
  assert.ok(!after.includes(`action="/board/${id}/claim"`), "a claimed slot must leave the open list");
}));

test("two volunteers racing for the same slot: exactly one wins", withWorld({}, async (w) => {
  const { people, signIn, csrfFrom, post, db } = w;
  makeAvailable(w, people[0]);
  makeAvailable(w, people[1]);
  const a = await signIn(people[0]);
  const b = await signIn(people[1]);
  const { token: tokenA, body } = await csrfFrom("/board", a);
  const { token: tokenB } = await csrfFrom("/board", b);
  const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);

  // Fired together. On one process these still serialise, so this proves the OUTCOME is correct rather
  // than proving true parallelism — the `person_id IS NULL` guard inside the UPDATE is what makes it
  // correct if this ever runs behind more than one worker.
  const [ra, rb] = await Promise.all([
    post(`/board/${id}/claim`, a, new URLSearchParams({ csrf: tokenA })),
    post(`/board/${id}/claim`, b, new URLSearchParams({ csrf: tokenB })),
  ]);
  const outcomes = [reasonOf(ra), reasonOf(rb)].sort();
  assert.deepEqual(outcomes, ["already_taken", "claimed"], `both requests should not succeed: ${outcomes}`);

  const owner = db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id;
  assert.ok([people[0], people[1]].includes(owner));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assignments WHERE id=? AND person_id IS NOT NULL").get(id).n, 1);
}));

test("an ineligible volunteer cannot claim, even knowing the slot id", withWorld({}, async (w) => {
  const { people, signIn, csrfFrom, post, db } = w;
  makeAvailable(w, people[0]);
  const a = await signIn(people[0]);
  const { body } = await csrfFrom("/board", a);
  const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);

  // people[1] has entered no availability, so is not eligible — but knows the id from a friend. Their board
  // is legitimately empty and therefore has no form to lift a token from, so read it from the cookie.
  const b = await signIn(people[1]);
  const r = await post(`/board/${id}/claim`, b, new URLSearchParams({ csrf: csrfFromCookie(b) }));
  assert.equal(reasonOf(r), "not_eligible");
  assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null);
}));

test("claiming needs a CSRF token", withWorld({}, async (w) => {
  const { people, signIn, csrfFrom, post, db } = w;
  makeAvailable(w, people[0]);
  const cookie = await signIn(people[0]);
  const { body } = await csrfFrom("/board", cookie);
  const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);

  assert.equal((await post(`/board/${id}/claim`, cookie, new URLSearchParams({}))).status, 403);
  assert.equal((await post(`/board/${id}/claim`, cookie, new URLSearchParams({ csrf: "wrong" }))).status, 403);
  assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null);
}));

test("handing a slot back returns it to the exchange", withWorld({}, async (w) => {
  const { people, signIn, csrfFrom, post, db } = w;
  makeAvailable(w, people[0]);
  makeAvailable(w, people[1]);
  const a = await signIn(people[0]);
  const { token, body } = await csrfFrom("/board", a);
  const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);
  await post(`/board/${id}/claim`, a, new URLSearchParams({ csrf: token }));

  const r = await post(`/slot/${id}/hand-back`, a, new URLSearchParams({ csrf: token }));
  assert.equal(reasonOf(r), "handed_back");
  assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null);

  // Visible to the other eligible volunteer again — the point of the whole feature.
  const b = await signIn(people[1]);
  const seen = await (await csrfFrom("/board", b)).body;
  assert.ok(seen.includes(`action="/board/${id}/claim"`), "a handed-back slot must reappear for everyone eligible");
}));

test("one volunteer cannot hand back another's slot", withWorld({}, async (w) => {
  const { people, signIn, csrfFrom, post, db } = w;
  makeAvailable(w, people[0]);
  makeAvailable(w, people[1]);
  const a = await signIn(people[0]);
  const { token: tokenA, body } = await csrfFrom("/board", a);
  const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);
  await post(`/board/${id}/claim`, a, new URLSearchParams({ csrf: tokenA }));

  const b = await signIn(people[1]);
  const { token: tokenB } = await csrfFrom("/board", b);
  const r = await post(`/slot/${id}/hand-back`, b, new URLSearchParams({ csrf: tokenB }));
  assert.equal(reasonOf(r), "not_yours");
  assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, people[0]);
}));

test("inside the cutoff the slot still releases, but the volunteer is told a planner must know", async () => {
  // Clock set one day before the first session, against a two-day cutoff from config.
  const w0 = await makeWorld({});
  const firstDate = w0.db.prepare("SELECT MIN(date) d FROM sessions").get().d;
  w0.close();
  const dayBefore = new Date(Date.parse(`${firstDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

  const w = await makeWorld({ today: dayBefore });
  try {
    const { people, signIn, csrfFrom, post, db, pattern } = w;
    assert.ok(Number(pattern.board.cutoffDays) >= 2, "this test assumes a cutoff of at least two days");
    makeAvailable(w, people[0]);
    const a = await signIn(people[0]);
    const { token, body } = await csrfFrom("/board", a);
    const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);
    await post(`/board/${id}/claim`, a, new URLSearchParams({ csrf: token }));

    const r = await post(`/slot/${id}/hand-back`, a, new URLSearchParams({ csrf: token }));
    assert.equal(reasonOf(r), "handed_back_late", "a late hand-back must be flagged, not silently identical");
    assert.equal(db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null,
      "it must still release — refusing would just make the volunteer not turn up without telling anyone");

    // The message lives on the page the volunteer is redirected TO.
    const { body: page } = await w.follow(r, a);
    assert.match(page, /message the planner|skriv til planlæggeren/i);
  } finally { w.close(); }
});

test("every outcome a route can produce has a real message, in both locales", async () => {
  const { flashFor } = await import("../src/pages/board.mjs");
  const { makeT } = await import("../src/config.mjs");
  // Every code the two routes can put in ?r= . If a code is added to a route and not here, that is the gap
  // this list exists to expose.
  const codes = ["claimed", "handed_back", "handed_back_late", "already_taken", "not_eligible", "no_such_slot", "not_yours"];
  for (const locale of ["da", "en"]) {
    const t = makeT(locale);
    for (const code of codes) {
      const f = flashFor(t, code);
      assert.ok(f, `${locale}: no flash for "${code}"`);
      assert.ok(f.text.length > 3, `${locale}: flash for "${code}" is empty`);
      // t() returns the KEY when a translation is missing, so a dotted result means an untranslated string.
      assert.ok(!/^[a-z]+\.[a-zA-Z]+$/.test(f.text), `${locale}: "${code}" fell through to its key: ${f.text}`);
    }
    assert.equal(flashFor(t, "not-a-code"), null, "an unknown code must be no flash, not a blank one");
    assert.equal(flashFor(t, null), null);
  }
  // Failures must be marked as failures — a refusal styled like a success reads as "it worked".
  const t = makeT("en");
  assert.equal(flashFor(t, "claimed").bad, false);
  for (const bad of ["already_taken", "not_eligible", "no_such_slot", "not_yours", "handed_back_late"]) {
    assert.equal(flashFor(t, bad).bad, true, `${bad} should be styled as a problem`);
  }
});

test("the board never offers a slot that has already happened", withWorld({}, async (w) => {
  const { people, signIn, csrfFrom, db, today } = w;
  makeAvailable(w, people[0]);
  // Make the person available on a date before the clock, then confirm it is not offered.
  const past = db.prepare("SELECT MIN(date) d FROM sessions").get().d;
  setAvailabilityDay(db, people[0], past, true);
  const w2 = await makeWorld({ today: "2026-06-01" });
  try {
    makeAvailable(w2, w2.people[0]);
    setAvailabilityDay(w2.db, w2.people[0], past, true);
    const { body } = await w2.csrfFrom("/board", await w2.signIn(w2.people[0]));
    const offeredIds = [...body.matchAll(/action="\/board\/(\d+)\/claim"/g)].map((m) => Number(m[1]));
    const dates = offeredIds.map((id) => db.prepare(`SELECT s.date FROM assignments a JOIN sessions s ON s.id=a.session_id WHERE a.id=?`).get(id)?.date);
    for (const d of dates) if (d) assert.ok(d >= "2026-06-01", `offered a past slot: ${d}`);
  } finally { w2.close(); }
}));


// ---- increment E wiring: handing a slot back must announce it, and must survive a dead webhook ---------
const withNotifier = ({ fail = false, volunteers = 3 } = {}) => {
  const stub = stubTransport({ fail });
  return {
    stub,
    opts: {
      volunteers,
      // A factory, because the notifier needs the database makeWorld is about to create.
      notifier: (db) => makeNotifier({
        db, fetchImpl: stub.fetchImpl, log: {},
        config: notifyConfig({ MATTERMOST_WEBHOOK: "https://chat.example.org/hooks/SECRETPATH" }),
      }),
    },
  };
};

// Claim the first slot on the board and return its id plus a signed-in cookie.
async function claimFirst(w, personId) {
  makeAvailableEverywhere(w.db, personId, w.today);
  const cookie = await w.signIn(personId);
  const { token, body } = await w.csrfFrom("/board", cookie);
  const id = Number(body.match(/action="\/board\/(\d+)\/claim"/)[1]);
  await w.post(`/board/${id}/claim`, cookie, new URLSearchParams({ csrf: token }));
  return { cookie, token, id };
}

test("handing a slot back announces it, naming how many others could take it", async () => {
  const { stub, opts } = withNotifier();
  const w = await makeWorld(opts);
  try {
    for (const p of w.people) makeAvailableEverywhere(w.db, p, w.today);
    const { cookie, token, id } = await claimFirst(w, w.people[0]);

    const before = stub.calls.length;
    const r = await w.post(`/slot/${id}/hand-back`, cookie, new URLSearchParams({ csrf: token }));
    assert.equal(reasonOf(r), "handed_back");

    const call = await waitFor(() => (stub.calls.length > before ? stub.calls.at(-1) : null));
    assert.match(call.body, /Open slot|Ledig vagt/);
    // All three are available and capable, so three people can take it. The count is what makes the
    // message actionable instead of noise.
    assert.match(call.body, /\b3\b/, `the message should say how many can take it: ${call.body}`);
    assert.equal(w.db.prepare("SELECT status FROM notifications WHERE kind='slot_open'").get().status, "sent");
  } finally { w.close(); }
});

test("a dead webhook does not break handing a slot back", async () => {
  const { stub, opts } = withNotifier({ fail: true, volunteers: 1 });
  const w = await makeWorld(opts);
  try {
    const { cookie, token, id } = await claimFirst(w, w.people[0]);
    const r = await w.post(`/slot/${id}/hand-back`, cookie, new URLSearchParams({ csrf: token }));

    assert.equal(r.status, 303, "a dead webhook must not become an error page");
    assert.equal(reasonOf(r), "handed_back");
    assert.equal(w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id, null,
      "the slot really was released — reporting otherwise would make the volunteer retry");

    const row = await waitFor(() => w.db.prepare("SELECT status, error FROM notifications WHERE kind='slot_open'").get());
    assert.equal(row.status, "failed", "and the failure is recorded rather than lost");
    assert.ok(stub.calls.length > 0);
  } finally { w.close(); }
});

test("no notifier configured at all: the board still works", async () => {
  const w = await makeWorld({ notifier: null });
  try {
    const { cookie, token, id } = await claimFirst(w, w.people[0]);
    const r = await w.post(`/slot/${id}/hand-back`, cookie, new URLSearchParams({ csrf: token }));
    assert.equal(reasonOf(r), "handed_back");
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM notifications").get().n, 0);
  } finally { w.close(); }
});

// ---- WHY the shift exchange is empty ---------------------------------------------------------------------
// "There are no open slots you can take right now" is true in every case and actionable in none. The case that
// prompted this: a volunteer invited into a partner-dance department, given a capability, who has not yet said
// whether they teach as leader or follower, is ineligible for every slot on every class — correctly — and the
// page told them nothing at all. They would reasonably conclude the app was broken, or that nobody needed them.
//
// What matters is that the reasons are DISTINGUISHABLE. A diagnostic that says "no_availability" for every
// cause is the same uselessness with more words, so each case is pinned separately.
test("an empty board explains itself, and the reasons are distinguishable", withWorld({ volunteers: 2 }, async (w) => {
  const { boardEmptyReason } = await import("../src/queries.mjs");
  const me = w.people[0];
  const reason = () => boardEmptyReason(w.db, me, w.seasonId, w.today).reason;

  // makeWorld gives every volunteer a capability for the first activity, so start by removing it.
  w.db.prepare("DELETE FROM capabilities WHERE person_id=?").run(me);
  assert.equal(reason(), "no_capabilities", "nobody has said what they can run — an admin has to act");

  // Capable, but nothing said about when they can help.
  const act = w.db.prepare("SELECT id FROM activities WHERE key=?").get(w.pattern.activities[0].key).id;
  w.db.prepare("INSERT OR IGNORE INTO capabilities (person_id, activity_id) VALUES (?,?)").run(me, act);
  const roled = w.db.prepare(`SELECT COUNT(*) n FROM assignments a JOIN sessions s ON s.id=a.session_id
                               WHERE s.activity_id=? AND a.role IS NOT NULL`).get(act).n;
  if (roled > 0) {
    // Every slot on this activity carries a role, so an unstated role empties the board before availability
    // is even consulted — which is exactly the case that went unexplained.
    w.db.prepare("UPDATE people SET preferred_role=NULL WHERE id=?").run(me);
    assert.equal(reason(), "no_role_stated", "an unstated dance role must be named, not left as silence");

    // Stating only one role is a different situation with a different remedy: those slots are genuinely
    // somebody else's, and telling them to go and set a role they already set would be nonsense.
    w.db.prepare("UPDATE assignments SET role='f' WHERE role IS NOT NULL").run();
    w.db.prepare("UPDATE people SET preferred_role='l' WHERE id=?").run(me);
    assert.equal(reason(), "only_the_other_role");
    w.db.prepare("UPDATE people SET preferred_role='b' WHERE id=?").run(me);
  }

  // Now the role gate passes and availability is the binding one.
  assert.equal(reason(), "no_availability", "never answered is different from answered no");

  // Answering "cannot" everywhere is a DIFFERENT reason: the remedy is to correct a stale answer, not to
  // enter one for the first time.
  for (const { date } of w.db.prepare("SELECT DISTINCT date FROM sessions").all()) {
    setAvailabilityDay(w.db, me, date, false);
  }
  assert.equal(reason(), "not_free_then");

  // Available everywhere and slots open: no longer empty, so there is nothing to explain.
  makeAvailable(w, me);
  const { openSlotsFor } = await import("../src/queries.mjs");
  assert.ok(openSlotsFor(w.db, me, w.seasonId, w.today).length > 0, "the fixture must now offer something");

  // And with nothing open at all, the reason is about the plan rather than about them.
  w.db.prepare("UPDATE assignments SET person_id=? WHERE person_id IS NULL").run(w.people[1]);
  assert.equal(reason(), "none_open");
}));

test("the explanation reaches the page, with a way to act on it", withWorld({ volunteers: 2 }, async (w) => {
  const me = w.people[0];
  // Capable, no dance role, nothing answered: on a partner-dance config this is the unstated-role case, and
  // otherwise the no-availability one. Either way the page must say something and offer a link.
  w.db.prepare("UPDATE people SET preferred_role=NULL WHERE id=?").run(me);
  const body = await (await w.get("/board", await w.signIn(me))).text();

  assert.ok(!/board\.why\./.test(body), "an untranslated reason key must never render at a volunteer");
  assert.match(body, /There are openings|Nobody has recorded|Nothing is open/,
    `the empty board must explain itself:\n${body.slice(body.indexOf("Shift exchange"), body.indexOf("Shift exchange") + 700)}`);
  assert.match(body, /href="\/me"|href="\/availability"/, "and offer the screen that fixes it");
}));
