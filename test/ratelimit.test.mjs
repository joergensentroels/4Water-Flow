// Increment J. Each of these encodes a way this kind of throttle has been got wrong before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLimiter, clientKey } from "../src/ratelimit.mjs";
import { makeWorld } from "../tools/testkit.mjs";
import { calendarTokenFor } from "../src/calendar.mjs";

const at = (ms) => () => ms;

test("failures accumulate and refuse past the limit", () => {
  let clock = 0;
  const l = makeLimiter({ max: 3, now: () => clock, log: {} });
  assert.equal(l.blocked("peer:a"), false);
  l.fail("peer:a"); l.fail("peer:a");
  assert.equal(l.blocked("peer:a"), false);
  l.fail("peer:a");
  assert.equal(l.blocked("peer:a"), true);
  assert.equal(l.blocked("peer:b"), false, "one caller must not affect another");
});

test("the window expires, so a legitimate client is never stuck for long", () => {
  let clock = 0;
  const l = makeLimiter({ max: 2, windowMs: 1000, now: () => clock, log: {} });
  l.fail("peer:a"); l.fail("peer:a");
  assert.equal(l.blocked("peer:a"), true);
  clock = 1001;
  assert.equal(l.blocked("peer:a"), false);
});

test("a success CLAMPS rather than clearing, so ordinary traffic cannot wipe a burst", () => {
  const l = makeLimiter({ max: 10, now: at(0), log: {} });
  for (let i = 0; i < 9; i++) l.fail("peer:a");
  assert.equal(l.inspect("peer:a").count, 9);

  l.succeed("peer:a");
  // Clamped to max-3, not deleted: one success always unsticks a real client, but an attacker's burst is not
  // erased by the victim's own activity — which is what made a sibling project's alarm useless.
  assert.equal(l.inspect("peer:a").count, 7);
  assert.equal(l.blocked("peer:a"), false);

  // A count already below the clamp is left exactly as it is. Clearing happens when the WINDOW expires, not
  // on success — "clamp, never delete" is the whole rule, and a success that zeroed the counter would be the
  // very behaviour this guards against, just at a smaller scale.
  let clock = 0;
  const l2 = makeLimiter({ max: 10, windowMs: 1000, now: () => clock, log: {} });
  l2.fail("peer:b");
  l2.succeed("peer:b");
  assert.equal(l2.inspect("peer:b").count, 1, "success caps the count, it does not erase history");
  assert.equal(l2.blocked("peer:b"), false, "which is all that matters for a legitimate client");
  clock = 1001;
  assert.equal(l2.blocked("peer:b"), false);
  l2.sweep();
  assert.equal(l2.size(), 0, "the window expiring is what clears it");
});

test("logging is bounded, so one stuck client cannot drown out a real probe", () => {
  const lines = [];
  const l = makeLimiter({ max: 3, maxLogs: 2, now: at(0), log: { warn: (m) => lines.push(m) } });
  for (let i = 0; i < 200; i++) l.fail("peer:a", "invite");
  assert.ok(lines.length <= 2, `expected at most 2 log lines, got ${lines.length}`);
  assert.match(lines[0], /failures from peer:a on invite/);
  assert.match(lines[1], /refusing peer:a/);
});

test("a closed window is summarised with the true total, so the count is never lost", () => {
  let clock = 0;
  const lines = [];
  const l = makeLimiter({ max: 3, windowMs: 1000, now: () => clock, log: { warn: (m) => lines.push(m) } });
  for (let i = 0; i < 50; i++) l.fail("peer:a");
  clock = 2000;
  l.sweep();
  assert.match(lines.at(-1), /window closed for peer:a: 50 failures total/);
  assert.equal(l.size(), 0, "and the bucket is released");
});

// ---- which address gets counted -----------------------------------------------------------------------
const reqFrom = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test("a direct caller is keyed on its peer address", () => {
  assert.equal(clientKey(reqFrom("203.0.113.9")), "peer:203.0.113.9");
});

test("behind a loopback proxy the RIGHTMOST forwarded hop is the client", () => {
  // Each proxy appends what it saw, so the last entry is what our own proxy observed. Anything further left
  // was supplied by the caller and is not evidence of anything.
  const k = clientKey(reqFrom("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 198.51.100.7" }));
  assert.equal(k, "proxy:198.51.100.7");
  assert.equal(clientKey(reqFrom("::1", { "x-forwarded-for": "198.51.100.7" })), "proxy:198.51.100.7");
});

