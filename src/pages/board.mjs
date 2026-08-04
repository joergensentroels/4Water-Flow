// The vagtbørs. One screen for the whole exchange, because after the "everyone is equal" decision an open
// slot and a handed-back slot are the same thing: a slot with no person that I am eligible for. So the page
// is "slots you could take" above "slots you have", and there is no separate swap flow.
import { html } from "../http.mjs";
import { layout, formatDate, formatTime, formatRole, csrfField, navFor } from "../views.mjs";

// Outcome codes from claimSlot/handBackSlot mapped to what the volunteer should read. Kept as a table
// rather than inline strings so an unmapped reason is a visible gap instead of a blank flash.
const OUTCOME = {
  claimed: { key: "board.claimOk" },
  handed_back: { key: "board.handedBackOk" },
  handed_back_late: { key: "board.pastCutoff", bad: true },
  already_taken: { key: "board.claimed", bad: true },
  not_eligible: { key: "board.notEligible", bad: true },
  no_such_slot: { key: "board.noSuchSlot", bad: true },
  not_yours: { key: "board.notYours", bad: true },
};

export function flashFor(t, code) {
  const o = OUTCOME[code];
  return o ? { text: t(o.key), bad: !!o.bad } : null;
}

// `emptyReason` is only consulted when `open` is empty, and defaults to null so a caller that does not compute
// it still renders a valid page — just without the explanation.
export function renderBoard({ t, session, roles, who, open, mine, flash, emptyReason = null }) {
  const slotRow = (r, action, label, extra = "") => html`
    <li><div class="daterow">
      <span class="when">
        <b>${formatDate(t, r.date)}</b>
        <small>${formatTime(r.hour, r.minute)} · ${r.activityLabel}${formatRole(t, r.role)}${extra}</small>
      </span>
      <form method="post" action="${action}">
        ${csrfField(session)}
        <button type="submit" class="secondary">${label}</button>
      </form>
    </div></li>`;

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
