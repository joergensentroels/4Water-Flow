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
// `from` is REQUIRED, not defaulted, and that is the fix rather than an ergonomic preference.
//
// Measured in a browser at 375px on the demo: this form offered 46 dates of which TWELVE were in the past — 6,528
// pixels of form, and a quarter of it was dates a volunteer cannot change anything about. The earliest field was
// 2026-06-28 with today at 2026-08-06. Answering availability for a session that has already happened does nothing:
// the roster is done, the retention sweep deletes the row when its date loses its sessions, and a planner reading
// "free" for last month learns nothing. So it is not merely clutter, it is a quarter of the most-used volunteer screen
// spent on questions with no answer worth giving.
//
// A default of null would be a third arm nothing takes — both call sites have a clock — and this project's rule 7 is
// that a conditional needs two reachable arms or it is not a conditional.
export function datesNeedingAnswer(db, seasonId, from) {
  if (!from) throw new Error("datesNeedingAnswer needs the date to count from — a season's past is not answerable");
  return db.prepare(`
    SELECT s.date, t.hour, MIN(t.minute) AS minute, COUNT(*) AS sessions
      FROM sessions s JOIN timeslots t ON t.id = s.timeslot_id
     WHERE s.season_id = :sid AND s.date >= :from
     GROUP BY s.date, t.hour
     ORDER BY s.date, t.hour
  `).all({ sid: seasonId, from });
}

export function currentAnswers(db, personId) {
  const days = db.prepare("SELECT date, available FROM availability_day WHERE person_id = :pid").all({ pid: personId });
  const hours = db.prepare("SELECT date, hour, available FROM availability_hour WHERE person_id = :pid").all({ pid: personId });
  const byDate = new Map(days.map((d) => [d.date, d.available]));
  const byHour = new Map(hours.map((h) => [`${h.date}T${h.hour}`, h.available]));
  return { byDate, byHour };
}

// The EFFECTIVE answer: the hour-level one if it exists, else the day-level, else "". This matches the COALESCE
// in queries.mjs, so it is what a planner sees, and it is what answerProgress counts. It is NOT what the hour
// radios render — see hourOnly, where that distinction is load-bearing rather than tidy.
// Exported so a test can assert the EFFECTIVE answer — the thing a planner acts on — rather than poking at two
// tables and re-implementing the fallback, which would let the test agree with a bug.
export const shown = (answers, date, hour) => {
  const h = answers.byHour.get(`${date}T${hour}`);
  if (h !== undefined) return String(h);
  const d = answers.byDate.get(date);
  return d === undefined ? "" : String(d);
};

// What an HOUR radio renders: only a real hour-level row, never the day-level fallback.
//
// Using `shown` here would quietly destroy the whole-day answer it is meant to display. Inputs inside a CLOSED
// <details> are still submitted, so every save posts every hour radio on the page. Pre-check those from the day
// value and the next save writes an hour row for every hour of every date — materialising exactly the rows the
// day-level answer exists to avoid, and turning "free all that day" into four independent facts that stop moving
// when the day answer changes.
//
// Blank therefore means "inherits the day", which is also what the schema means by the absence of a row.
const hourOnly = (answers, date, hour) => {
  const h = answers.byHour.get(`${date}T${hour}`);
  return h === undefined ? "" : String(h);
};

const dayOnly = (answers, date) => {
  const d = answers.byDate.get(date);
  return d === undefined ? "" : String(d);
};

// One entry per DATE, each carrying its hours. The flat (date, hour) list stays the unit of truth for the
// allow-list, the progress count and the bulk scopes — this only decides how the form is drawn.
//
// Why it exists: once the configured rhythm gives a date four one-hour slots and another two, almost every date
// appears more than once, and the date was printed again on every row. Which weekday that is belongs to
// config/pattern.json, not here — the seams gate enforces that and caught an earlier draft of this comment.
export function groupByDate(rows) {
  const out = [];
  const byDate = new Map();
  for (const r of rows) {
    let g = byDate.get(r.date);
    if (!g) { g = { date: r.date, hours: [] }; byDate.set(r.date, g); out.push(g); }
    g.hours.push({ hour: r.hour, minute: r.minute, sessions: r.sessions });
  }
  return out;
}