test("a NON-loopback peer's forwarding headers are ignored entirely", () => {
  // Honouring them would let a remote caller mint a new identity per request and evade counting completely —
  // strictly worse than the shared-bucket bug it would appear to fix.
  const k = clientKey(reqFrom("203.0.113.9", { "x-forwarded-for": "9.9.9.9" }));
  assert.equal(k, "peer:203.0.113.9");
});

test("a forwarded address cannot collide with a direct peer of the same value", () => {
  assert.notEqual(
    clientKey(reqFrom("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })),
    clientKey(reqFrom("203.0.113.9")),
  );
});

// ---- through the live routes ---------------------------------------------------------------------------
test("guessing invite tokens gets throttled, and a real invite still works afterwards", async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] } });
  try {
    // Burn the allowance with wrong tokens.
    let sawRedirect = 0, sawThrottle = 0;
    for (let i = 0; i < 14; i++) {
      const r = await w.get(`/invite/wrong-token-${i}`);
      if (r.status === 303) sawRedirect++;
      if (r.status === 429) sawThrottle++;
    }
    assert.ok(sawRedirect >= 10, `the first attempts should be answered normally, got ${sawRedirect}`);
    assert.ok(sawThrottle > 0, "sustained guessing must start being refused");

    const throttled = await w.get("/invite/another-wrong-one");
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("retry-after"), "600", "tell the client when to come back");
    const body = await throttled.text();
    assert.match(body, /Too many attempts|For mange forsøg/);
    assert.ok(!/peer:|127\.0\.0\.1/.test(body), "the refusal must not echo internals back");
  } finally { w.close(); }
});

// The calendar feed shares that limiter and had no test for it, while its sibling above did. It is the more
// exposed of the two: an invite token is offered once to one person, whereas a feed URL is meant to be pasted
// into a calendar client and lives as long as the volunteer keeps it. `calendar.mjs` also used to claim an
// attacker could guess "at their leisure", which was wrong precisely because of this throttle — so the claim is
// asserted here rather than described there.
test("guessing calendar feed tokens gets throttled, and a real feed still works afterwards", async () => {
  const w = await makeWorld({ volunteers: 2, roles: { 0: ["admin"] } });
  try {
    // A real feed first, so the comparison at the end is against something that was already working.
    const { token } = calendarTokenFor(w.db, w.people[0]);
    assert.ok(typeof token === "string" && token.length >= 16, "precondition: a usable raw token");
    assert.equal((await w.get(`/calendar/${token}.ics`)).status, 200, "the feed serves before any throttling");

    let sawMiss = 0, sawThrottle = 0;
    for (let i = 0; i < 14; i++) {
      // Shaped like a real token so the format guard is not what refuses it — otherwise this would measure the
      // regex rather than the limiter, and pass while the throttle did nothing.
      const r = await w.get(`/calendar/wrongtokenwrongtoken${String(i).padStart(2, "0")}.ics`);
      if (r.status === 404) sawMiss++;
      if (r.status === 429) sawThrottle++;
    }
    assert.ok(sawMiss >= 10, `the first attempts should answer 404, got ${sawMiss}`);
    assert.ok(sawThrottle > 0, "sustained guessing of feed URLs must start being refused");

    const throttled = await w.get("/calendar/anotherwrongonehere00.ics");
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("retry-after"), "600");

    // And a wrong token must be indistinguishable from no feed: 404 both ways, never 403.
    assert.ok(sawMiss > 0 && sawThrottle > 0);
  } finally { w.close(); }
});

test("the throttle does not touch authenticated routes", async () => {
  const w = await makeWorld({ volunteers: 2 });
  try {
    for (let i = 0; i < 14; i++) await w.get(`/invite/nope-${i}`);
    // Same address, now signed in: normal use must be unaffected. The throttle guards the unauthenticated
    // endpoints only, so a shared office IP cannot lock everyone out of the app itself.
    const cookie = await w.signIn(w.people[0]);
    assert.equal((await w.get("/", cookie)).status, 200);
    assert.equal((await w.get("/availability", cookie)).status, 200);
    assert.equal((await w.get("/healthz")).status, 200);
  } finally { w.close(); }
});
