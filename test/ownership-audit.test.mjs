// The third leg of a tripod this repository already has two of.
//
// test/csrf-audit.test.mjs asks "does every POST verify a token", test/authz-audit.test.mjs asks "does every route
// gate on the right ROLE". Neither asks the question a role check cannot answer: **can one volunteer act on another
// volunteer's row through a route they are perfectly entitled to call?** Every route here is one a plain volunteer
// is supposed to reach. The role gate says yes and is right to; what stops them touching somebody else's shift is a
// separate guard inside the handler, written by hand, once per route.
//
// The authz audit is STRUCTURALLY BLIND to this, and it is worth naming why: it fills `:id` with the literal `1` and
// asserts only `notEqual(status, 403)` for the role that is allowed. A volunteer successfully deleting the admin's
// note would satisfy it exactly as well as correct behaviour does.
//
// NOTHING IS WRONG. Every guard exists and every one has a test — board.test.mjs:134, notes.test.mjs, and
// calendar.test.mjs cover the three behaviours from the feature's side. This exists for the route that does not
// exist yet: shift swaps are the next thing 4water asked to keep in mind, a swap is by definition one volunteer
// reaching for another's shift, and today it could land with no ownership guard and nothing would fail.
//
// SO THE COMPLETENESS HALF IS DERIVED and the behaviour half is not. Every route the app registers with a path
// parameter must appear in exactly one of the two maps below: NOT_PERSON_SCOPED, with a reason, or PROBES, with a
// function that actually tries the attack. A new parameterised route is in neither and the first test fails. That
// is the only arrangement in which the list cannot go quietly out of date, which is the failure this project has
// now corrected in four other places.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, csrfFromCookie } from "../tools/testkit.mjs";
import { setAvailabilityDay } from "../src/queries.mjs";
import { listNotes } from "../src/notes.mjs";
import { calendarTokenFor } from "../src/calendar.mjs";

const world = () => makeWorld({ volunteers: 3, roles: { 0: ["planner"] } });
const reasonOf = (res) => new URL(res.headers.get("location"), "http://x").searchParams.get("r");
const aSession = (w) => w.db.prepare("SELECT id FROM sessions WHERE season_id=? ORDER BY date LIMIT 1").get(w.seasonId).id;

// Eligible for every upcoming date. BOTH volunteers in every probe get this, and that is the point rather than
// setup noise: if the attacker is merely ineligible, the route refuses them for a reason that has nothing to do
// with ownership, and the probe passes while proving nothing. A refusal has to be traced to the guard under test.
function makeAvailable(w, personId) {
  for (const { date } of w.db.prepare("SELECT DISTINCT date FROM sessions WHERE date >= ? ORDER BY date").all(w.today)) {
    setAvailabilityDay(w.db, personId, date, true);
  }
}

const anOpenSlot = async (w, cookie) => {
  const body = await (await w.get("/board", cookie)).text();
  const m = body.match(/action="\/board\/(\d+)\/claim"/);
  assert.ok(m, "the board offered no claimable slot, so this probe would test nothing");
  return Number(m[1]);
};
const ownerOf = (w, id) => w.db.prepare("SELECT person_id FROM assignments WHERE id=?").get(id).person_id;

// Routes whose path parameter does not name a row belonging to one person. Each needs a reason, because "it looked
// fine" is how the other two audits' exception lists would have grown.
const NOT_PERSON_SCOPED = new Map([
  ["GET /invite/:token", "the token IS the authorization and there is no account yet — nobody to own anything"],
  ["POST /invite/:token/accept", "same; possession of an unguessable token is the credential, tested in auth.test.mjs"],
  ["GET /session/:id", "the season plan is visible to every volunteer by design — that is what a shared rota is"],
  ["POST /session/:id/note", "a note is ADDED to a shared session, not to somebody's row. Authorship matters only "
    + "when deleting, which is POST /note/:id/delete below"],
  ["GET /admin/person/:id/export.json", "admin-gated: an administrator exporting any volunteer's data is the "
    + "feature, not a leak. Who may call it is authz-audit's question and it answers it"],
]);

