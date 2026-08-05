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

// `status` is here because the page used to decide "active" from the SCORE alone, and the two are different facts.
//
// Reproduced before fixing: a volunteer with 17 past shifts this season is stood down mid-season. The admin action
// releases their 32 FUTURE shifts and deliberately keeps the past ones as the record of what they did — so the score
// stays at 17, and this card said **"Active volunteer"** while every operational path treated them as gone: no
// availability nudge, no slots on the board, no calendar feed, excluded from the auto-roster. Every statement was
// true on its own (the score is 17, 17 > 0, the label reflects the score); composed, the page told somebody the
// opposite of what the system believed about them.
//
// The score claim is now conditional on the status, and — the more useful half — a stood-down volunteer is TOLD.
// Before this they got no indication at all: their upcoming list simply emptied, the nudges stopped, and the page
// called them active. The only reading available to them was that the app was broken.
export function renderHome({ t, session, roles, who, mine, score, status = "active", flash }) {
  const onRoster = status === "active";
  const body = html`
    ${onRoster ? "" : html`<div class="flash bad">
      <b>${t("home.standDown")}</b><br><small>${t("home.standDownWhy")}</small>
    </div>`}

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
      <br><small>${onRoster && score > 0 ? t("score.active") : t("score.inactive")}</small>
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
      ${days.map((d) => {
        // ONE LINK PER SESSION, not per row. A partner dance needs a leader and a follower, which is two assignment
        // rows on one session — so the first version rendered two adjacent links to the same page with different
        // accessible names, a screen reader announcing the same destination twice with the role swapped. Found by
        // looking at the rendered page rather than by any test.
        //
        // No activity name in this comment: the seams gate forbids department vocabulary in src/, and it caught the
        // first version of these lines for naming one of 4water's dances. Another department's copy has others.
        const linked = new Set();
        return html`
        <div class="card">
          <b>${formatDate(t, d.date)}</b>
          <ul class="dates">${d.items.map((r) => {
            const first = !linked.has(r.sessionId);
            linked.add(r.sessionId);
            return html`
            <li><div class="daterow">
              <span class="when">
                ${slotLine(t, r)}
                <small>${r.personId == null
                  ? t("slot.open")
                  : (r.personId === personId ? t("plan.you") : r.personName)}</small>
              </span>
              <!-- A LINK, never a form. Notes live on their own page: a textarea and a CSRF token per row is
                   exactly how /planner reached 534 KB and /admin 953 KB, and this page renders a whole season.
                   The count arrives from ONE query covering every session on the page — see noteCounts.
                   The LABEL is "Details" rather than "Open" because slot.open is ALSO "Open" in English, on this
                   same page, meaning the opposite thing: nobody has taken it. Danish never had the collision.
                   NO BACKTICKS IN THIS COMMENT — it sits inside a template literal, so one ends the string and
                   makes this file a SyntaxError. db.mjs carries the same warning over the schema, I read it, and
                   I still did it here: the tell was the whole suite hanging rather than any test failing. -->
              ${first ? html`<a class="chip" href="/session/${r.sessionId}" aria-label="${
                t("plan.openSession")} — ${formatDate(t, r.date)} ${slotLine(t, r)}">${
                notes.get(r.sessionId) ? t("plan.notes", { n: notes.get(r.sessionId) }) : t("plan.openSession")}</a>` : ""}
            </div></li>`;
          })}</ul>
        </div>`;
      })}`;
  return layout({ t, title: t("plan.title"), who, nav: navFor(t, roles, "plan"), body });
}
