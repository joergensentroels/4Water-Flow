// A volunteer's own page. Two reasons it exists: rectification is a right and doing it by messaging an admin
// is friction with no purpose, and a volunteer currently could not see what the system believed about them —
// which capabilities they were down for, or why the board looked empty.
import { html } from "../http.mjs";
import { layout, csrfField, navFor } from "../views.mjs";

export function myProfile(db, personId, seasonId) {
  const person = db.prepare(`SELECT id, name, contact, preferred_role AS preferredRole, status,
                                    auth_provider AS authProvider
                               FROM people WHERE id=?`).get(personId);
  if (!person) return null;
  return {
    person,
    roles: db.prepare("SELECT r.name FROM person_roles pr JOIN roles r ON r.id=pr.role_id WHERE pr.person_id=?")
      .all(personId).map((r) => r.name),
    capabilities: db.prepare(`SELECT a.key, a.label FROM capabilities c JOIN activities a ON a.id=c.activity_id
                               WHERE c.person_id=? ORDER BY a.label`).all(personId),
    answered: db.prepare(`SELECT COUNT(DISTINCT date) n FROM (
                            SELECT date FROM availability_day WHERE person_id=?
                            UNION SELECT date FROM availability_hour WHERE person_id=?)`).get(personId, personId).n,
    datesInSeason: seasonId ? db.prepare("SELECT COUNT(DISTINCT date) n FROM sessions WHERE season_id=?").get(seasonId).n : 0,
  };
}

// Only name and contact. Capabilities are somebody else's judgement about what a volunteer can run, so they
// are shown here but changed by an admin — letting people grant themselves capabilities would quietly make
// the eligibility rule meaningless.
export function saveProfile(db, personId, form) {
  const name = String(form.name ?? "").trim().slice(0, 120);
  const contact = String(form.contact ?? "").trim().slice(0, 200);
  if (!name) return { ok: false, reason: "name_required" };
  if (contact && !/^[^@\s]+@[^@\s]+$/.test(contact)) return { ok: false, reason: "bad_contact" };

  // A contact address is how an invite finds someone, so it must stay unique.
  const clash = db.prepare("SELECT id FROM people WHERE contact = ? AND id <> ?").get(contact || null, personId);
  if (contact && clash) return { ok: false, reason: "contact_taken" };

  // Which role they teach. A fact about themselves, so they own it — unlike capabilities, which are somebody
  // else's judgement and stay with an admin. An unrecognised value leaves the stored one alone rather than
  // nulling it, so a malformed post cannot quietly make somebody ineligible for every class.
  const role = String(form.preferredRole ?? "").trim();
  const nextRole = ["l", "f", "b"].includes(role) ? role : null;

  db.prepare(`UPDATE people SET name=?, contact=?, preferred_role=COALESCE(?, preferred_role) WHERE id=?`)
    .run(name, contact || null, nextRole, personId);
  return { ok: true };
}

const OUTCOME = {
  saved: { key: "profile.saved" },
  name_required: { key: "profile.nameRequired", bad: true },
  bad_contact: { key: "profile.badContact", bad: true },
  contact_taken: { key: "profile.contactTaken", bad: true },
};
export function profileFlash(t, code) {
  const o = OUTCOME[code];
  return o ? { text: t(o.key), bad: !!o.bad } : null;
}

export function renderProfile({ t, session, roles, who, me, score, flash }) {
  const body = html`
    <h2>${t("profile.title")}</h2>

    <form method="post" action="/me" class="card">
      ${csrfField(session)}
      <label>${t("profile.name")}
        <input name="name" value="${me.person.name}" required maxlength="120">
      </label>
      <label>${t("profile.contact")}
        <input type="email" name="contact" value="${me.person.contact ?? ""}" maxlength="200">
      </label>
      <p class="hint">${t("profile.danceRole")}</p>
      ${[["l", "profile.danceRoleL"], ["f", "profile.danceRoleF"], ["b", "profile.danceRoleB"]].map(([v, k]) => html`
        <label class="inline">
          <input type="radio" name="preferredRole" value="${v}"${me.person.preferredRole === v ? html` checked` : ""}>
          ${t(k)}
        </label>`)}
      <button type="submit">${t("admin.save")}</button>
    </form>

    <div class="card">
      <p><b>${score}</b> — ${t("score.label")}</p>
      <p class="hint">${t("profile.answered", { n: me.answered, of: me.datesInSeason })}</p>
      <p class="hint">${t("admin.capabilities")}:
        ${me.capabilities.length ? me.capabilities.map((c) => c.label).join(", ") : t("profile.noCapabilities")}</p>
      <p class="hint">${t("profile.capabilitiesNote")}</p>
      <p class="hint">${t("profile.roles")}: ${me.roles.length ? me.roles.map((r) => t(`role.${r}`)).join(", ") : "—"}</p>
    </div>

    <p><a class="btn secondary" href="/me/export.json">${t("profile.download")}</a></p>
    <p><a href="/privacy">${t("privacy.link")}</a></p>
    <form method="post" action="/signout">${csrfField(session)}
      <p><button type="submit" class="secondary">${t("signin.out")}</button></p>
    </form>`;
  return layout({ t, title: t("profile.title"), who, nav: navFor(t, roles, "profile"), flash, body });
}
