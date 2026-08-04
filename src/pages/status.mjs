// The questions an operator actually has, answered on one page. Written after noticing that a season entirely
// in the past looks *identical* to a broken app: every screen empty-states politely and nothing says why.
//
// It reports facts, and each fact carries its own verdict, because "42 unfilled slots" means nothing to a
// volunteer administrator without "and that is more than usual".
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { html } from "../http.mjs";
import { layout, csrfField, navFor } from "../views.mjs";

const BACKUP_RE = /^4water-\d{4}-\d{2}-\d{2}T\d{6}Z\.sqlite$/;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function collectStatus(db, { pattern, today, backupDir, oidc = null, notify = null, jobs = null,
                                    now = Date.now() }) {
  const seasonRow = db.prepare("SELECT id, from_date AS from_, to_date AS to_ FROM seasons WHERE key=?").get(pattern.season.key);
  const facts = [];

  // ---- is the season the app is serving actually current? ----
  // First, because it explains most "the app looks empty" reports and nothing else surfaces it.
  if (!seasonRow) {
    facts.push({ key: "season", level: "bad", value: pattern.season.key, note: "missing" });
  } else if (seasonRow.to_ < today) {
    facts.push({ key: "season", level: "bad", value: pattern.season.key, note: "ended", detail: seasonRow.to_ });
  } else if (seasonRow.from_ > today) {
    facts.push({ key: "season", level: "warn", value: pattern.season.key, note: "future", detail: seasonRow.from_ });
  } else {
    facts.push({ key: "season", level: "ok", value: pattern.season.key, note: "current", detail: seasonRow.to_ });
  }

  // ---- gaps in the next month ----
  const horizon = addDays(today, 30);
  const gaps = seasonRow ? db.prepare(`
    SELECT COUNT(*) n FROM assignments a JOIN sessions s ON s.id=a.session_id
     WHERE a.person_id IS NULL AND s.season_id=:sid AND s.date BETWEEN :from AND :to`)
    .get({ sid: seasonRow.id, from: today, to: horizon }).n : 0;
  const upcoming = seasonRow ? db.prepare(`
    SELECT COUNT(*) n FROM assignments a JOIN sessions s ON s.id=a.session_id
     WHERE s.season_id=:sid AND s.date BETWEEN :from AND :to`)
    .get({ sid: seasonRow.id, from: today, to: horizon }).n : 0;
  facts.push({
    key: "gaps", value: gaps, detail: upcoming,
    // A third of the next month unfilled is worth a planner's attention; everything unfilled is a problem.
    level: upcoming === 0 ? "ok" : gaps === 0 ? "ok" : gaps / upcoming > 0.5 ? "bad" : gaps / upcoming > 0.2 ? "warn" : "ok",
  });

  // ---- who has not answered ----
  const silent = seasonRow ? db.prepare(`
    SELECT COUNT(*) n FROM people p
     WHERE p.status='active'
       AND NOT EXISTS (SELECT 1 FROM availability_day ad WHERE ad.person_id=p.id AND ad.date >= :from)
       AND NOT EXISTS (SELECT 1 FROM availability_hour ah WHERE ah.person_id=p.id AND ah.date >= :from)`)
    .get({ from: today }).n : 0;
  const active = db.prepare("SELECT COUNT(*) n FROM people WHERE status='active'").get().n;
  facts.push({ key: "silent", value: silent, detail: active, level: silent === 0 ? "ok" : silent > active / 2 ? "warn" : "ok" });

  // ---- notifications ----
  const failed = db.prepare("SELECT COUNT(*) n FROM notifications WHERE status='failed'").get().n;
  const queued = db.prepare("SELECT COUNT(*) n FROM notifications WHERE status='queued'").get().n;
  facts.push({ key: "failed", value: failed, level: failed === 0 ? "ok" : "bad" });
  // Queued is NOT a failure when there is no webhook: every message queues by design and a planner reads them
  // in the outbox. But the old wording asserted "(no webhook is configured)" unconditionally, and that can be
  // FALSE: notify.mjs writes the row as queued BEFORE calling the webhook, so a process killed between the two
  // — a container restart, a reboot — leaves queued rows on an instance whose webhook is perfectly fine. The
  // operator would then go and check a setting that was never the problem, while the real story is a send that
  // was interrupted and may or may not have arrived. Different sentence, and a warning rather than a note.
  const interrupted = notify?.channel && notify.channel !== "outbox";
  facts.push({
    key: "queued", value: queued,
    note: interrupted ? "interrupted" : "no_webhook",
    level: queued > 0 && interrupted ? "warn" : "ok",
  });

  // ---- is the availability nudge actually running? ----
  // The fact this page most needed and did not have. The nudge never ran once in production for most of this
  // project's life, and no screen could have told anyone: a job with nobody to nudge and a job that is dead both
  // produce silence. So report the job's own last RUN rather than its last message.
  //
  // Only when the caller wired the job in — but that is the same optional-argument shape that let the notifier
  // be forgotten, so test/journey.test.mjs asserts this line is present on a real boot rather than trusting it.
  if (jobs) {
    const s = jobs.state();
    const upMs = now - s.startedAt;
    if (s.lastRun === null) {
      // The boot tick fires five seconds in. Before that, "never" is just "not yet"; well after it, it means
      // the timer is not running.
      facts.push({ key: "nudge", value: null, note: "never",
                   level: upMs < 60_000 ? "ok" : "bad", detail: Math.floor(upMs / 60_000) });
    } else {
      const agoMin = Math.floor((now - s.lastRun) / 60_000);
      // Two missed intervals is a stalled timer. One is a long-running tick or a clock nudge.
      const stale = now - s.lastRun > 2 * s.everyMs;
      facts.push({ key: "nudge", value: agoMin, detail: s.lastSent,
                   note: s.lastError ? "error" : null,
                   level: s.lastError ? "bad" : stale ? "warn" : "ok" });
    }
  }

  // ---- backups ----
  let newest = null;
  if (backupDir && existsSync(backupDir)) {
    const files = readdirSync(backupDir).filter((f) => BACKUP_RE.test(f)).sort();
    if (files.length) {
      newest = { file: files.at(-1), count: files.length, mtime: statSync(path.join(backupDir, files.at(-1))).mtime };
    }
  }
  if (!newest) {
    facts.push({ key: "backup", level: "bad", value: null, note: "none" });
  } else {
    const ageHours = Math.floor((Date.now() - newest.mtime.getTime()) / 3600000);
    // Nightly means a healthy age is under about a day and a half. Past three days something is not running.
    facts.push({ key: "backup", value: ageHours, detail: newest.count,
                 level: ageHours <= 36 ? "ok" : ageHours <= 72 ? "warn" : "bad" });
  }

  // ---- how sign-in is finding the identity provider ----
  // Only when OIDC is configured: on an invite-only deployment there is nothing to report. The point of this
  // fact is that a discovery failure falls BACK to NextCloud's endpoint layout rather than locking everyone
  // out — which is the right behaviour and completely invisible without a line like this one.
  if (oidc?.enabled) {
    facts.push(oidc.source === "discovery"
      ? { key: "oidc", level: "ok", note: "discovery" }
      : { key: "oidc", level: "warn", note: "fallback", detail: oidc.error ?? "" });
  }

  return { facts, seasonRow };
}

