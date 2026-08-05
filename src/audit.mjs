// Who changed the plan, or somebody else's record, and when.
//
// Two planners share one grid and an administrator can hand out privilege, deactivate somebody or erase them
// outright. None of that left a trace: the optimistic-concurrency `expect` fields stop two planners clobbering
// each other silently, but afterwards nothing could say who unassigned a volunteer, or when a role was granted.
//
// WHAT IS LOGGED, and the rule rather than a list: an action that changes the PLAN, or another person's record,
// or the configuration. Ordinary use by a volunteer on their own data is not logged — see the comment on the
// table in db.mjs for why that is a deliberate privacy choice rather than an omission.
//
// The list below is the decision, and test/audit.test.mjs holds it against the app's own route table: a POST
// that changes one of those things and calls no audit must either be added here or named as an exception with a
// reason. That is the same shape as the CSRF exception list and the public-route list — the alternative is a
// hand-kept list of what to check, which this project has removed three times for being unable to notice a gap.
export const AUDITED = {
  // the plan
  "/planner/assign": "a planner put somebody on a shift",
  "/planner/unassign": "a planner took somebody off a shift, which is the action nobody could attribute before",
  "/planner/auto-roster": "a machine wrote proposals across the season",
  "/planner/proposals/lock": "proposals became the plan",
  "/planner/proposals/discard": "proposals were thrown away",
  "/planner/attendance": "somebody was recorded as having turned up, or not. This one is a statement ABOUT a "
    + "volunteer that feeds their contribution record, so who made it matters as much as what it says",
  "/board/:id/claim": "a volunteer took an open shift — their own action, but it changes the plan",
  "/slot/:id/hand-back": "a volunteer gave a shift back, which is how a covered slot becomes uncovered",
  // another person's record
  "/admin/role": "privilege was granted or removed",
  "/admin/capability": "somebody became able, or unable, to run an activity",
  "/admin/status": "somebody was stood down or brought back, which releases or does not release their shifts",
  "/admin/erase": "a person was anonymised or deleted — the one action with no undo",
  "/admin/invite": "somebody was invited onto the roster",
  "/admin/invite/revoke": "an invitation was withdrawn",
  // the configuration
  "/admin/season": "the season's shape changed",
  "/admin/activity": "an activity was added",
  "/admin/weekly/add": "a slot was added to the weekly rhythm",
  "/admin/weekly/remove": "a slot was removed from the weekly rhythm",
  "/admin/retention": "how long data is kept was changed",
};

// POSTs that deliberately write nothing to the audit, each with the reason. A route missing from both this and
// AUDITED fails the test rather than passing quietly.
export const NOT_AUDITED = {
  "/auth/dev": "a sign-in, and only in development. Sessions are not the audit's subject.",
  "/invite/:token/accept": "somebody accepting their own invitation. The invitation's own row records that it "
    + "was accepted and by whom, and the admin.invite entry records who invited them.",
  "/signout": "a sign-out changes nothing anybody else relies on.",
  "/availability": "a volunteer's own availability answers. Ordinary use, changes nothing others depend on, and "
    + "logging it would record every change of mind about a single date.",
  "/availability/bulk": "the same answers as above, entered for many dates at once. Exempt for the same reason: "
    + "they are the volunteer's own, and nobody else's plan depends on them until a slot is claimed or assigned.",
  "/me": "a volunteer editing their own name and contact details.",
  "/me/calendar": "a volunteer creating or revoking their own calendar link. The token itself is never stored "
    + "in the clear anywhere, and it must not appear here either.",
};

// One writer, so the shape cannot drift between call sites. `actorName` is stored as it was, because a hard
// erasure removes the person and an audit row pointing at nobody is not an audit row.
//
// `detail` is for a human reading the page. It must never carry a secret — no invite tokens, no calendar tokens,
// no session values. notify.mjs learned that the hard way when a webhook URL reached an error column that is
// rendered on a screen.
export function recordAudit(db, { actorId = null, actorName, action, subject = null, detail = null, at = new Date() }) {
  db.prepare(`INSERT INTO audit (at, actor_id, actor_name, action, subject, detail)
              VALUES (:at, :actor, :name, :action, :subject, :detail)`)
    .run({
      at: at.toISOString(),
      actor: actorId,
      name: String(actorName ?? "").trim() || "system",
      action: String(action),
      subject: subject === null ? null : String(subject),
      detail: detail === null ? null : String(detail).slice(0, 300),
    });
}

// Newest first, capped. An audit page that renders a season of activity on a phone is the same defect as the
// planner grid that rendered half a megabyte, so the cap is here rather than left to the caller.
export const AUDIT_PAGE = 100;

export const listAudit = (db, { limit = AUDIT_PAGE } = {}) =>
  db.prepare(`SELECT id, at, actor_id AS actorId, actor_name AS actorName, action, subject, detail
                FROM audit ORDER BY at DESC, id DESC LIMIT :n`).all({ n: Math.min(limit, AUDIT_PAGE) });

export const countAudit = (db) => db.prepare("SELECT COUNT(*) n FROM audit").get().n;

// Erasure's half of the bargain. The rows stay — that is the point of an audit — but the name goes, replaced by
// the same #id label `people` uses, so "who did this" remains answerable as a person without naming them.
// Called from erasePerson for BOTH modes: anonymise keeps the row it pseudonymises, and remove deletes the
// people row, after which actor_id becomes NULL and the stored name would be the only thing left pointing at a
// human being.
export function pseudonymiseAuditActor(db, personId) {
  return db.prepare("UPDATE audit SET actor_name = :label WHERE actor_id = :pid AND actor_name <> :label")
    .run({ label: `#${personId}`, pid: personId }).changes;
}

// The other half, and the half that was missing. Pseudonymising the ACTOR left `detail` alone, and one action
// wrote an email address into it: after a hard erasure the log still said `invited someone@example.org` beside a
// deleted `people` row and an `invitations` row scrubbed to 'erased'. Measured, not assumed — a probe invited an
// address, erased the person, and found the row intact.
//
// The writer is fixed (see createInvite), so nothing new arrives here. This sweeps rows ALREADY written, which
// matters because upgrading does not rewrite history and any deployment that has invited somebody has such a row.
//
// Derived rather than enumerated: it removes the address wherever it appears instead of naming the actions that
// might carry one. A list of "details that mention people" cannot notice a new detail that mentions people.
//
// The NAME is deliberately not swept. Substring replacement on a short name corrupts unrelated text — "Ole"
// occurs inside "role", which every one of these details is full of — and a corrupted audit trail is worse than
// a frank one. Nothing writes a name into a detail, and test/audit.test.mjs holds that as an assertion rather
// than leaving it to habit.
export function scrubAuditDetail(db, personId, contact) {
  const needle = String(contact ?? "").trim();
  // A missing or trivially short contact must not sweep anything. Without this guard an empty needle matches
  // every row — the failure mode where a fix quietly rewrites the whole table and reports a big tidy number.
  if (needle.length < 5) return 0;
  return db.prepare(`UPDATE audit SET detail = REPLACE(detail, :needle, :label)
                      WHERE detail IS NOT NULL AND instr(detail, :needle) > 0`)
    .run({ needle, label: `#${personId}` }).changes;
}
