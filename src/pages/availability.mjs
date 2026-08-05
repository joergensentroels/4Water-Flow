// The screen the whole project exists for. Three states per date, not two: "can", "cannot", and "no answer
// yet" — because silence is not consent, and a two-state toggle would force every unanswered date to be a
// lie in one direction or the other.
import { html } from "../http.mjs";
import { layout, formatDate, formatTime, csrfField, navFor } from "../views.mjs";

// Only ask about dates that actually have sessions. Asking a volunteer to rate 180 days when 52 of them
// matter is how a form becomes a chore nobody finishes.
// One row per (date, HOUR) — not per (date, hour, minute), which is what this grouped by and what made the page
// render controls it could not answer.
//
// `availability_hour` is keyed (person_id, date, hour): the answer a volunteer gives is hour-granular by design,
// and the form names each radio group `slot:${date}:${hour}`. Grouping the rows any finer than the answer produces
// two rows that are secretly one control. Measured after adding a 19:30 slot beside 19:00 through the admin screen,
// which is a supported edit:
//
//   data rows for that date: 2, distinct radio names: 1   (six radios, all named slot:2026-01-07:19)
//
// Three things follow, all volunteer-facing. The two rows are ONE radio group, so answering the second clears the
// first and the row goes blank. The `id`s collide too, so `<label for>` resolves to the first row and clicking the
// second row's glyph toggles the first row's radio — a control that does the wrong thing. And `checked` is computed
// per row from the same stored answer, so the initial render marks two radios checked in one group.
//
// Grouping by hour is the fix rather than making availability minute-granular: "are you free at 19:00" reasonably
// covers a class that starts at 19:30, the schema says so already, and a migration to change that would be a
// larger claim about what the app asks people. `minute` becomes the EARLIEST in the hour, so the displayed time is
// a real session time rather than an invented one, and `sessions` counts everything the answer covers.
//
// `saveAvailability`'s allow-list is keyed `${date}:${hour}`, so it is unchanged by this; `bulkScopes` uses the
// date only.
export function datesNeedingAnswer(db, seasonId) {
  return db.prepare(`
    SELECT s.date, t.hour, MIN(t.minute) AS minute, COUNT(*) AS sessions
      FROM sessions s JOIN timeslots t ON t.id = s.timeslot_id
     WHERE s.season_id = :sid
     GROUP BY s.date, t.hour
     ORDER BY s.date, t.hour
  `).all({ sid: seasonId });
}

export function currentAnswers(db, personId) {
  const days = db.prepare("SELECT date, available FROM availability_day WHERE person_id = :pid").all({ pid: personId });
  const hours = db.prepare("SELECT date, hour, available FROM availability_hour WHERE person_id = :pid").all({ pid: personId });
  const byDate = new Map(days.map((d) => [d.date, d.available]));
  const byHour = new Map(hours.map((h) => [`${h.date}T${h.hour}`, h.available]));
  return { byDate, byHour };
}

// The value a radio group should show: the hour-level answer if one exists, else the day-level, else "".
const shown = (answers, date, hour) => {
  const h = answers.byHour.get(`${date}T${hour}`);
  if (h !== undefined) return String(h);
  const d = answers.byDate.get(date);
  return d === undefined ? "" : String(d);
};

// Bulk setting. Opening the real page in a browser measured 3,750 pixels — 51 date rows and 153 radio
// buttons, about four and a half phone screens. Answering that one tap at a time is exactly the chore that
// makes people stop filling the form in, which is the bottleneck this whole project exists to unblock.
//
// Server-rendered, so it works with JavaScript disabled like everything else here.
export function bulkTargets(rows, { scope, value }) {
  const wanted = rows.filter((r) => {
    if (scope === "all") return true;
    if (scope.startsWith("dow:")) return String(new Date(`${r.date}T00:00:00Z`).getUTCDay()) === scope.slice(4);
    if (scope.startsWith("month:")) return r.date.slice(0, 7) === scope.slice(6);
    return false;
  });
  return { rows: wanted, value };
}

// The scopes worth offering, derived from the data rather than assumed: only weekdays that actually have
// sessions, and only months the season covers. Offering "all Mondays" when nothing happens on Monday is
// noise, and hardcoding the weekdays would put Copenhagen's rhythm back into the code.
export function bulkScopes(t, rows) {
  const dows = [...new Set(rows.map((r) => new Date(`${r.date}T00:00:00Z`).getUTCDay()))].sort();
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
  return {
    dows: dows.map((d) => ({ scope: `dow:${d}`, label: t("availability.allWeekday", { day: t.weekday(d) }) })),
    months: months.map((m) => ({ scope: `month:${m}`, label: m })),
  };
}

