// The outbox. Increment T.
//
// Why this page exists: the app composes messages — availability nudges, board announcements — and files them
// in `notifications`. With `MATTERMOST_WEBHOOK` unset, which is the DEFAULT and 4water's actual starting
// state, every one of them is written with status 'queued' and delivered to nobody. Until this page there was
// no way to read them. The status page could say "23 messages are queued" and that was the end of it: a
// feature that composed text nobody could ever see, which is worse than not having the feature, because the
// planner believes the volunteers were nudged.
//
// So: queued first, because those are the ones a human still has to act on — copy into the group chat and the
// job is done. Failed next, because those need a look at the webhook. Sent last, as history.
import { html } from "../http.mjs";
import { layout, navFor } from "../views.mjs";

// 'queued' before 'failed' before 'sent'. Deliberately not created_at order: the newest message is not the
// most actionable one, an undelivered one is.
const STATUS_RANK = { queued: 0, failed: 1, sent: 2 };

export function listOutbox(db, { limit = 100, status = null } = {}) {
  const rows = db.prepare(`
    SELECT n.id, n.kind, n.period, n.channel, n.body, n.status, n.error, n.created_at AS createdAt,
           p.name AS person
      FROM notifications n
      LEFT JOIN people p ON p.id = n.person_id
     ${status ? "WHERE n.status = :status" : ""}
     ORDER BY CASE n.status WHEN 'queued' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, n.id DESC
     LIMIT :lim
  `).all(status ? { status, lim: limit } : { lim: limit });

  const counts = { queued: 0, failed: 0, sent: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM notifications GROUP BY status").all()) {
    if (r.status in counts) counts[r.status] = r.n;
  }
  // `truncated` is the honest bit: a page that shows 100 of 400 rows and does not say so reads as "that is
  // all of them". Silent truncation is how a planner concludes the nudges went out.
  const total = counts.queued + counts.failed + counts.sent;
  return { rows, counts, total, truncated: Math.max(0, total - rows.length), limit, filter: status };
}

const FILTERS = ["queued", "failed", "sent"];

export function renderOutbox({ t, roles, who, outbox, webhookConfigured, flash }) {
  const row = (r) => html`
    <li class="outboxitem status ${r.status === "sent" ? "ok" : r.status === "queued" ? "warn" : "bad"}">
      <p class="outboxmeta">
        <b>${t(`outbox.kind.${r.kind}`)}</b>
        · ${r.person ?? t("outbox.everyone")}
        · ${r.createdAt.slice(0, 16).replace("T", " ")}
        · ${t(`outbox.status.${r.status}`)}
      </p>
      <p class="outboxbody">${r.body}</p>
      ${r.error ? html`<p class="hint">${r.error}</p>` : ""}
    </li>`;

  const body = html`
    <h2>${t("outbox.title")}</h2>

    ${webhookConfigured ? "" : html`<p class="flash">${t("outbox.noWebhook")}</p>`}

    <p class="hint" id="outbox-filter">${t("outbox.filter")}</p>
    <div class="chiprow" role="group" aria-labelledby="outbox-filter">
      <a class="chip" href="/outbox"${outbox.filter ? "" : html` aria-current="true"`}>${
        t("outbox.all", { n: outbox.total })}</a>
      ${FILTERS.map((s) => html`<a class="chip" href="/outbox?status=${s}"${
        outbox.filter === s ? html` aria-current="true"` : ""}>${t(`outbox.status.${s}`)} (${outbox.counts[s]})</a>`)}
    </div>

    ${outbox.rows.length === 0
      ? html`<p class="empty">${t("outbox.empty")}</p>`
      : html`<ul class="outbox">${outbox.rows.map(row)}</ul>`}

    ${outbox.truncated > 0 ? html`<p class="hint">${t("outbox.truncated", { n: outbox.truncated, shown: outbox.rows.length })}</p>` : ""}
    <p class="hint">${t("outbox.retention")}</p>
    <p><a class="btn secondary" href="/status">${t("nav.status")}</a></p>`;

  return layout({ t, title: t("outbox.title"), who, nav: navFor(t, roles, "status"), flash, body });
}
