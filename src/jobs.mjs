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
  // One run at a time. runNudge awaits one delivery per volunteer, so a slow channel makes a tick take
  // arbitrarily long — and setInterval does not wait. Overlapping runs cannot double-notify anyone (the UNIQUE
  // constraint on (kind, person, period) settles that), but they would stack up loops all grinding through the
  // same unresponsive channel, which is how one broken webhook becomes a growing pile of work.
  //
  // Skipping is the right response rather than queueing: the tick is a periodic check whose whole design is
  // that a missed one costs nothing.
  let running = false;

  // The job reports on itself, because the worst defect in this project was this job never running at all while
  // seventeen tests proved it worked. A test caught that once; nothing would have caught it happening AGAIN on a
  // live instance, because a nudge nobody needed and a nudge job that is dead look identical from outside.
  //
  // `lastRun` is deliberately the last time the job RAN, not the last time it sent something — those differ
  // exactly in the healthy case where everyone has already answered, which is the case that would otherwise
  // read as broken. In memory, so it resets on restart: honest, and no schema for an operational detail. The
  // boot tick runs five seconds in, so an instance that has been up a while and still says "never" is telling
  // you the timer is not wired.
  const state = { startedAt: Date.now(), lastRun: null, lastSent: null, lastError: null, everyMs };

  const tick = async () => {
    if (running) {
      log.warn?.(`[jobs] previous nudge run has not finished — skipping this tick`);
      return { skipped: true };
    }
    running = true;
    try {
      const sid = typeof seasonId === "function" ? seasonId() : seasonId;
      if (!sid) {
        // Counts as a run: the job did its job, which was to look and find no current season. Not recording it
        // would make a perfectly-behaved instance with a past season indistinguishable from a dead timer, and
        // /status already reports the season separately.
        state.lastRun = Date.now();
        state.lastSent = 0;
        return;
      }
      const r = await runNudge(db, { notifier, t, seasonId: sid, today: today() });
      state.lastRun = Date.now();
      state.lastSent = r.sent.length;
      state.lastError = null;
      if (r.sent.length) log.log?.(`[jobs] availability nudge sent to ${r.sent.length} volunteer(s) for ${r.period}`);
    } catch (e) {
      state.lastRun = Date.now();     // it ran; it failed. Both are facts an operator needs.
      state.lastError = e.message;
      log.warn?.(`[jobs] nudge failed: ${e.message}`);   // a broken job must not take the server down
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();                 // never hold the process open just for the timer
  return { stop: () => clearInterval(timer), tick, state: () => ({ ...state }) };
}
