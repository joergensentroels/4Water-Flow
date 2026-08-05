// The vagtbørs. One screen for the whole exchange, because after the "everyone is equal" decision an open
// slot and a handed-back slot are the same thing: a slot with no person that I am eligible for. So the page
// is "slots you could take" above "slots you have", and there is no separate swap flow.
import { html } from "../http.mjs";
import { layout, formatDate, formatTime, formatRole, csrfField, navFor } from "../views.mjs";

// Outcome codes from claimSlot/handBackSlot mapped to what the volunteer should read. Kept as a table
// rather than inline strings so an unmapped reason is a visible gap instead of a blank flash.
//
// THREE states, not two, and `handed_back_late` is the reason.
//
// It used to be `bad: true`, reading "Too late to hand this back — message the planner." The slot was already
// released by then: handBackSlot sets person_id to NULL, returns ok, and the route goes on to announce it on the
// exchange. So the volunteer got an error banner saying the thing had not happened, about a thing that had.
// Measured at one day and at zero days before the shift: released both times, told it was too late both times.
//
// The cost is not confusion, it is double cover or none. Read as a refusal, the volunteer believes they are still
// on the hook and turns up — to a shift that is now on the board and may already have been taken. Or they message
// the planner about a slot the planner can see is open, and neither of them can tell whether anybody is coming. In
// an app whose entire job is knowing who turns up, a success reported as a failure is the most expensive sentence
// it can print.
//
// `warn` rather than no emphasis at all: it DID succeed, so `bad` is untrue, but short notice is precisely when a
// banner needs reading rather than skimming.
const OUTCOME = {
  claimed: { key: "board.claimOk" },
  handed_back: { key: "board.handedBackOk" },
  handed_back_late: { key: "board.pastCutoff", warn: true },
  already_taken: { key: "board.claimed", bad: true },
  not_eligible: { key: "board.notEligible", bad: true },
  no_such_slot: { key: "board.noSuchSlot", bad: true },
  not_yours: { key: "board.notYours", bad: true },
};

export function flashFor(t, code) {
  const o = OUTCOME[code];
  return o ? { text: t(o.key), bad: !!o.bad, warn: !!o.warn } : null;
}

// `emptyReason` is only consulted when `open` is empty, and defaults to null so a caller that does not compute
// it still renders a valid page — just without the explanation.
export function renderBoard({ t, session, roles, who, open, mine, flash, emptyReason = null }) {
  // The button's accessible name carries the slot. The row beside it says which shift this is, and a screen
  // reader arriving at the button on its own does not get the row: over a season this page rendered "Take this
  // slot, button" 178 times with nothing to tell them apart, and taking the wrong shift is a commitment to be
  // somewhere on a particular evening. Found by an audit that derives controls from the page (test/names.test.mjs)
  // after the same fault was fixed on two other screens — a list kept by hand would not have named this one.
  const slotRow = (r, action, label, extra = "") => {
    const which = `${formatDate(t, r.date)} ${formatTime(r.hour, r.minute)} · ${r.activityLabel}${formatRole(t, r.role)}`;
    return html`
    <li><div class="daterow">
      <span class="when">
        <b>${formatDate(t, r.date)}</b>
        <small>${formatTime(r.hour, r.minute)} · ${r.activityLabel}${formatRole(t, r.role)}${extra}</small>
      </span>
      <form method="post" action="${action}">
        ${csrfField(session)}
        <button type="submit" class="secondary" aria-label="${label} — ${which}">${label}</button>
      </form>
    </div></li>`;
  };

  const body = html`
    <h2>${t("board.title")}</h2>
    ${open.length === 0
      ? html`
        <!-- WHY it is empty, and what to do about it. "No open slots you can take" is true whether nothing is
             open or eleven things are open and the volunteer never said which role they teach — and only one of
             those is theirs to fix. The reason comes from the same eligibility gates as the rule, so it cannot
             drift into telling them something false.
             The generic line is shown ONLY as the fallback. Printing both read as a contradiction — "there are
             no open slots you can take. there are openings, but…" — which I noticed by reading the page rather
             than by counting assertions. -->
        ${emptyReason ? html`
          <div class="card">
            <p>${t(`board.why.${emptyReason}`)}</p>
            ${emptyReason === "no_role_stated" || emptyReason === "only_the_other_role"
              ? html`<p><a class="btn secondary" href="/me">${t("board.why.fixMe")}</a></p>` : ""}
            ${emptyReason === "no_availability" || emptyReason === "not_free_then"
              ? html`<p><a class="btn secondary" href="/availability">${t("board.why.fixAvailability")}</a></p>` : ""}
          </div>`
        : html`<p class="empty">${t("board.empty")}</p>`}`
      : html`<ul class="dates">${open.map((r) => slotRow(r, `/board/${r.assignmentId}/claim`, t("board.claim")))}</ul>`}

    <h2>${t("board.mine")}</h2>
    ${mine.length === 0
      ? html`<p class="empty">${t("board.mineEmpty")}</p>`
      : html`<ul class="dates">${mine.map((r) => slotRow(r, `/slot/${r.assignmentId}/hand-back`, t("board.handBack")))}</ul>`}`;

  return layout({ t, title: t("board.title"), who, nav: navFor(t, roles, "board"), flash, body });
}
