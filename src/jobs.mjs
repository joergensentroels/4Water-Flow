// Scheduled work. A timer inside the process rather than a cron entry, so deploying the app deploys the
// nudge — one fewer thing for whoever inherits this to know about, and one fewer thing to forget.
import { nudgeMessage } from "./notify.mjs";

// ISO week, used as the nudge's idempotency period: at most one reminder per volunteer per week, however
// often the job runs. Computed in UTC to match how dates are stored.
export function isoWeek(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  // Thursday of the current week determines the year, per ISO 8601.
  const day = (d.getUTCDay() + 6) % 7;                    // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const addDays = (isoDate, n) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Who has NOT answered for the coming window. "Has not answered" is the absence of a row — the same
// definition the eligibility query uses, so a volunteer cannot be simultaneously nudged and considered
// available.
export function volunteersNeedingNudge(db, seasonId, from, to) {
  return db.prepare(`
    SELECT p.id, p.name,
           (SELECT COUNT(DISTINCT s.date) FROM sessions s
             WHERE s.season_id = :sid AND s.date BETWEEN :from AND :to) AS dates,
           (SELECT COUNT(DISTINCT s.date) FROM sessions s
             WHERE s.season_id = :sid AND s.date BETWEEN :from AND :to
               AND (EXISTS (SELECT 1 FROM availability_day ad WHERE ad.person_id = p.id AND ad.date = s.date)
                 OR EXISTS (SELECT 1 FROM availability_hour ah WHERE ah.person_id = p.id AND ah.date = s.date))) AS answered
      FROM people p
     WHERE p.status = 'active'
     ORDER BY p.id
  `).all({ sid: seasonId, from, to })
    .filter((r) => r.dates > 0 && r.answered < r.dates);
}

export async function runNudge(db, { notifier, t, seasonId, today, windowDays = 28, period = null }) {
  const from = today;
  const to = addDays(today, windowDays);
  const p = period ?? isoWeek(today);
  const sent = [];
  for (const v of volunteersNeedingNudge(db, seasonId, from, to)) {
    const r = await notifier.send({
      kind: "availability_nudge",
      personId: v.id,
      period: p,
      body: nudgeMessage(t, { name: v.name, from, to }),
    });
    if (r.ok) sent.push(v.id);
  }
  return { considered: true, from, to, period: p, sent };
}

// The timer. Deliberately dumb: check on an interval and let runNudge's idempotency decide whether anything
// actually goes out. A missed tick therefore costs nothing, which is what makes restarts safe.
export function startJobs({ db, notifier, t, seasonId, today, everyMs = 6 * 60 * 60 * 1000, log = console }) {
  const tick = async () => {
    try {
      const sid = typeof seasonId === "function" ? seasonId() : seasonId;
      if (!sid) return;
      const r = await runNudge(db, { notifier, t, seasonId: sid, today: today() });
      if (r.sent.length) log.log?.(`[jobs] availability nudge sent to ${r.sent.length} volunteer(s) for ${r.period}`);
    } catch (e) {
      log.warn?.(`[jobs] nudge failed: ${e.message}`);   // a broken job must not take the server down
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();                 // never hold the process open just for the timer
  return { stop: () => clearInterval(timer), tick };
}
