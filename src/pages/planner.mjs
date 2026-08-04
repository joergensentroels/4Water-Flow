// The planner's grid. Phone-usable, because the person fixing a Sunday-morning dropout is holding a phone —
// this is not a back-office-only screen, and treating it as one is why the spreadsheet is a nightmare.
//
// It is a list of days, not a table: a real grid of 6 activities x 26 weeks cannot be read on a 375px screen,
// and a horizontally scrolling table is the exact thing being replaced.
import { html, raw } from "../http.mjs";
import { layout, formatDate, formatTime, formatRole, csrfField, navFor } from "../views.mjs";

const OUTCOME = {
  roster_done: { key: "planner.rosterDone" },
  roster_empty: { key: "planner.nothingToPropose" },
  locked: { key: "planner.locked" },
  discarded: { key: "planner.discarded" },
  assigned: { key: "planner.assigned" },
  assigned_unanswered: { key: "planner.assignedUnanswered" },
  unassigned: { key: "planner.unassigned" },
  changed: { key: "planner.changed", bad: true },
  said_no: { key: "planner.saidNo", bad: true },
  not_capable: { key: "planner.notCapable", bad: true },
  wrong_role: { key: "planner.wrongRole", bad: true },
  already_booked: { key: "planner.alreadyBooked", bad: true },
  no_such_slot: { key: "board.noSuchSlot", bad: true },
  no_such_person: { key: "planner.noSuchPerson", bad: true },
};

// `vars` carries the counts for the roster outcomes ({filled}, {gaps}, {n}), so the message can say what
// actually happened instead of "done".
export function plannerFlash(t, code, vars) {
  const o = OUTCOME[code];
  return o ? { text: t(o.key, vars), bad: !!o.bad } : null;
}

function byDate(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.date === r.date) last.items.push(r);
    else out.push({ date: r.date, items: [r] });
  }
  return out;
}

export function renderPlanner({ t, session, roles, who, rows, eligibleByAssignment, flash, gapsOnly, weeks = 4, pendingProposals = 0 }) {
  const days = byDate(rows);

  // Auto-roster controls. Lock-in and discard only appear when there is something to decide about, because a
  // permanently visible "discard" invites an accidental click that throws away real work.
  const rosterControls = html`
    <div class="card">
      <form method="post" action="/planner/auto-roster">
        ${csrfField(session)}
        <button type="submit" class="secondary">${t("planner.autoRoster")}</button>
      </form>
      ${pendingProposals === 0 ? "" : html`
        <p class="hint">${t("planner.proposalsPending", { n: pendingProposals })}</p>
        <form method="post" action="/planner/proposals/lock">
          ${csrfField(session)}<button type="submit">${t("planner.lockIn")}</button>
        </form>
        <form method="post" action="/planner/proposals/discard">
          ${csrfField(session)}<button type="submit" class="secondary">${t("planner.discard")}</button>
        </form>`}
    </div>`;

  const filled = (r) => html`
    <span class="when">
      ${formatTime(r.hour, r.minute)} · ${r.activityLabel}${formatRole(t, r.role)}
      <small>${r.personName}${r.state === "proposed" ? ` · ${t("plan.proposed")}` : ""}</small>
    </span>
    <form method="post" action="/planner/unassign">
      ${csrfField(session)}
      <input type="hidden" name="assignmentId" value="${r.assignmentId}">
      <input type="hidden" name="expect" value="${r.personId}">
      <button type="submit" class="secondary">${t("planner.unassign")}</button>
    </form>`;

  // For an open slot, offer the people the rule says could take it. A <select> plus one button is the whole
  // interaction: no drag and drop, nothing that needs a mouse or JavaScript.
  const open = (r) => {
    const people = eligibleByAssignment.get(r.assignmentId) ?? [];
    return html`
      <span class="when">
        ${formatTime(r.hour, r.minute)} · ${r.activityLabel}${formatRole(t, r.role)}
        <small>${people.length === 0 ? t("planner.noneEligible") : t("planner.eligibleFairest", { n: people.length })}</small>
      </span>
      ${people.length === 0 ? "" : html`
        <form method="post" action="/planner/assign">
          ${csrfField(session)}
          <input type="hidden" name="assignmentId" value="${r.assignmentId}">
          <input type="hidden" name="expect" value="">
          <select name="personId" aria-label="${t("planner.choose")}">
            ${people.map((p) => html`<option value="${p.id}">${p.name} (${p.score})</option>`)}
          </select>
          <button type="submit">${t("planner.assign")}</button>
        </form>`}`;
  };

  const body = days.length === 0
    ? html`<p class="empty">${t("planner.empty")}</p>`
    : html`
      <h2>${t("planner.title")}</h2>
      ${rosterControls}
      <p class="hint">
        <a href="/planner?weeks=${weeks ?? "all"}${gapsOnly ? "" : "&gaps=1"}">${gapsOnly ? t("planner.showAll") : t("planner.showGaps")}</a>
      </p>
      <!-- Chips, not three words of underlined prose. These were inline links about 17px tall with a single
           space between them: WCAG 2.2 SC 2.5.8 wants a target of at least 24x24 CSS px or enough spacing to
           keep 24px circles from overlapping, and on a phone they were simply hard to hit accurately. They
           also never showed WHICH horizon you were looking at, so the page silently lied about its own state
           after the 4-week default was introduced. aria-current carries that for a screen reader. -->
      <p class="hint" id="horizon-label">${t("planner.horizon")}</p>
      <div class="chiprow" role="group" aria-labelledby="horizon-label">
        ${[4, 12, "all"].map((wk) => {
          const current = String(weeks ?? "all") === String(wk);
          return html`<a class="chip" href="/planner?weeks=${wk}${gapsOnly ? "&gaps=1" : ""}"${current ? raw(' aria-current="true"') : ""}>${
            wk === "all" ? t("planner.horizonAll") : t("planner.horizonWeeks", { n: wk })}</a>`;
        })}
      </div>
      ${days.map((d) => html`
        <div class="card">
          <b>${formatDate(t, d.date)}</b>
          <ul class="dates">${d.items.map((r) => html`
            <li><div class="daterow">${r.personId == null ? open(r) : filled(r)}</div></li>`)}</ul>
        </div>`)}`;

  return layout({ t, title: t("planner.title"), who, nav: navFor(t, roles, "planner"), flash, body });
}
