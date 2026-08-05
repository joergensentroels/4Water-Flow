// One way to tell people something happened, two callers (the availability nudge and a slot hitting the
// board). Built once on purpose: two notification paths is how one of them quietly stops working.
//
// The channel is Mattermost, because that is where the chasing already happens — a message in the channel
// people already read costs them nothing to adopt. The fallback is an OUTBOX, not SMTP: a zero-dependency
// TLS+auth SMTP client is a project of its own and the wrong thing to hand a volunteer-run nonprofit. Queued
// rows are durable, so wiring them to whatever mail the host already has is a small adapter, and nothing is
// lost in the meantime.
import { fetchBounded, OUTBOUND_TIMEOUT_MS } from "./outbound.mjs";
import { publicBaseUrl } from "./config.mjs";

export function notifyConfig(env = process.env) {
  const webhook = String(env.MATTERMOST_WEBHOOK || "").trim();
  return {
    webhook,
    channel: webhook ? "mattermost" : "outbox",
    // WHERE THE APP LIVES, so a message can say where to go.
    //
    // Every notification here is read in a chat channel away from the app, and until this existed not one of them
    // could link back. The discovery spec asked for the shift-exchange announcement to carry "a claim link"; the
    // shift reminder tells somebody to "hand it back on the shift exchange"; the nudge asks for availability. Three
    // messages naming a screen the reader had no way to reach except by remembering a hostname — and the entire
    // argument for posting into Mattermost was that it meets people where they already are. A message with no link
    // moves the chasing rather than reducing it.
    //
    // FOURWATER_BASE_URL, the variable four other callers already use — NOT a second one of its own. This nearly
    // shipped as FOURWATER_PUBLIC_URL, which would have meant an operator setting the address twice and links
    // working in invites but not in notifications, or the reverse, depending on which they remembered.
    // src/config.mjs carries the reasoning and does the validating. UNSET IS VALID: no link, nothing broken.
    publicUrl: publicBaseUrl(env),
    // Redaction happens at the boundary: nothing downstream ever receives the URL, so nothing downstream
    // can log it. A webhook URL IS the credential — anyone holding it can post as the integration.
    describe: () => (webhook ? `mattermost(${safeHost(webhook)})` : "outbox"),
  };
}

// Host only, and only if it parses. Never the path — the secret is in the path.
function safeHost(url) {
  try { return new URL(url).host; } catch { return "invalid-url"; }
}

