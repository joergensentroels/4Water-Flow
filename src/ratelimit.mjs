// Throttling for the two endpoints anyone can reach without a session: invite redemption and the OIDC
// callback. Both take a secret from the URL, so both are guessable in principle.
//
// This is an ALARM more than a lock. An invite token is 24 random bytes — nobody is guessing it — so the
// value here is that a burst of failures becomes visible instead of silent. That framing matters, because a
// throttle designed as a lock gets tuned aggressively and then locks out real people.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
// A stuck client must not be able to drown the signal: one browser retrying forever produced thousands of
// log lines in a sibling project and hid a real probe. So logging is bounded per window, not per failure.
const MAX_LOGS_PER_WINDOW = 2;

// Which address to count. Behind a reverse proxy every request arrives from 127.0.0.1, so counting the peer
// would put every remote client in ONE bucket and let the first bad sign-in lock out everybody.
//
// The rule, learned the hard way: trust forwarding headers ONLY when the peer is loopback, and then take the
// RIGHTMOST hop — each proxy appends what it saw, so anything further left was supplied by the caller. A
// non-loopback peer's headers are ignored entirely; honouring them would let a remote caller mint a fresh
// identity per request and evade counting altogether, which is strictly worse than the bug it fixes.
export function clientKey(req) {
  const peer = req.socket?.remoteAddress ?? "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (loopback) {
    const xff = String(req.headers?.["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return `proxy:${xff[xff.length - 1]}`;   // prefixed so it cannot collide with a direct peer
  }
  return `peer:${peer}`;
}

export function makeLimiter({ windowMs = WINDOW_MS, max = MAX_FAILURES, maxLogs = MAX_LOGS_PER_WINDOW,
                             now = () => Date.now(), log = console } = {}) {
  const buckets = new Map();   // key -> { count, first, logs, summarised }

  const bucketFor = (key) => {
    const b = buckets.get(key);
    if (!b || now() - b.first > windowMs) {
      const fresh = { count: 0, first: now(), logs: 0, summarised: false };
      buckets.set(key, fresh);
      return fresh;
    }
    return b;
  };

  return {
    // True when this caller has burned through the window's allowance.
    blocked(key) {
      const b = buckets.get(key);
      if (!b) return false;
      if (now() - b.first > windowMs) { buckets.delete(key); return false; }
      return b.count >= max;
    },

    fail(key, what = "") {
      const b = bucketFor(key);
      b.count++;
      // Two lines per window: the burst opening, and the moment refusals start. Then one summary when the
      // window closes, carrying the true total — so the count is never lost, only the repetition.
      if (b.count === 1 || b.count === max) {
        if (b.logs < maxLogs) { b.logs++; log.warn?.(`[limit] ${b.count === max ? "refusing" : "failures from"} ${key}${what ? ` on ${what}` : ""}`); }
      }
      return { count: b.count, blocked: b.count >= max };
    },

    // A success does NOT delete the bucket. Deleting it means ordinary traffic from the same address
    // continuously wipes an attacker's burst — an alarm the victim's own activity keeps resetting. Clamping
    // instead means one success always unsticks a legitimate client whatever the burst size, while a small
    // count still clears naturally.
    succeed(key) {
      const b = buckets.get(key);
      if (!b) return;
      b.count = Math.min(b.count, Math.max(0, max - 3));
    },

    // Call periodically; also flushes the closing summary for windows that saw refusals.
    sweep() {
      for (const [key, b] of buckets) {
        if (now() - b.first <= windowMs) continue;
        if (b.count >= max && !b.summarised) log.warn?.(`[limit] window closed for ${key}: ${b.count} failures total`);
        buckets.delete(key);
      }
    },

    inspect: (key) => ({ ...(buckets.get(key) ?? { count: 0 }) }),
    size: () => buckets.size,
  };
}