// The attack, once per route, in the same three beats every time: the owner establishes the row, the other
// volunteer tries it and must be refused FOR THE RIGHT REASON, the row must be untouched, and then the owner must
// succeed. The last beat is the control — without it a route that refuses everybody passes the whole file.
const PROBES = new Map([
  ["POST /slot/:id/hand-back", async (w) => {
    const [a, b] = [await w.signIn(w.people[1]), await w.signIn(w.people[2])];
    makeAvailable(w, w.people[1]);
    makeAvailable(w, w.people[2]);
    const id = await anOpenSlot(w, a);
    assert.equal(reasonOf(await w.post(`/board/${id}/claim`, a, new URLSearchParams({ csrf: csrfFromCookie(a) }))),
      "claimed", "the owner could not take the slot, so there is nothing to defend");

    const refused = await w.post(`/slot/${id}/hand-back`, b, new URLSearchParams({ csrf: csrfFromCookie(b) }));
    assert.equal(reasonOf(refused), "not_yours",
      "another volunteer released a shift that was not theirs, or was refused for some other reason");
    assert.equal(ownerOf(w, id), w.people[1], "the slot changed hands anyway");

    assert.equal(reasonOf(await w.post(`/slot/${id}/hand-back`, a, new URLSearchParams({ csrf: csrfFromCookie(a) }))),
      "handed_back", "the OWNER cannot hand it back either — the refusal above was not about ownership");
  }],

  ["POST /board/:id/claim", async (w) => {
    const [a, b] = [await w.signIn(w.people[1]), await w.signIn(w.people[2])];
    makeAvailable(w, w.people[1]);
    makeAvailable(w, w.people[2]);
    const id = await anOpenSlot(w, a);
    await w.post(`/board/${id}/claim`, a, new URLSearchParams({ csrf: csrfFromCookie(a) }));

    // B is eligible for this slot and would be allowed to claim it if it were free. The only obstacle is that it
    // is somebody else's, so `already_taken` is the ownership guard speaking and `not_eligible` would not be.
    const refused = await w.post(`/board/${id}/claim`, b, new URLSearchParams({ csrf: csrfFromCookie(b) }));
    assert.equal(reasonOf(refused), "already_taken",
      "an eligible volunteer took a slot that already belonged to someone else");
    assert.equal(ownerOf(w, id), w.people[1], "the assignment was overwritten");

    const other = await anOpenSlot(w, b);
    assert.equal(reasonOf(await w.post(`/board/${other}/claim`, b, new URLSearchParams({ csrf: csrfFromCookie(b) }))),
      "claimed", "B cannot claim ANY slot, so the refusal above says nothing about ownership");
  }],

  ["POST /note/:id/delete", async (w) => {
    const [a, b] = [await w.signIn(w.people[1]), await w.signIn(w.people[2])];
    const sid = aSession(w);
    await w.post(`/session/${sid}/note`, a, new URLSearchParams({ csrf: csrfFromCookie(a), body: "the owner's" }));
    const id = listNotes(w.db, sid)[0].id;

    const refused = await w.post(`/note/${id}/delete`, b, new URLSearchParams({ csrf: csrfFromCookie(b) }));
    assert.equal(reasonOf(refused), "not_your_note", "another volunteer deleted words they did not write");
    assert.equal(listNotes(w.db, sid).length, 1, "the note went anyway");

    assert.equal(reasonOf(await w.post(`/note/${id}/delete`, a, new URLSearchParams({ csrf: csrfFromCookie(a) }))),
      "note_deleted", "the AUTHOR cannot delete it either — the refusal above was not about authorship");
  }],

  ["GET /calendar/:token.ics", async (w) => {
    makeAvailable(w, w.people[1]);
    makeAvailable(w, w.people[2]);
    const [a, b] = [await w.signIn(w.people[1]), await w.signIn(w.people[2])];

    // Each volunteer takes a DIFFERENT shift. Both must really exist, because the whole question is whether one
    // credential can see the other's, and a feed cannot leak a shift nobody holds.
    const mineId = await anOpenSlot(w, a);
    assert.equal(reasonOf(await w.post(`/board/${mineId}/claim`, a, new URLSearchParams({ csrf: csrfFromCookie(a) }))),
      "claimed");
    const theirsId = await anOpenSlot(w, b);
    assert.notEqual(theirsId, mineId, "both volunteers were handed the same slot, so there are no two feeds to compare");
    assert.equal(reasonOf(await w.post(`/board/${theirsId}/claim`, b, new URLSearchParams({ csrf: csrfFromCookie(b) }))),
      "claimed");

    // A token is a credential, so the ownership question is not "may B call this" — B may, that is the design —
    // but "does A's credential return only A's shifts". A feed keyed on the token and scoped to the whole season
    // would pass every other test in this repository.
    const token = (id) => calendarTokenFor(w.db, id).token;   // returns { token, existing }, and the raw value once
    const feedOf = async (id) => (await w.get(`/calendar/${token(id)}.ics`)).text();
    const mine = await feedOf(w.people[1]);

    // NOT by name: an ICS event here carries UID and SUMMARY, and SUMMARY is the activity label. No person's name
    // appears in a feed at all, so asserting the other volunteer's name is absent would pass against a feed
    // serving the entire season — which is what the first version of this probe did.
    assert.ok(mine.includes(`UID:assignment-${mineId}@`), "the owner's own shift is missing from their own feed");
    assert.ok(!mine.includes(`UID:assignment-${theirsId}@`),
      `A's calendar credential returned B's shift (assignment ${theirsId})`);

    // The control: that UID must be somewhere a correct implementation puts it, or its absence above only means the
    // shift does not exist.
    assert.ok((await feedOf(w.people[2])).includes(`UID:assignment-${theirsId}@`),
      "B's own feed does not contain B's shift either, so A's feed omitting it proves nothing");
  }],
]);