const BADGE = { ok: "✓", warn: "!", bad: "✕" };

export function renderStatus({ t, session, roles, who, status, flash }) {
  const line = (f) => {
    // Each fact gets its own sentence, built from the key so a new fact cannot render as a bare number.
    const text = {
      season: () => f.note === "current" ? t("status.seasonCurrent", { key: f.value, until: f.detail })
                  : f.note === "ended" ? t("status.seasonEnded", { key: f.value, ended: f.detail })
                  : f.note === "future" ? t("status.seasonFuture", { key: f.value, starts: f.detail })
                  : t("status.seasonMissing", { key: f.value }),
      gaps: () => t("status.gaps", { n: f.value, of: f.detail }),
      silent: () => t("status.silent", { n: f.value, of: f.detail }),
      failed: () => t("status.failed", { n: f.value }),
      queued: () => t(f.note === "interrupted" ? "status.queuedInterrupted" : "status.queued", { n: f.value }),
      backup: () => f.note === "none" ? t("status.backupNone") : t("status.backupAge", { hours: f.value, kept: f.detail }),
      oidc: () => f.note === "discovery" ? t("status.oidcDiscovery") : t("status.oidcFallback", { why: f.detail }),
      nudge: () => f.note === "never" ? t("status.nudgeNever", { minutes: f.detail })
                 : f.note === "error" ? t("status.nudgeError", { minutes: f.value })
                 : t("status.nudgeRan", { minutes: f.value, sent: f.detail }),
    }[f.key];
    return html`<li class="status ${f.level}"><b aria-hidden="true">${BADGE[f.level]}</b> <span>${text ? text() : f.key}</span></li>`;
  };

  const body = html`
    <h2>${t("status.title")}</h2>
    <ul class="statuslist">${status.facts.map(line)}</ul>
    <p class="hint">${t("status.hint")}</p>
    <p><a class="btn secondary" href="/planner?gaps=1">${t("planner.showGaps")}</a></p>
    <!-- The counts above are useless on their own when no webhook is configured: every message queues, and
         until this link existed there was no way to read one. -->
    <p><a class="btn secondary" href="/outbox">${t("outbox.link")}</a></p>
    <form method="post" action="/admin/retention">${csrfField(session)}
      <p><button type="submit" class="secondary">${t("admin.retentionRun")}</button></p>
    </form>`;
  return layout({ t, title: t("status.title"), who, nav: navFor(t, roles, "status"), flash, body });
}
