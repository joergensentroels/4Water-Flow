// Read-only views: the volunteer's own slots, and the whole season. Both are one query each — a per-row
// lookup would be invisible at 40 volunteers and painful at 200, and the fix is much cheaper written now.
import { html } from "../http.mjs";
import { layout, formatDate, formatTime, formatRole, csrfField, navFor } from "../views.mjs";

// Group a flat result set by date so the markup can be a list of days rather than a table nobody can read
// on a phone. Rows arrive already ordered, so this preserves order without sorting again.
function byDate(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.date === r.date) last.items.push(r);
    else out.push({ date: r.date, items: [r] });
  }
  return out;
}

const slotLine = (t, r) => html`${formatTime(r.hour, r.minute)} · ${r.activityLabel}${formatRole(t, r.role)}`;

export function renderHome({ t, session, roles, who, mine, score, flash }) {
  const body = html`
    <h2>${t("home.mine")}</h2>
    ${mine.length === 0
      ? html`<p class="empty">${t("home.mineEmpty")}</p>`
      : html`<ul class="dates">${mine.map((r) => html`
          <li><div class="daterow">
            <span class="when"><b>${formatDate(t, r.date)}</b><small>${slotLine(t, r)}</small></span>
            ${r.state === "proposed" ? html`<span class="choice">${t("plan.proposed")}</span>` : ""}
          </div></li>`)}</ul>`}

    <div class="card">
      <b>${score}</b> — ${t("score.label")}
      <br><small>${score > 0 ? t("score.active") : t("score.inactive")}</small>
    </div>

    <p><a class="btn" href="/availability">${t("nav.availability")}</a></p>
    <p><a class="btn secondary" href="/board">${t("nav.board")}</a></p>
    <form method="post" action="/signout">${csrfField(session)}
      <p><button type="submit" class="secondary">${t("signin.out")}</button></p>
    </form>`;
  return layout({ t, title: t("home.title"), who, nav: navFor(t, roles, "home"), flash, body });
}

export function renderPlan({ t, roles, who, rows, personId, notes = new Map() }) {
  const days = byDate(rows);
  const body = days.length === 0
    ? html`<p class="empty">${t("plan.empty")}</p>`
    : html`
      <h2>${t("plan.title")}</h2>
      ${days.map((d) => html`
        <div class="card">
          <b>${formatDate(t, d.date)}</b>
          <ul class="dates">${d.items.map((r) => html`
            <li><div class="daterow">
              <span class="when">
                ${slotLine(t, r)}
                <small>${r.personId == null
                  ? t("slot.open")
                  : (r.personId === personId ? t("plan.you") : r.personName)}</small>
              </span>
              <!-- A LINK, never a form. Notes live on their own page: a textarea and a CSRF token per row is
                   exactly how /planner reached 534 KB and /admin 953 KB, and this page renders a whole season.
                   The count arrives from ONE query covering every session on the page — see noteCounts. -->
              <a class="chip" href="/session/${r.sessionId}" aria-label="${
                t("plan.openSession")} — ${formatDate(t, r.date)} ${slotLine(t, r)}">${
                notes.get(r.sessionId) ? t("plan.notes", { n: notes.get(r.sessionId) }) : t("plan.openSession")}</a>
            </div></li>`)}</ul>
        </div>`)}`;
  return layout({ t, title: t("plan.title"), who, nav: navFor(t, roles, "plan"), body });
}
