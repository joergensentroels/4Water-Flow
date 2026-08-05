// A string that EXPLAINS something can be false while rendering perfectly.
//
// Three of these shipped, and one of them was written in the same increment as a comment warning against
// exactly this failure:
//
//   - /status said "{n} messages are queued (no webhook is configured)" unconditionally. notify.mjs writes the
//     row as queued BEFORE calling the webhook, so an interrupted send leaves queued rows on an instance whose
//     webhook is fine, and the operator was sent to check a setting that was never the problem.
//   - the outbox banner said "nothing here was actually delivered" while the list underneath it showed rows
//     marked Sent.
//   - the planner said "Nobody has said they are free yet" when nobody was CAPABLE, or the slot needed the
//     other role, or everyone was already booked — three cases where they had all said they were free.
//
// No amount of rendering catches these. `t()` returns the string, the page shows it, every assertion about
// "does the page explain itself" passes. The only thing that catches them is somebody asking "is that true?",
// and having now failed to ask three times — once while writing about it — I do not trust that to judgment.
//
// So this is a NO-SILENT-ADDITIONS gate, in the same spirit as the seams scanner and the translation-family
// list. Any string that explains a cause must be listed here with a note saying what makes it true. The gate
// cannot verify the note; it can only guarantee that nobody adds an explanation without writing one down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStrings } from "../src/config.mjs";
import { BOARD_EMPTY_REASONS, SLOT_EMPTY_REASONS } from "../src/queries.mjs";

// Constructions that EXPLAIN a state, as opposed to naming one. "No answer yet" is a state; ", so there is
// nothing to offer you" is a claim about why.
//
// Deliberately NARROW, and that is the whole design: a gate that catches a dozen strings is one somebody reads
// before adding to it, and a gate that catches sixty is one that gets rubber-stamped. The count is asserted below
// rather than written here as prose — this comment used to say "ten hits out of 249 strings" and the second number
// was 262 by the time anybody looked, which is exactly the rot this file exists to prevent, in this file.
const MAX_EXPLAINING = 20;

// The strings that must be justified whatever their wording, because their job IS to assert a cause. Built from
// the constants the app returns, so the set cannot drift from what can actually reach a screen.
const ROLE_REQUIRED = new Set([
  ...Object.values(BOARD_EMPTY_REASONS).map((c) => `board.why.${c}`),
  ...Object.values(SLOT_EMPTY_REASONS).map((c) => `planner.why.${c}`),
]);

const EXPLAINS = [
  /\bbecause\b/i, /,\s*so\b/i, /—\s*so\b/i, /\bmeans\b/i,
  /\busually\b/i, /\bprobably\b/i, /\bis configured\b/i, /\bnobody has\b/i,
  /\bnever\b/i, /\balways\b/i,
];

