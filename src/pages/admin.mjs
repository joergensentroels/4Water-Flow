// The admin screen. One page, four sections — a nonprofit's admin is a volunteer doing this twice a season,
// so discoverability beats density.
import { html, raw } from "../http.mjs";
import { layout, csrfField, navFor } from "../views.mjs";

const OUTCOME = {
  invited: { key: "admin.invited" },
  no_email: { key: "admin.noEmail", bad: true },
  revoked: { key: "admin.revoked" },
  saved: { key: "admin.saved" },
  last_admin: { key: "admin.lastAdmin", bad: true },
  bad_status: { key: "admin.badStatus", bad: true },
  no_such_role: { key: "admin.noSuchRole", bad: true },
  no_such_activity: { key: "admin.noSuchActivity", bad: true },
  no_such_person: { key: "admin.noSuchPerson", bad: true },
  invalid: { key: "admin.invalidConfig", bad: true },
  erased: { key: "admin.erased" },
  // Deactivating somebody frees the shifts they had not yet done, and the planner is the one who has to fill
  // them. Reporting a bare "saved" over fifty released shifts is the silence this project keeps closing.
  released: { key: "admin.released" },
  erase_bad_mode: { key: "admin.eraseBadMode", bad: true },
  retention_done: { key: "admin.retentionDone" },
  weekly_added: { key: "admin.weeklyAdded" },
  weekly_removed: { key: "admin.weeklyRemoved" },
  weekly_not_found: { key: "admin.weeklyNotFound", bad: true },
};

export function adminFlash(t, code, vars) {
  const o = OUTCOME[code];
  return o ? { text: t(o.key, vars), bad: !!o.bad } : null;
}