// How far along this volunteer is. ONE definition, used by the availability form's own counter AND by the prompt on
// the home screen — two screens computing this separately is how they come to disagree, and a volunteer told "3
// dates left" on one and "you have not answered" on the other believes neither.
//
// "Answered" means what it means everywhere else in this file: a stored answer at hour or day level. Silence is not
// an answer, which is the whole reason the radio group is tri-state.
//
// COUNTED IN DATES, and a date is answered only when EVERY time on it is.
//
// It counted (date, hour) rows until 2026-08-23, and both strings that report it have always said "dates" — which
// was loose while a date carried one time and became visibly wrong once the form grouped by date: the screen
// showed 35 rows while saying "53 dates", and answering one whole day moved the counter by two. Arithmetically
// consistent, and it reads as a bug.
//
// EVERY time on the date, not any. Silence is not consent, so a date with one time answered and another blank is
// not an answered date. `shown` is the effective answer, so a single whole-day row satisfies all of them at once
// — which is why answering the day now moves the counter by exactly one.
//
// groupByDate rather than a second grouping written here: the form draws from that function, and a counter that
// grouped dates its own way could disagree with the list it sits directly above.
export function answerProgress(db, personId, seasonId, from) {
  const answers = currentAnswers(db, personId);
  const dates = groupByDate(datesNeedingAnswer(db, seasonId, from));
  let answered = 0;
  for (const g of dates) if (g.hours.every((h) => shown(answers, g.date, h.hour) !== "")) answered++;
  return { total: dates.length, answered, remaining: dates.length - answered };
}

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

export function renderAvailability({ t, session, roles, who, rows, answers, flash, progress = null }) {
  const scopes = bulkScopes(t, rows);
  const body = rows.length === 0
    ? html`<p class="empty">${t("availability.noDates")}</p>`
    : html`
      <h2>${t("availability.title")}</h2>
      <!-- Where you are in it. Measured at 375px this form is 51 date rows and 153 radios — about four and a half
           phone screens, with a single Save at the very bottom and, until now, nothing anywhere saying how far
           along you were or how much was left. Same helper the home screen's prompt uses, so the two cannot
           disagree about it. -->
      ${progress ? html`<p class="hint"><b>${progress.remaining === 0
          ? t("availability.progressDone")
          : t("availability.progress", { answered: progress.answered, total: progress.total, remaining: progress.remaining })}</b></p>` : ""}
      <p class="hint">${t("availability.intro")} ${t("availability.onlyThese")}</p>
      <p class="hint">${t("privacy.notice")} <a href="/privacy">${t("privacy.link")}</a></p>

      <details class="card">
        <summary>${t("availability.bulkTitle")}</summary>
        <p class="hint">${t("availability.bulkHint")}</p>
        <!-- Each button names the answer it sets as well as the scope. The row's visible label is a sibling
             <span>, which a sighted reader takes in at a glance and a screen reader reaching the button does
             not: the three rows announced "All dates, button" three times over, and the three do OPPOSITE
             things to about fifty dates each. Same fault as the radios below, in the section added after
             them. aria-label rather than a fieldset/legend to match how the radios already solve it, and
             because a fieldset brings default styling this row does not want. -->
        ${[["1", t("availability.yes")], ["0", t("availability.no")], ["", t("availability.unknown")]].map(([value, label]) => html`
          <form method="post" action="/availability/bulk" class="bulkrow">
            ${csrfField(session)}
            <input type="hidden" name="value" value="${value}">
            <span class="bulklabel">${label}:</span>
            <button type="submit" name="scope" value="all" class="secondary"
                    aria-label="${label} — ${t("availability.allDates")}">${t("availability.allDates")}</button>
            ${scopes.dows.map((s) => html`<button type="submit" name="scope" value="${s.scope}" class="secondary"
                    aria-label="${label} — ${s.label}">${s.label}</button>`)}
          </form>`)}
      </details>

      <form method="post" action="/availability">
        ${csrfField(session)}
        <ul class="dates">
          ${groupByDate(rows).map((g) => {
            // Each radio carries an explicit aria-label. The visible label's text is a glyph, and a glyph IS
            // the accessible name when a label has text content — `title` is only a fallback for elements with
            // no name at all. Without this a screen reader announced "✓ radio button" 153 times over, with no
            // way to tell which date was being answered. The glyph is aria-hidden so it is not read twice.
            const triple = (name, value, when) => {
              const one = (suffix, val, glyph, key) => html`
                <input type="radio" id="${name}:${suffix}" name="${name}" value="${val}"
                       aria-label="${t(key)} — ${when}"${value === val ? html` checked` : ""}>
                <label for="${name}:${suffix}" title="${t(key)}"><span aria-hidden="true">${glyph}</span></label>`;
              return html`<span class="choice">
                ${one("1", "1", "✓", "availability.yes")}
                ${one("0", "0", "✕", "availability.no")}
                ${one("x", "", "–", "availability.unknown")}
              </span>`;
            };

            // ONE hour: a whole-day control and an hour control would be the same question asked twice, so this
            // stays exactly the row it has always been, writing at hour level.
            if (g.hours.length === 1) {
              const h = g.hours[0];
              return html`<li><div class="daterow">
                <span class="when">
                  <b>${formatDate(t, g.date)}</b>
                  <small>${formatTime(h.hour, h.minute)}</small>
                </span>
                ${triple(`slot:${g.date}:${h.hour}`, shown(answers, g.date, h.hour), `${formatDate(t, g.date)} ${formatTime(h.hour, h.minute)}`)}
              </div></li>`;
            }

            // SEVERAL hours: answer the day once, and open the times only if you need to be finer than that.
            // Opened by default when any hour already carries its own answer, so a save can never hide something
            // the volunteer set — a collapsed section holding a "no" they cannot see is worse than a long form.
            const anyHour = g.hours.some((h) => hourOnly(answers, g.date, h.hour) !== "");
            return html`<li class="dategroup">
              <div class="daterow">
                <span class="when">
                  <b>${formatDate(t, g.date)}</b>
                  <small>${t("availability.wholeDay")}</small>
                </span>
                ${triple(`day:${g.date}`, dayOnly(answers, g.date), `${t("availability.wholeDay")} — ${formatDate(t, g.date)}`)}
              </div>
              <details class="hours"${anyHour ? html` open` : ""}>
                <summary>${t("availability.bySlot", { count: g.hours.length })}</summary>
                <ul>
                  ${g.hours.map((h) => html`<li><div class="daterow">
                    <span class="when"><small>${formatTime(h.hour, h.minute)}</small></span>
                    ${triple(`slot:${g.date}:${h.hour}`, hourOnly(answers, g.date, h.hour), `${formatDate(t, g.date)} ${formatTime(h.hour, h.minute)}`)}
                  </div></li>`)}
                </ul>
              </details>
            </li>`;
          })}
        </ul>
        <div class="actions"><button type="submit">${t("availability.save")}</button></div>
      </form>`;
  return layout({ t, title: t("availability.title"), who, nav: navFor(t, roles, "availability"), flash, body });
}