// key -> what makes the claim true. Written to be checkable by a reader, so each names the condition or the
// code that guarantees it, not just a restatement of the string.
const JUSTIFIED = {
  // ---- the reason families -------------------------------------------------------------------------------
  // Two of these fifteen were justified and thirteen were not, and the reason is worth keeping: whether the guard
  // below noticed a string depended on whether its WORDING matched one of ten hand-kept regexes. "nobody has" and
  // an em-dash "— so" got caught; "there are openings, but only on dates you have said you cannot help" did not.
  // These strings exist for exactly one purpose, which is to assert a cause, so the guard now requires them by
  // ROLE — every reason code the source can emit — instead of by phrasing. See the test at the bottom.
  //
  // What makes all of them true is one mechanism, so it is stated once here rather than thirteen times:
  // boardEmptyReason and slotEmptyReason add the GATE fragments one at a time in GATE_ORDER and report the gate
  // that takes the count to zero. So a reason is returned ONLY when its gate is the binding one and every earlier
  // gate passed — which is what licenses each string to name one cause and one remedy. The gates come from the
  // same GATE object as the eligibility rule itself, so the explanation cannot drift from the rule.
  "board.why.no_capabilities":
    "boardEmptyReason only returns this when the capability gate is the binding one AND the person has zero " +
    "capability rows. Both conditions are counted, not assumed.",
  "board.why.nothing_in_your_activities":
    "The other half of the same split: capability is the binding gate but the person HAS capabilities, so the " +
    "openings are real and belong to activities they do not run. 'Not yours to take' is true of the gate, not a " +
    "judgement — the claim guard refuses the same slots.",
  "board.why.none_open":
    "Returned before any gate is applied, when the count with GATE.open alone is zero. So it is a statement about " +
    "the season and not about this volunteer, which is why it is the one reason that suggests no action they " +
    "could take. 'Fully staffed' is exactly what zero open assignment rows means.",
  "board.why.no_role_stated":
    "The role gate is binding and preferred_role is unset. Both halves matter: with the role gate binding, the " +
    "remaining openings really do need a stated role, so 'they will appear here' is a promise the app can keep " +
    "once they answer — the later gates have already been shown to pass.",
  "board.why.no_availability":
    "The availability gate is binding and the person has no answer at all for those dates. 'They will appear " +
    "here' holds for the same reason as above: every gate before availability passed, so availability is the " +
    "only thing standing between them and those slots.",
  "board.why.not_free_then":
    "The availability gate is binding and there IS an answer — a 'cannot' one. That is the distinction from " +
    "no_availability, and it is why this text says to correct an answer rather than to give one. Silence and " +
    "'no' are different states here by design (CONTRIBUTING rule 4), and this pair is where a volunteer sees it.",
  "board.why.already_busy_then":
    "The double-booking gate is binding, which means capability, role and availability all passed: they could " +
    "take these slots except that they are already on something at the same hour. Nothing for them to fix, which " +
    "is why this is the one reason with no suggested remedy.",
  "planner.why.no_volunteers":
    "slotEmptyReason returns this before applying any gate, when no active volunteer exists at all. It is about " +
    "the roster rather than the slot — and 'active' is load-bearing: a deactivated volunteer is not counted, " +
    "consistent with every other consumer of the roster.",
  "planner.why.nobody_capable":
    "SLOT_REASON_BY_GATE maps the capable gate to this, and the loop only reaches it when the capable gate is the " +
    "binding one. 'Add it in Administration' is the actual remedy: capabilities are granted on /admin, and a " +
    "planner cannot grant one from the planning screen.",
  "planner.why.nobody_in_that_role":
    "The role gate is binding, so people who could otherwise run this activity exist and are free — the slot " +
    "needs the other half of a pair. 'Availability is not the problem' is not a guess: the availability gate is " +
    "applied after this one and has not been reached.",
  "planner.why.nobody_free":
    "The availability gate is binding — the one case where the message the whole reason family replaced was " +
    "actually true. Capability and role passed, so the people who could run it exist and have said they cannot " +
    "help then, or said nothing.",
  "planner.why.all_already_busy":
    "The double-booking gate is binding: every remaining candidate is available and capable and already assigned " +
    "at that hour. 'Move it' is the remedy because the constraint is the clash, not the person — and this is the " +
    "last gate, so nothing further can be the cause.",
  "board.why.only_the_other_role":
    "Returned only when the role gate empties the list and preferred_role is set — so the slots really do need " +
    "the other half, and telling them to go and state a role would be nonsense.",
  "board.notEligible":
    "Hedged on purpose. claimSlot returns not_eligible only after confirming the row is still unclaimed, so the " +
    "person was eligible when the board rendered and is not now: a stale page is the honest common cause, and " +
    "the wording says 'probably' rather than asserting it.",
  "privacy.rights":
    "GET /me exists for every signed-in person and POST /me writes name and contact, so 'always see and " +
    "correct' is true of the app as built. Deletion is deliberately NOT claimed as self-service.",
  "privacy.attendance":
    "Three separate guarantees, each with code behind it. 'After a shift': markAttendance returns not_yet when " +
    "date >= today, and the control only renders for past shifts. 'Never used to decide what you are offered': " +
    "eligiblePeopleFor, autoRoster and isActive all read score(), which counts confirmed assignments and does " +
    "not look at `attended` — test/attendance.test.mjs asserts marking attendance leaves score() unchanged. " +
    "'A planner can change it back': null is an accepted value, which is why the column is nullable.",
  "privacy.changes":
    "'What changed, when, who': the audit row carries action, at, actor_name and detail, and the AUDITED list is " +
    "held against the route table so the coverage is not a promise. 'Kept longer than messages': retentionConfig " +
    "asserts auditDays > notificationDays and a test fails if that inverts. 'Your name comes out of it': " +
    "erasePerson calls pseudonymiseAuditActor AND scrubAuditDetail in both modes, checked in both directions — " +
    "the rows survive and the name does not.",
  "admin.holidaysNone":
    "holidayConfig() returns country: null both when the section is absent and when the code is unrecognised, and " +
    "suppressed() short-circuits on a null country — so 'no dates are suppressed' is what the seeding loop " +
    "actually does, not a guess. Asserted directly: an unknown country leaves Christmas Day unsuppressed.",
  "status.seasonEmpty":
    "Reached only when the season row EXISTS, covers today, and COUNT(*) over its sessions is 0 — all three " +
    "counted in collectStatus, none assumed. 'That is why every screen is empty' is then a fact about this app " +
    "rather than a guess: every plan view scopes by season_id, so a season with no sessions can only render " +
    "empty. Found on the running demo, where this state showed a green tick and '0 of 0 slots unfilled'.",
  "status.queued":
    "Chosen only when notify.channel === 'outbox', i.e. when MATTERMOST_WEBHOOK really is unset. The " +
    "unconditional version of this sentence is the bug this file exists to prevent.",
  "status.queuedInterrupted":
    "Chosen only when a webhook IS configured and rows are still queued. notify.mjs inserts 'queued' before " +
    "the POST, so an interrupted process is genuinely the likely cause — hence 'usually', not 'means'.",
  "calendar.what":
    "A one-off .ics import is a snapshot by definition; only a subscription re-fetches. True of every calendar " +
    "client, not of anything this app controls.",
  "calendar.alreadyOn":
    "Only the SHA-256 hash is stored (calendar.mjs), so the raw token is unrecoverable by construction and " +
    "'cannot be shown again' is a fact about the schema.",
  "calendar.noTimezone":
    "Shown only when calendarConfig(pattern).configured is false, in which case the feed really does fall back " +
    "to UTC — the fallback is UTC precisely so that being wrong is visible.",
  "planner.notYet":
    "markAttendance refuses with not_yet only when the session's date is >= today, so 'has not happened yet' is " +
    "the actual condition that produced the message rather than a guess at it. The control is not even rendered " +
    "on a future row — this string is what a stale page or a hand-made request gets.",
  "planner.nobodyOnIt":
    "Returned only when the assignment row exists and person_id IS NULL, which is precisely 'nobody is on it'. " +
    "Distinguished from no_such_slot, which is a row that does not exist at all — conflating the two would send a " +
    "planner looking for a slot that is right there in front of them.",
  "outbox.noWebhook":
    "Scoped to rows still marked not-sent. It must NOT claim anything about the whole page: with history, or " +
    "after a webhook is removed, 'sent' rows are visible in the list directly beneath this banner.",
  "admin.eraseHint":
    "Both modes do release future shifts: anonymise calls releaseFutureShifts (admin.mjs), and remove deletes " +
    "the person row, which frees every assignment that pointed at it. 'Not yet done' is date >= today, so past " +
    "assignments survive anonymisation — which is what makes 'keeps who ran what in the past' true, and " +
    "'past slots read as unfilled too' true of remove alone. The sentence used to describe only the effect on " +
    "past slots and say nothing about the future shifts either mode frees, which is the half an admin needs " +
    "before pressing something irreversible.",
};

