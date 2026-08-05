// One session, and the notes on it.
//
// A SEPARATE PAGE rather than an expander on the plan, and the reason is the defect this project has shipped twice:
// /planner rendered 534 KB and /admin 953 KB by putting a form on every row. Notes on the plan would be a textarea
// and a CSRF token per session — 173 sessions in the measured season — which is the same mistake a third time.
//
// It also gives shift swaps somewhere to live later: "who is on this, and what has been said about it" is the page
// two volunteers arranging a swap both need, and neither the grid nor the board is that page.
import { html } from "../http.mjs";
import { layout, csrfField, navFor, formatDate, formatTime, formatRole } from "../views.mjs";
import { noteList, NOTE_MAX } from "../notes.mjs";

const OUTCOME = {
  note_added: { key: "notes.added" },
  note_deleted: { key: "notes.deleted" },
  empty_note: { key: "notes.empty", bad: true },
  note_too_long: { key: "notes.tooLong", bad: true },
  not_your_note: { key: "notes.notYours", bad: true },
  no_such_note: { key: "notes.noSuchNote", bad: true },
};

export function sessionFlash(t, code) {
  const o = OUTCOME[code];
  return o ? { text: t(o.key, { max: NOTE_MAX }), bad: !!o.bad } : null;
}

export function renderSession({ t, session, roles, who, me, detail, people, notes, flash, canWrite }) {
  const when = `${formatDate(t, detail.date)} ${formatTime(detail.hour, detail.minute)}`;
  const body = html`
    <h2>${detail.activityLabel}</h2>
    <p class="hint">${when}</p>

    <div class="card">
      <b>${t("session.who")}</b>
      ${people.length === 0
        ? html`<p class="empty">${t("session.nobody")}</p>`
        : html`<ul class="dates">${people.map((p) => html`
            <li><div class="daterow"><span class="when">
              <b>${p.name ?? t("slot.open")}</b><small>${formatRole(t, p.role) || ""}</small>
            </span></div></li>`)}</ul>`}
    </div>

    <h3>${t("notes.title")}</h3>
    <p class="hint">${t("notes.hint")}</p>
    ${noteList(t, notes, { me, session, formatWhen: (at) => at.slice(0, 16).replace("T", " ") })}

    <!-- The form is offered only to somebody who can be on this shift — a signed-in volunteer. Not gated on being
         assigned to it: the person who might TAKE the shift is exactly who needs to ask a question about it, and
         the shift exchange is one click away. -->
    ${canWrite ? html`
      <form method="post" action="/session/${detail.id}/note" class="card">
        ${csrfField(session)}
        <label for="note-body">${t("notes.add")}</label>
        <textarea id="note-body" name="body" rows="3" maxlength="${NOTE_MAX}" required
                  placeholder="${t("notes.placeholder")}"></textarea>
        <p class="hint">${t("notes.limit", { max: NOTE_MAX })}</p>
        <button type="submit">${t("notes.post")}</button>
      </form>` : ""}

    <p><a class="btn secondary" href="/plan">${t("nav.plan")}</a></p>`;

  return layout({ t, title: `${detail.activityLabel} · ${when}`, who, nav: navFor(t, roles, "plan"), flash, body });
}
