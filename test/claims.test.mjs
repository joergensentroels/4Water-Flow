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

// Constructions that EXPLAIN a state, as opposed to naming one. "No answer yet" is a state; ", so there is
// nothing to offer you" is a claim about why.
//
// Deliberately NARROW, and that is the whole design: a gate that catches a dozen strings is one somebody reads
// before adding to it, and a gate that catches sixty is one that gets rubber-stamped. The count is asserted below
// rather than written here as prose — this comment used to say "ten hits out of 249 strings" and the second number
// was 262 by the time anybody looked, which is exactly the rot this file exists to prevent, in this file.
const MAX_EXPLAINING = 20;
const EXPLAINS = [
  /\bbecause\b/i, /,\s*so\b/i, /—\s*so\b/i, /\bmeans\b/i,
  /\busually\b/i, /\bprobably\b/i, /\bis configured\b/i, /\bnobody has\b/i,
  /\bnever\b/i, /\balways\b/i,
];

// key -> what makes the claim true. Written to be checkable by a reader, so each names the condition or the
// code that guarantees it, not just a restatement of the string.
const JUSTIFIED = {
  "board.why.no_capabilities":
    "boardEmptyReason only returns this when the capability gate is the binding one AND the person has zero " +
    "capability rows. Both conditions are counted, not assumed.",
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
  "outbox.noWebhook":
    "Scoped to rows still marked not-sent. It must NOT claim anything about the whole page: with history, or " +
    "after a webhook is removed, 'sent' rows are visible in the list directly beneath this banner.",
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
  const stale = Object.keys(JUSTIFIED).filter((k) => !explaining.includes(k));
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