test("every string that explains a cause is justified, and no new one slips in unexplained", () => {
  const en = loadStrings("en");
  const explaining = Object.entries(en)
    .filter(([, v]) => EXPLAINS.some((m) => m.test(v)))
    .map(([k]) => k)
    .sort();

  const unjustified = explaining.filter((k) => !(k in JUSTIFIED));
  assert.deepEqual(unjustified, [],
    "these strings explain WHY something is the case, and nothing here records what makes that true.\n" +
    "Rendering them proves nothing — a false explanation renders exactly as well as a true one. Add each to\n" +
    "JUSTIFIED in test/claims.test.mjs naming the condition that guarantees it, or reword it to describe the\n" +
    "state instead of its cause:\n  " + unjustified.join("\n  "));

  // The reverse: a justification for a string that no longer explains anything is stale bookkeeping.
  // The reverse: a justification for a string that no longer explains anything is stale bookkeeping.
  //
  // Except the reason codes. Those are required by ROLE rather than by wording — see the test at the bottom of
  // this file — so most of them are deliberately not matched by the narrow patterns above, and asking them to be
  // would mean rewording thirteen volunteer-facing sentences to satisfy a regex. They cannot go stale silently
  // either: that test checks the family in both directions against the constants the code actually emits, which
  // is a stronger guarantee than this one, not a weaker one.
  const stale = Object.keys(JUSTIFIED)
    .filter((k) => !ROLE_REQUIRED.has(k))
    .filter((k) => !explaining.includes(k));
  assert.deepEqual(stale, [],
    `justified but no longer explanatory — reword the note or drop it:\n  ${stale.join("\n  ")}`);

  // There was very nearly a third check here — "justified but the key has been deleted entirely" — which reads
  // like a distinct failure and is not one. `explaining` is derived FROM `en`, so a key that no longer exists in
  // `en` cannot be in `explaining`, and `stale` above has already caught it. Adding a bogus JUSTIFIED entry
  // proved it: `stale` fired, the orphan check was never reached. An assertion that cannot fail is worse than no
  // assertion, because it reads as coverage. If you want the message to distinguish the two cases, widen
  // `stale`'s message rather than adding a branch that cannot run.

  // The gate's own design constraint, enforced rather than described. Its value comes from being small enough
  // that a person actually reads the list before adding to it; past a couple of dozen it becomes a formality and
  // the next false explanation walks straight through. If this fails, the answer is probably to reword some
  // strings to describe a state instead of its cause — not to raise the ceiling.
  assert.ok(explaining.length <= MAX_EXPLAINING,
    `${explaining.length} strings now explain a cause, past the ${MAX_EXPLAINING} this gate stays useful below. ` +
    `A list this long gets rubber-stamped, which is the failure it was built to prevent.`);
});