test("every route with a path parameter is either person-scoped and probed, or excused with a reason", async () => {
  const w = await world();
  try {
    const parameterised = w.routes()
      .map((r) => `${r.method} ${r.pattern}`)
      .filter((k) => /:\w+/.test(k));

    assert.ok(parameterised.length >= 8,
      `expected the app to register several parameterised routes, saw ${parameterised.length} — if this is 0 the ` +
      `whole file is checking nothing`);

    const unaccounted = parameterised.filter((k) => !NOT_PERSON_SCOPED.has(k) && !PROBES.has(k));
    assert.deepEqual(unaccounted, [],
      `these routes take an id and nobody has decided whether it names one person's row: ${unaccounted}. Either ` +
      `add a PROBE that tries to act on another volunteer's row through it, or list it in NOT_PERSON_SCOPED with ` +
      `the reason it cannot be abused that way. A shift swap route would land exactly here`);

    const both = parameterised.filter((k) => NOT_PERSON_SCOPED.has(k) && PROBES.has(k));
    assert.deepEqual(both, [], `listed as unownable and probed for ownership at once: ${both}`);

    // The other direction, so an entry cannot outlive its route and sit here looking like coverage.
    const stale = [...NOT_PERSON_SCOPED.keys(), ...PROBES.keys()].filter((k) => !parameterised.includes(k));
    assert.deepEqual(stale, [], `named here but no longer registered — remove the entry: ${stale}`);
  } finally { w.close(); }
});

for (const [route, probe] of PROBES) {
  test(`${route} refuses a volunteer acting on another volunteer's row`, async () => {
    const w = await world();
    try { await probe(w); } finally { w.close(); }
  });
}
