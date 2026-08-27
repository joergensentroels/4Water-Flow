// A volunteer's own page. Two reasons it exists: rectification is a right and doing it by messaging an admin
// is friction with no purpose, and a volunteer currently could not see what the system believed about them —
// which capabilities they were down for, or why the board looked empty.
import { html } from "../http.mjs";
import { layout, csrfField, navFor } from "../views.mjs";
import { attendedCount } from "../queries.mjs";
import { answerProgress } from "./availability.mjs";

export function myProfile(db, personId, seasonId) {
  const person = db.prepare(`SELECT id, name, contact, preferred_role AS preferredRole, status,
                                    auth_provider AS authProvider
                               FROM people WHERE id=?`).get(personId);
  if (!person) return null;

  // Counted by the one definition of answered — every time on a date, an explicit "no" included. This counted
  // any date the person had ANY availability row for, which over-counted (one hour answered on a four-slot date
  // read as done) and drifted from the counter on the availability form, so the two screens a volunteer moves
  // between reported different progress on the same work.
  //
  // Over the WHOLE season, past dates included, because this page reports what the system has RECORDED about a
  // person, not what is left to do — the form's counter is for what is left. The two may differ; they mean
  // different things and each says which.
  //
  // The window starts at the season's first SESSION rather than its from_date: that is the set answerProgress
  // counts over, so `datesInSeason` keeps the exact meaning it had, and a season configured to open before
  // anything is scheduled cannot quietly inflate the denominator.
  const firstSession = seasonId
    ? db.prepare("SELECT MIN(date) d FROM sessions WHERE season_id=?").get(seasonId)?.d : null;
  const progress = firstSession ? answerProgress(db, personId, seasonId, firstSession) : { total: 0, answered: 0 };

  return {
    person,
    roles: db.prepare("SELECT r.name FROM person_roles pr JOIN roles r ON r.id=pr.role_id WHERE pr.person_id=?")
      .all(personId).map((r) => r.name),
    capabilities: db.prepare(`SELECT a.key, a.label FROM capabilities c JOIN activities a ON a.id=c.activity_id
                               WHERE c.person_id=? ORDER BY a.label`).all(personId),
    answered: progress.answered,
    datesInSeason: progress.total,
    // What they are recorded as having done. The privacy notice tells a volunteer that a planner records whether
    // they turned up and that it counts how much they have helped — so they have to be able to SEE it. A record
    // somebody can neither read nor question is the wrong kind to keep about a person, and telling them it exists
    // while hiding it is worse than not telling them.
    //
    // Only `attended` here: the held count already reaches this page as renderProfile's `score` prop, and computing
    // it twice under a second name is how two numbers that must agree stop agreeing.
    attended: seasonId ? attendedCount(db, personId, seasonId) : 0,
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
  calendar_created: { key: "calendar.created" },
  calendar_revoked: { key: "calendar.revoked" },
  name_required: { key: "profile.nameRequired", bad: true },
  bad_contact: { key: "profile.badContact", bad: true },
  contact_taken: { key: "profile.contactTaken", bad: true },
};
export function profileFlash(t, code) {
  const o = OUTCOME[code];
  return o ? { text: t(o.key), bad: !!o.bad } : null;
}

// `calendar` defaults to "not set up", so a caller that does not care about the feed — and every test written
// before it existed — still renders a valid page rather than throwing on a missing property.
export function renderProfile({ t, session, roles, who, me, score, flash,
                                calendar = { exists: false, fresh: null, timezoneConfigured: true } }) {
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
      <!-- Their own contribution record, in their own words. Shown even at zero, unlike the planner's version:
           a volunteer looking for "what am I down as having done" needs an answer, and a missing line reads as
           "not recorded anywhere" — which is what the privacy notice would then be wrong about. -->
      <p class="hint">${t("profile.attended", { n: me.attended })}</p>
      <p class="hint">${t("profile.answered", { n: me.answered, of: me.datesInSeason })}</p>
      <p class="hint">${t("admin.capabilities")}:
        ${me.capabilities.length ? me.capabilities.map((c) => c.label).join(", ") : t("profile.noCapabilities")}</p>
      <p class="hint">${t("profile.capabilitiesNote")}</p>
      <p class="hint">${t("profile.roles")}: ${me.roles.length ? me.roles.map((r) => t(`role.${r}`)).join(", ") : "—"}</p>
    </div>

    <!-- The calendar subscription. Stated plainly rather than buried: this link is a password. A calendar
         client cannot sign in, so anyone holding the URL can read this volunteer's shifts — which is a fair
         trade for shifts that appear on their phone without being sought out, but only if they know. -->
    <div class="card">
      <h3>${t("calendar.title")}</h3>
      <p class="hint">${t("calendar.what")}</p>
      ${calendar.fresh ? html`
        <p class="hint"><b>${t("calendar.copyNow")}</b></p>
        <p class="tokenbox">${calendar.fresh}</p>
        <!-- Relative when FOURWATER_BASE_URL is unset. Say so, because pasting a path into a calendar app does
             nothing and the volunteer has no way to know why. The origin is deliberately NOT taken from the
             Host header: a request with a forged Host would render a link pointing at somebody else's server,
             and the volunteer would paste their own token into it. -->
        ${calendar.fresh.startsWith("http") ? "" : html`<p class="hint">${t("calendar.prefix")}</p>`}
        <p class="hint">${t("calendar.secret")}</p>`
      : calendar.exists ? html`
        <p class="hint">${t("calendar.alreadyOn")}</p>` : ""}

      ${calendar.timezoneConfigured ? "" : html`<p class="hint"><b>${t("calendar.noTimezone")}</b></p>`}

      <form method="post" action="/me/calendar">${csrfField(session)}
        <p><button type="submit" class="secondary">${calendar.exists ? t("calendar.regenerate") : t("calendar.create")}</button></p>
      </form>
      ${calendar.exists ? html`
        <form method="post" action="/me/calendar">${csrfField(session)}
          <input type="hidden" name="action" value="revoke">
          <p><button type="submit" class="secondary">${t("calendar.revoke")}</button></p>
        </form>` : ""}
    </div>

    <p><a class="btn secondary" href="/me/export.json">${t("profile.download")}</a></p>
    <p><a href="/privacy">${t("privacy.link")}</a></p>
    <form method="post" action="/signout">${csrfField(session)}
      <p><button type="submit" class="secondary">${t("signin.out")}</button></p>
    </form>`;
  return layout({ t, title: t("profile.title"), who, nav: navFor(t, roles, "profile"), flash, body });
}