test("each justification names a condition rather than restating the string", () => {
  const en = loadStrings("en");
  for (const [key, note] of Object.entries(JUSTIFIED)) {
    assert.ok(note.length >= 80, `${key}: the note is too short to say what makes the claim true`);
    // A note that just repeats the message has not checked anything. Requiring a pointer at the mechanism —
    // a function, a file, a column, a config field, or an explicit condition — is a cheap proxy for having
    // actually looked.
    // Naming an HTTP route counts as naming the mechanism — the first version of this list omitted GET/POST
    // and rejected a justification that pointed straight at two routes.
    // There WAS a third assertion here: the note had to contain a token from a list — "only when", a filename,
    // an HTTP verb — as a proxy for "you looked at the mechanism". It was removed after rejecting three correct
    // notes in a row and catching nothing.
    //
    // It failed on "GET /me exists…" (a slash is not a word character, so "GET " inside \b could not match), on
    // "a one-off .ics import is a snapshot by definition" (the guarantee is external to this codebase, which
    // the list did not allow for), and on "Scoped to rows still marked not-sent…" (sound reasoning, none of my
    // vocabulary). Each rejection was a false positive. A gate whose only observed effect is rejecting correct
    // work is friction wearing the costume of safety — which is precisely the kind of plausible-but-useless
    // mechanism this file exists to argue against, so keeping it would have been self-refuting.
    //
    // What remains is what can honestly be checked mechanically: the note is substantive, and it is not the
    // string with different punctuation. Whether the reasoning is CORRECT is a reader's job, and the value of
    // the gate is that it forces a reader to have one to look at.
    assert.ok(!note.includes(en[key]), `${key}: the note is a copy of the string, not a justification`);
  }
});