export function renderAvailability({ t, session, roles, who, rows, answers, flash }) {
  const scopes = bulkScopes(t, rows);
  const body = rows.length === 0
    ? html`<p class="empty">${t("availability.noDates")}</p>`
    : html`
      <h2>${t("availability.title")}</h2>
      <p class="hint">${t("availability.intro")} ${t("availability.onlyThese")}</p>
      <p class="hint">${t("privacy.notice")} <a href="/privacy">${t("privacy.link")}</a></p>

      <details class="card">
        <summary>${t("availability.bulkTitle")}</summary>
        <p class="hint">${t("availability.bulkHint")}</p>
        ${[["1", t("availability.yes")], ["0", t("availability.no")], ["", t("availability.unknown")]].map(([value, label]) => html`
          <form method="post" action="/availability/bulk" class="bulkrow">
            ${csrfField(session)}
            <input type="hidden" name="value" value="${value}">
            <span class="bulklabel">${label}:</span>
            <button type="submit" name="scope" value="all" class="secondary">${t("availability.allDates")}</button>
            ${scopes.dows.map((s) => html`<button type="submit" name="scope" value="${s.scope}" class="secondary">${s.label}</button>`)}
          </form>`)}
      </details>

      <form method="post" action="/availability">
        ${csrfField(session)}
        <ul class="dates">
          ${rows.map((r) => {
            const name = `slot:${r.date}:${r.hour}`;
            const value = shown(answers, r.date, r.hour);
            const when = `${formatDate(t, r.date)} ${formatTime(r.hour, r.minute)}`;
            // Each radio carries an explicit aria-label. The visible label's text is a glyph, and a glyph IS
            // the accessible name when a label has text content — `title` is only a fallback for elements with
            // no name at all. Without this a screen reader announced "✓ radio button" 153 times over, with no
            // way to tell which date was being answered. The glyph is aria-hidden so it is not read twice.
            const choice = (suffix, val, glyph, key) => html`
              <input type="radio" id="${name}:${suffix}" name="${name}" value="${val}"
                     aria-label="${t(key)} — ${when}"${value === val ? html` checked` : ""}>
              <label for="${name}:${suffix}" title="${t(key)}"><span aria-hidden="true">${glyph}</span></label>`;
            return html`<li><div class="daterow">
              <span class="when">
                <b>${formatDate(t, r.date)}</b>
                <small>${formatTime(r.hour, r.minute)}</small>
              </span>
              <span class="choice">
                ${choice("1", "1", "✓", "availability.yes")}
                ${choice("0", "0", "✕", "availability.no")}
                ${choice("x", "", "–", "availability.unknown")}
              </span>
            </div></li>`;
          })}
        </ul>
        <div class="actions"><button type="submit">${t("availability.save")}</button></div>
      </form>`;
  return layout({ t, title: t("availability.title"), who, nav: navFor(t, roles, "availability"), flash, body });
}

// Writing. The form names carry date and hour, and the person comes from the SESSION — never from the form.
// That is the whole defence against writing someone else's availability, and it is why there is no personId
// field to tamper with.
export function saveAvailability(db, personId, form, seasonId) {
  const allowed = new Set(datesNeedingAnswer(db, seasonId).map((r) => `${r.date}:${r.hour}`));
  const setHour = db.prepare(`INSERT INTO availability_hour (person_id, date, hour, available) VALUES (:pid,:d,:h,:a)
                              ON CONFLICT (person_id, date, hour) DO UPDATE SET available = :a`);
  const clearHour = db.prepare("DELETE FROM availability_hour WHERE person_id = :pid AND date = :d AND hour = :h");
  let written = 0, cleared = 0;

  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(form)) {
      if (!key.startsWith("slot:")) continue;
      const [, date, hourStr] = key.split(":");
      const hour = Number(hourStr);
      // Ignore anything not on the offered list: a fabricated field must not create rows for a date that
      // has no sessions, or for another season.
      if (!allowed.has(`${date}:${hour}`)) continue;
      if (value === "") { clearHour.run({ pid: personId, d: date, h: hour }); cleared++; continue; }
      if (value !== "0" && value !== "1") continue;
      setHour.run({ pid: personId, d: date, h: hour, a: Number(value) });
      written++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { written, cleared };
}