// Writing. The form names carry date and hour, and the person comes from the SESSION — never from the form.
// That is the whole defence against writing someone else's availability, and it is why there is no personId
// field to tamper with.
// `from` is threaded through here too, and making it a required argument of datesNeedingAnswer is what found this
// caller: the allow-list this function validates writes against IS the list the form offers, so a cutoff applied to
// one and not the other would let a stale or hand-made POST write answers for dates the screen has stopped showing.
// Twelve tests went red the moment the parameter became mandatory, all of them here, which is the argument against
// giving it a default.
export function saveAvailability(db, personId, form, seasonId, from) {
  const rows = datesNeedingAnswer(db, seasonId, from);
  const allowed = new Set(rows.map((r) => `${r.date}:${r.hour}`));
  // Dates come from the SAME rows, so the whole-day control adds no trust surface: a fabricated `day:` field can
  // only name a date the form itself offers.
  const allowedDates = new Set(rows.map((r) => r.date));
  const setHour = db.prepare(`INSERT INTO availability_hour (person_id, date, hour, available) VALUES (:pid,:d,:h,:a)
                              ON CONFLICT (person_id, date, hour) DO UPDATE SET available = :a`);
  const clearHour = db.prepare("DELETE FROM availability_hour WHERE person_id = :pid AND date = :d AND hour = :h");
  const setDay = db.prepare(`INSERT INTO availability_day (person_id, date, available) VALUES (:pid,:d,:a)
                             ON CONFLICT (person_id, date) DO UPDATE SET available = :a`);
  const clearDay = db.prepare("DELETE FROM availability_day WHERE person_id = :pid AND date = :d");
  let written = 0, cleared = 0;

  db.exec("BEGIN");
  try {
    // DAY ANSWERS FIRST, and the order is the correctness argument rather than a preference.
    //
    // One submit carries both levels. "Free all that day except 15:00" arrives as day=1 together with hour 15=0,
    // and a day write clears that date's hour rows so the whole-day answer actually takes effect — otherwise a
    // stale hour row from an earlier save keeps overriding it through the COALESCE and the volunteer sees the
    // day control say "available" beside an hour that still says no. Run in the other order, that clear would
    // delete the 15:00 answer the same request was trying to set.
    for (const [key, value] of Object.entries(form)) {
      if (!key.startsWith("day:")) continue;
      const date = key.slice(4);
      if (!allowedDates.has(date)) continue;
      if (value === "") { clearDay.run({ pid: personId, d: date }); cleared++; continue; }
      if (value !== "0" && value !== "1") continue;
      db.prepare("DELETE FROM availability_hour WHERE person_id = :pid AND date = :d").run({ pid: personId, d: date });
      setDay.run({ pid: personId, d: date, a: Number(value) });
      written++;
    }
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