// A different way for a string to be false: sending somebody to a screen that does not exist under that name.
//
// invite.intro — the first sentence a new volunteer ever reads — said "Accept it to set up your volunteer page".
// This app has no volunteer page. Its own name for that screen is "Me", its title is "Your details", and the
// established way of pointing at it is board.why.fixMe, "Go to your own page". The sentence also misdescribed what
// happens: accepting lands on Availability. Written while I was updating the record that names this the largest
// defect class in the project, which is the third time that has happened and the reason this is a test now rather
// than a resolution to be careful.
//
// The names the app shows are derivable — the nav labels and the page titles — so this needs no list of its own.
test("no string sends somebody to a page the app never names", () => {
  const en = loadStrings("en");
  const shown = new Set(Object.entries(en)
    .filter(([k]) => /^nav\./.test(k) || /\.title$/.test(k))
    .map(([, v]) => String(v).toLowerCase()));
  assert.ok(shown.size >= 8, `only ${shown.size} names found — this check would pass by knowing nothing`);

  // "your own page" and "the next screen" are positional rather than names, which is exactly why the four strings
  // that already did this used them. Anything else reading like a screen name has to be one the app shows.
  const POSITIONAL = new Set(["own", "same", "next", "previous", "planning"]);
  const bad = [];
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== "string") continue;
    for (const m of value.matchAll(/\b(?:your|the|a)\s+([a-z][a-z ]{2,28}?)\s+(?:page|screen|tab|section)\b/gi)) {
      const name = m[1].trim().toLowerCase();
      if (!shown.has(name) && !POSITIONAL.has(name)) bad.push(`${key}: "${m[0]}"`);
    }
  }
  assert.deepEqual(bad, [],
    "these strings name a page the app does not show anywhere — a volunteer would go looking for it:\n  " +
    bad.join("\n  "));
});

// The Danish strings are translations of the English ones, so they inherit the claims rather than making new
// ones. What must hold is that a translation does not ADD an explanation the English does not make — which is
// how a locale ends up asserting something the code never guaranteed.
test("no locale invents an explanation the primary language does not make", () => {
  const en = loadStrings("en");
  const da = loadStrings("da");
  const explains = (v) => EXPLAINS.some((m) => m.test(v));
  // Danish equivalents of the same constructions.
  const DA_EXPLAINS = [/\bfordi\b/i, /,\s*så\b/i, /—\s*så\b/i, /\bbetyder\b/i, /\boftest\b/i,
                       /\bsandsynligvis\b/i, /\ber sat op\b/i, /\bingen har\b/i, /\baldrig\b/i, /\baltid\b/i];
  const added = Object.keys(da).filter((k) =>
    DA_EXPLAINS.some((m) => m.test(da[k])) && k in en && !explains(en[k]) && !(k in JUSTIFIED));
  assert.deepEqual(added, [],
    `these Danish strings explain something their English counterparts do not:\n  ${added.join("\n  ")}`);
});

// The gate above decides by WORDING, and that narrowness is deliberate — a gate catching sixty strings is one
// that gets rubber-stamped. But one family of strings is causal by construction rather than by phrasing: the
// reason codes. Their entire job is to name which rule is the binding one, and the app has already shipped a
// false one — "Nobody has said they are free yet" when nobody was capable, which is why the family exists.
//
// Measured before this was written: 2 of 15 reason strings had a justification, and the wording gate was blind to
// all 13 that did not. Whether a string was covered came down to whether it happened to contain "nobody has" or
// an em-dash "so". So these are required by ROLE instead, enumerated from the same exported constants the
// functions return — a new reason code cannot ship without somebody writing down what makes it true, in the same
// way a new gate cannot ship without a reason code.
test("every reason code the app can emit has a recorded justification", () => {
  const en = loadStrings("en");
  const families = [["board.why.", BOARD_EMPTY_REASONS], ["planner.why.", SLOT_EMPTY_REASONS]];

  const keys = families.flatMap(([prefix, codes]) => Object.values(codes).map((c) => prefix + c));
  assert.ok(keys.length >= 13, `expected the app to define many reason codes, saw ${keys.length}`);

  const missingString = keys.filter((k) => !(k in en));
  assert.deepEqual(missingString, [], `reason codes with no translation — a volunteer would see the key: ${missingString}`);

  const unjustified = keys.filter((k) => !(k in JUSTIFIED));
  assert.deepEqual(unjustified, [],
    "these strings tell somebody WHICH rule is stopping them, and nothing here records what makes that true:\n  " +
    unjustified.join("\n  "));

  // Both directions: a justification for a reason code that no longer exists is stale coverage, and it would sit
  // here looking like the family was fully accounted for.
  const orphans = Object.keys(JUSTIFIED).filter((k) => /^(board|planner)\.why\./.test(k) && !keys.includes(k));
  assert.deepEqual(orphans, [], `justified reason codes the app can no longer emit — remove them: ${orphans}`);
});