// A webhook that never answers is worse than one that refuses, and it was the only outcome this file could not
// see: 'sent' requires res.ok and 'failed' records the reason, but a hang produces neither. runNudge awaits one
// send per volunteer, so one silent Mattermost meant nobody after the first got nudged — invisible in the data
// AND the log, in a file whose whole argument is that a broken webhook should be visible in the data.
// src/outbound.mjs carries the bound and the reasoning; see also the OIDC callers, which had the same hole.
// SQLITE_CONSTRAINT_UNIQUE. Measured rather than looked up, because the near neighbours matter: a NOT NULL
// violation is 1299, a CHECK violation 275, and a missing table 1 — and all three report `errstr` as
// "constraint failed" or worse, so `errstr` cannot tell them apart. `errcode` can, and it is the only thing that
// distinguishes "this message was already sent" from "the database rejected the write".
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function makeNotifier({ db, config = notifyConfig(), fetchImpl = fetch, log = console, now = () => new Date(),
                               timeoutMs = OUTBOUND_TIMEOUT_MS }) {
  const record = db.prepare(`INSERT INTO notifications (kind, person_id, period, channel, body, status, error, created_at)
                             VALUES (:kind, :pid, :period, :channel, :body, :status, :error, :at)`);

  // The webhook URL must not reach a log line OR the notifications table. The log was already careful; the table
  // was not, and it is the more exposed of the two — `error` is rendered on the outbox screen, so a credential
  // landing there is shown to whoever opens it.
  //
  // Nothing observed leaks it today: the timeout text names "the webhook", a non-2xx names only the status, and
  // undici's rejection is "fetch failed". So this is belt and braces. It is here because the alternative is
  // depending forever on the exact wording of somebody else's error message, and this file's opening claim is
  // that redaction happens at the boundary — which should be true by construction, not by luck.
  const redact = (s) => {
    const text = String(s ?? "");
    return config.webhook ? text.split(config.webhook).join(`[${config.describe()}]`) : text;
  };

  // Returns a result, never throws. A notification failure must not fail the action that triggered it: the
  // slot really was handed back, and telling the volunteer otherwise would be a lie that makes them try
  // again. Callers may ignore the return value entirely.
  async function send({ kind, personId = null, period = null, body }) {
    const at = now().toISOString();
    const base = { kind, pid: personId, period, channel: config.channel, body: String(body ?? "") };

    // Claim the (kind, person, period) slot FIRST. Doing it before delivery is what makes the nudge
    // idempotent even if two schedulers overlap: the second insert violates UNIQUE and we stop.
    let rowId;
    try {
      rowId = Number(record.run({ ...base, status: "queued", error: null, at }).lastInsertRowid);
    } catch (e) {
      // ONLY a UNIQUE violation means "already sent". This catch used to return that for every possible insert
      // failure, which made it the exact defect the rest of this file is written against: an explanation that
      // renders perfectly and may be false. A CHECK violation, a NOT NULL violation, a column missing after a
      // botched migration, a full disk — every one of them was reported to the caller as "we already told them",
      // and `runNudge` only reads `ok`, so the volunteer silently never got nudged. No row, no log line, nothing
      // in the data. In a file whose whole argument is that a broken channel must be visible in the data.
      if (e?.errcode === SQLITE_CONSTRAINT_UNIQUE) {
        return { ok: false, skipped: true, reason: "already_sent" };
      }
      // Everything else is a real failure and says so. There is no row to mark 'failed' — the insert is what
      // failed — so the log is the only place it can surface, which is why it is unconditional here.
      log.warn?.(`[notify] ${kind} could not be recorded: ${redact(e?.message)}`);
      return { ok: false, skipped: false, reason: "not_recorded", error: redact(e?.message) };
    }

    if (config.channel === "outbox") {
      return { ok: true, channel: "outbox", queued: true, id: rowId };
    }

    try {
      const res = await fetchBounded(fetchImpl, config.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: base.body }),
      }, { timeoutMs, label: "the webhook" });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(rowId);
      return { ok: true, channel: "mattermost", id: rowId };
    } catch (e) {
      // Keep the row as 'failed' with the reason, so a silently-broken webhook is visible in the data
      // rather than only in a log nobody reads.
      const why = redact(e.message);
      db.prepare("UPDATE notifications SET status='failed', error=? WHERE id=?").run(why.slice(0, 300), rowId);
      log.warn?.(`[notify] ${kind} via ${config.describe()} failed: ${why}`);
      return { ok: false, channel: "mattermost", error: why, id: rowId };
    }
  }

  return { send, config };
}

// ---- message bodies -----------------------------------------------------------------------------------
// Built from strings/, so the activity label comes from config and the wording is translatable. Nothing
// here names an activity or a weekday.
// A link on its own line, appended only when the deployment knows its own address. Kept as a SEPARATE sentence
// rather than a {link} placeholder inside each message: an unset URL would leave a placeholder to strip and stray
// punctuation behind it, and test/strings.test.mjs requires both locales to carry the same placeholders — so the
// empty case would have had to be a second copy of every string.
export const withLink = (t, base, key, publicUrl, path) =>
  (publicUrl ? [base, t(key, { url: publicUrl + path })].join("\n") : base);

export const slotOpenMessage = (t, { when, activity, eligible, publicUrl = null }) =>
  withLink(t, t("notify.slotOpen", { when, activity, eligible }), "notify.linkBoard", publicUrl, "/board");

export const nudgeMessage = (t, { name, from, to, publicUrl = null }) =>
  withLink(t, t("notify.nudge", { name, from, to }), "notify.linkAvailability", publicUrl, "/availability");

// WITH the role, and with the date already formatted by the caller. This message is read in a chat channel away
// from the app, so it is the one place that has to stand entirely alone — the same reason the slot-open
// announcement carries the role. An ISO date and a bare 'l' would technically be information.
export const shiftReminderMessage = (t, { name, when, activity, publicUrl = null }) =>
  withLink(t, t("notify.shiftReminder", { name, when, activity }), "notify.linkBoard", publicUrl, "/board");

// A stub transport for tests: records what would have been sent, and can be told to fail.
export function stubTransport({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body).text });
    if (fail) throw new Error("network is down");
    return { ok: true, status: 200 };
  };
  return { calls, fetchImpl };
}
