// The audit trail, read by a person.
//
// The rows were written, covered by tests and disclosed in the privacy notice for three commits before anything
// rendered them — `listAudit` sat imported into server.mjs and unused. That is the same defect as the notification
// outbox and the attendance control before it: **a feature whose data has no reachable screen**, which is worse
// than not having it, because an administrator told "everything is logged" believes the question can be answered.
// Three times now, so it is worth saying what the tell is: an export or a query helper with no caller.
//
// ADMIN ONLY, and not planner. Two planners sharing a grid is exactly the case the log exists for, so the argument
// for showing it to them is real — but the same rows carry who was stood down, who was erased and who was given
// privilege, which is administration rather than planning. A planner who needs to know who unassigned a volunteer
// can ask an admin; the reverse mistake, putting one volunteer's erasure in front of every planner, cannot be
// undone by asking.
//
// NO SEARCH BOX, on purpose. The obvious one — LIKE over actor_name, action and detail — would not find a person
// by name, because names are not stored in those columns: the rows say `person:3` and the name is resolved at
// render time. Typing "Anna" would return nothing and an admin would conclude nothing had happened to her. A
// filter that answers the most likely question wrongly is worse than no filter, so paging is all this offers
// until it can resolve names into ids first.
import { html } from "../http.mjs";
import { layout, navFor } from "../views.mjs";
import { describeRef } from "../audit.mjs";

export function renderAudit({ t, session, roles, who, rows, labels, total, retentionDays, older = null, newest = true }) {
  const gone = t("audit.gone");

  // The action is shown as its stable identifier — `planner.attendance` — with the human sentence beside it from
  // the strings file. Both, because the identifier is what a person would grep for in the database or quote in a
  // question, and the sentence is what makes the page readable to a board member who has never seen the code.
  const row = (r) => html`
    <li class="auditrow">
      <p class="auditmeta">
        <b>${t(`audit.action.${r.action}`)}</b>
        · <span class="auditwho">${r.actorName}</span>
        · <time datetime="${r.at}">${r.at.slice(0, 16).replace("T", " ")}</time>
      </p>
      ${r.subject ? html`<p class="auditsubject">${describeRef(labels, r.subject, gone)}</p>` : ""}
      ${r.detail ? html`<p class="hint">${describeRef(labels, r.detail, gone)}</p>` : ""}
      <p class="auditaction"><code>${r.action}</code></p>
    </li>`;

  const body = html`
    <h2>${t("audit.title")}</h2>
    <p class="hint">${t("audit.intro", { n: total })}</p>
    <p class="hint">${t("audit.retention", { n: retentionDays })}</p>

    ${rows.length === 0
      ? html`<p class="empty">${t("audit.empty")}</p>`
      : html`<ul class="audit">${rows.map(row)}</ul>`}

    <div class="chiprow">
      ${newest ? "" : html`<a class="chip" href="/audit">${t("audit.newest")}</a>`}
      ${older ? html`<a class="chip" href="/audit?before=${encodeURIComponent(older.at)}&beforeId=${older.id}">${
        t("audit.older")}</a>` : ""}
    </div>
    <p><a class="btn secondary" href="/admin">${t("nav.admin")}</a></p>`;

  return layout({ t, title: t("audit.title"), who, nav: navFor(t, roles, "audit"), body });
}
