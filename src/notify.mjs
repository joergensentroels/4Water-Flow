// One way to tell people something happened, two callers (the availability nudge and a slot hitting the
// board). Built once on purpose: two notification paths is how one of them quietly stops working.
//
// The channel is Mattermost, because that is where the chasing already happens — a message in the channel
// people already read costs them nothing to adopt. The fallback is an OUTBOX, not SMTP: a zero-dependency
// TLS+auth SMTP client is a project of its own and the wrong thing to hand a volunteer-run nonprofit. Queued
// rows are durable, so wiring them to whatever mail the host already has is a small adapter, and nothing is
// lost in the meantime.

export function notifyConfig(env = process.env) {
  const webhook = String(env.MATTERMOST_WEBHOOK || "").trim();
  return {
    webhook,
    channel: webhook ? "mattermost" : "outbox",
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
// see. Node's fetch has no request timeout — undici's headers timeout is 300s — so one unresponsive Mattermost
// stalled each send for five minutes, and runNudge awaits send once per volunteer in a loop. Thirty volunteers
// is two and a half hours in which nobody after the first gets nudged, nothing is logged, and no row says
// anything is wrong. This file's whole argument is that a broken webhook should be visible in the data; a hang
// was invisible in the data AND the log.
//
// Ten seconds, because the thing being sent is a chat message: one that takes longer has failed in every sense
// a volunteer cares about, and failing it turns the stall into a 'failed' row with a reason.
const WEBHOOK_TIMEOUT_MS = 10_000;

// Raced rather than relying on the signal alone. Real fetch honours AbortSignal, but the transport here is
// injectable, and a transport that ignores the signal would leave send() permanently unsettled — the exact
// failure this exists to remove. The signal is still passed so the socket is actually released.
async function withTimeout(start, ms, label) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      start(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} did not answer within ${ms / 1000}s`));
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeNotifier({ db, config = notifyConfig(), fetchImpl = fetch, log = console, now = () => new Date(),
                               timeoutMs = WEBHOOK_TIMEOUT_MS }) {
  const record = db.prepare(`INSERT INTO notifications (kind, person_id, period, channel, body, status, error, created_at)
                             VALUES (:kind, :pid, :period, :channel, :body, :status, :error, :at)`);

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
      return { ok: false, skipped: true, reason: "already_sent" };
    }

    if (config.channel === "outbox") {
      return { ok: true, channel: "outbox", queued: true, id: rowId };
    }

    try {
      const res = await withTimeout((signal) => fetchImpl(config.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: base.body }),
        signal,
      }), timeoutMs, "the webhook");
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(rowId);
      return { ok: true, channel: "mattermost", id: rowId };
    } catch (e) {
      // Keep the row as 'failed' with the reason, so a silently-broken webhook is visible in the data
      // rather than only in a log nobody reads.
      db.prepare("UPDATE notifications SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), rowId);
      log.warn?.(`[notify] ${kind} via ${config.describe()} failed: ${e.message}`);
      return { ok: false, channel: "mattermost", error: e.message, id: rowId };
    }
  }

  return { send, config };
}

// ---- message bodies -----------------------------------------------------------------------------------
// Built from strings/, so the activity label comes from config and the wording is translatable. Nothing
// here names an activity or a weekday.
export const slotOpenMessage = (t, { when, activity, eligible }) =>
  t("notify.slotOpen", { when, activity, eligible });

export const nudgeMessage = (t, { name, from, to }) =>
  t("notify.nudge", { name, from, to });

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