// `roster` carries the counts and the search term. Defaults describe an unfiltered, uncapped list so a caller
// that passes a plain array still renders — the search UI simply does not appear.
export function renderAdmin({ t, session, roles, who, people, invites, pattern, inviteLink, nextSeason, weeklyUse = {}, flash,
                             roster = { q: "", shown: people.length, matching: people.length, total: people.length, limit: "all" } }) {
  // `subject` is WHO or WHAT the button acts on, and it belongs in the accessible name. The card around the
  // button says it; a screen reader arriving at the button does not get the card. With four volunteers this page
  // announced "Remove entirely, button" four times over, and the same for every role grant, every capability
  // and every deactivation. Those are irreversible, or they hand out privilege — hearing the wrong one is not
  // a mistake the reader can undo by re-reading, which is what separates this from a cosmetic label problem.
  //
  // Positional and required rather than optional: every caller here acts on a specific person or slot, and a
  // default would let the next one omit it without anything noticing.
  const toggle = (action, fields, label, subject, cls = "secondary") => html`
    <form method="post" action="${action}">
      ${csrfField(session)}
      ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <button type="submit" class="${cls}" aria-label="${label} — ${subject}">${label}</button>
    </form>`;

  const body = html`
    <h2>${t("admin.title")}</h2>

    ${inviteLink ? html`
      <div class="card">
        <b>${t("admin.inviteLink")}</b>
        <p class="tokenbox">${inviteLink}</p>
        <!-- Relative when FOURWATER_BASE_URL is unset. The origin is deliberately NOT taken from the Host
             header: an invite token grants a session, and a forged Host would put this link on someone else's
             origin for the admin to email out in good faith. -->
        ${inviteLink.startsWith("http") ? "" : html`<p class="hint">${t("calendar.prefix")}</p>`}
      </div>` : ""}

    <h2>${t("admin.people")}</h2>
    <!-- Search plus a capped default. Twelve forms per person means 200 people was 953 KB of HTML on a screen
         meant to work from a phone — and unlike the planner's whole-season view, this was not something the
         admin had asked for. -->
    <form method="get" action="/admin" class="card">
      <label>${t("admin.findPerson")}
        <input type="search" name="q" value="${roster.q}" placeholder="${t("admin.findPlaceholder")}">
      </label>
      <button type="submit" class="secondary">${t("admin.find")}</button>
    </form>
    <p class="hint">${roster.q
      ? t("admin.matching", { shown: roster.shown, matching: roster.matching, total: roster.total })
      : t("admin.showing", { shown: roster.shown, total: roster.total })}</p>
    ${roster.shown < roster.matching ? html`
      <div class="chiprow" role="group">
        ${[25, 100, "all"].map((n) => html`<a class="chip" href="/admin?people=${n}${roster.q ? `&q=${encodeURIComponent(roster.q)}` : ""}"${
          String(roster.limit) === String(n) ? raw(' aria-current="true"') : ""}>${
          n === "all" ? t("admin.showAll") : t("admin.showN", { n })}</a>`)}
      </div>` : ""}
    ${people.map((p) => html`
      <div class="card">
        <b>${p.name}</b>
        <small> · ${p.status === "active" ? t("admin.active") : t("admin.inactive")}
          · ${p.linked ? t("admin.linked") : t("admin.notLinked")}</small>
        <p class="hint">
          ${t("admin.capabilities")}: ${p.can.length ? p.can.join(", ") : "—"}
        </p>
        <p class="hint">
          ${pattern.roles.map((role) => html`
            ${toggle("/admin/role", { personId: p.id, role, on: p.roles.includes(role) ? "0" : "1" },
                     `${p.roles.includes(role) ? "− " : "+ "}${t(`role.${role}`)}`, p.name)}`)}
        </p>
        <p class="hint">
          ${pattern.activities.map((a) => html`
            ${toggle("/admin/capability", { personId: p.id, key: a.key, on: p.can.includes(a.key) ? "0" : "1" },
                     `${p.can.includes(a.key) ? "− " : "+ "}${a.label}`, p.name)}`)}
        </p>
        ${toggle("/admin/status", { personId: p.id, status: p.status === "active" ? "inactive" : "active" },
                 p.status === "active" ? t("admin.inactive") : t("admin.active"), p.name)}
        <!-- The link names the person too. A screen reader user navigating by links list gets the names stripped
             of every surrounding card, and this one pulls somebody's entire personal record — four of them read
             "Download data" and went to four different volunteers. The buttons on this card were fixed first;
             links were outside what that audit looked at, which is the only reason this survived it. -->
        <p class="hint"><a href="/admin/person/${p.id}/export.json"
                           aria-label="${t("admin.export")} — ${p.name}">${t("admin.export")}</a></p>
        <details>
          <summary>${t("admin.erase")}</summary>
          <p class="hint">${t("admin.eraseHint")}</p>
          ${toggle("/admin/erase", { personId: p.id, mode: "anonymise" }, t("admin.eraseAnonymise"), p.name)}
          ${toggle("/admin/erase", { personId: p.id, mode: "remove" }, t("admin.eraseRemove"), p.name)}
        </details>
      </div>`)}

    <h2>${t("admin.invites")}</h2>
    <div class="card">
      <form method="post" action="/admin/invite">
        ${csrfField(session)}
        <label>${t("admin.inviteEmail")}
          <input type="email" name="email" required>
        </label>
        <button type="submit">${t("admin.invite")}</button>
      </form>
    </div>
    ${invites.map((i) => html`
      <div class="card">
        <b>${i.email}</b>
        <small> · ${i.acceptedAt ? `${t("admin.accepted")}${i.personName ? ` (${i.personName})` : ""}` : t("admin.pending")}</small>
        <!-- The audit that found the rest of these did NOT find this one: a fresh instance has fewer than two
             pending invites, so there was nothing to collide with. Fixed on the same grounds anyway, and the
             audit now seeds two invites so it is actually looking here. -->
        ${i.acceptedAt ? "" : toggle("/admin/invite/revoke", { id: i.id }, t("admin.revoke"), i.email)}
      </div>`)}

    <h2>${t("admin.retention")}</h2>
    <div class="card">
      <p class="hint">${t("admin.retentionHint", { seasons: pattern.retention?.seasons ?? 2, days: pattern.retention?.notificationDays ?? 90 })}</p>
      <form method="post" action="/admin/retention">${csrfField(session)}<button type="submit" class="secondary">${t("admin.retentionRun")}</button></form>
      <p class="hint"><a href="/planner/season.csv">${t("admin.exportSeason")}</a></p>
    </div>

    <h2>${t("admin.season")}</h2>
    <div class="card">
      <form method="post" action="/admin/season">
        ${csrfField(session)}
        <label>${t("admin.season")} <input name="seasonKey" value="${pattern.season.key}" required></label>
        <label><input type="date" name="seasonFrom" value="${pattern.season.from}" required></label>
        <label><input type="date" name="seasonTo" value="${pattern.season.to}" required></label>
        <label>${t("admin.cutoffDays")}
          <input type="number" name="cutoffDays" min="0" max="30" value="${pattern.board?.cutoffDays ?? 0}">
        </label>
        <button type="submit">${t("admin.save")}</button>
      </form>
    </div>

    <h2>${t("admin.weekly")}</h2>
    <p class="hint">${t("admin.weeklyHint")}</p>
    ${pattern.weekly.map((w) => {
      const used = weeklyUse[`${w.dayOfWeek}:${w.hour}:${w.minute ?? 0}`] ?? 0;
      return html`<div class="card">
        <b>${t.weekday(w.dayOfWeek)} ${String(w.hour).padStart(2, "0")}:${String(w.minute ?? 0).padStart(2, "0")}</b>
        <p class="hint">${w.activities.map((k) => pattern.activities.find((a) => a.key === k)?.label ?? k).join(", ")}</p>
        <p class="hint">${t("admin.weeklyUsed", { n: used })}</p>
        ${toggle("/admin/weekly/remove", { dayOfWeek: w.dayOfWeek, hour: w.hour, minute: w.minute ?? 0 },
                 t("admin.weeklyRemove"), `${t.weekday(w.dayOfWeek)} ${String(w.hour).padStart(2, "0")}:${String(w.minute ?? 0).padStart(2, "0")}`)}
      </div>`;
    })}
    <div class="card">
      <form method="post" action="/admin/weekly/add">
        ${csrfField(session)}
        <label>${t("admin.weeklyDay")}
          <select name="dayOfWeek">
            ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<option value="${d}">${t.weekday(d)}</option>`)}
          </select>
        </label>
        <label>${t("admin.weeklyTime")}
          <input type="time" name="time" value="19:00" required>
        </label>
        <p class="hint">${t("admin.weeklyActivities")}</p>
        ${pattern.activities.map((a) => html`
          <label class="inline"><input type="checkbox" name="activities" value="${a.key}"> ${a.label}</label>`)}
        <button type="submit">${t("admin.weeklyAdd")}</button>
      </form>
    </div>

    ${nextSeason ? html`
      <div class="card">
        <b>${t("admin.rollover")}</b>
        <p class="hint">${t("admin.rolloverHint")}</p>
        <form method="post" action="/admin/season">
          ${csrfField(session)}
          <label>${t("admin.season")} <input name="seasonKey" value="${nextSeason.key}" required></label>
          <label><input type="date" name="seasonFrom" value="${nextSeason.from}" required></label>
          <label><input type="date" name="seasonTo" value="${nextSeason.to}" required></label>
          <input type="hidden" name="cutoffDays" value="${pattern.board?.cutoffDays ?? 0}">
          <button type="submit">${t("admin.rolloverDo", { key: nextSeason.key })}</button>
        </form>
      </div>` : ""}

    <h2>${t("admin.activities")}</h2>
    ${pattern.activities.map((a) => html`<div class="card"><b>${a.label}</b> <small><code>${a.key}</code></small></div>`)}
    <div class="card">
      <form method="post" action="/admin/activity">
        ${csrfField(session)}
        <label>${t("admin.activityKey")} <input name="key" pattern="[a-z0-9_]+" required></label>
        <label>${t("admin.activityLabel")} <input name="label" required></label>
        <button type="submit">${t("admin.addActivity")}</button>
      </form>
    </div>`;

  return layout({ t, title: t("admin.title"), who, nav: navFor(t, roles, "admin"), flash, body });
}
