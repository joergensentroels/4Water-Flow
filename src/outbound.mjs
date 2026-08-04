// Every request this app makes to somebody else's server, with a bound on how long it may take.
//
// This exists because "it failed" and "it never answered" are different outcomes and only the first was handled
// anywhere. Node's fetch has no request timeout — undici's headers timeout is 300 seconds — so a server that
// accepts the connection and goes quiet stalls the caller for five minutes. Every fallback in this codebase is
// written as a `catch`, and a hang does not reject, so none of them fire:
//
//   - the OIDC discovery fallback ("degrade to NextCloud's endpoint layout rather than locking every volunteer
//     out") is unreachable against a silent instance, which is precisely when it is needed;
//   - the nudge job awaits one delivery per volunteer, so one silent Mattermost meant nobody after the first
//     got nudged, with nothing logged and no row saying anything was wrong.
//
// A timeout turns both into the failure the surrounding code already knows how to handle.
//
// Raced rather than relying on the AbortSignal alone. Real fetch honours it, but both callers accept an
// injectable transport, and a transport that ignores the signal would leave the promise permanently unsettled —
// the exact failure this removes. The signal is still passed, and aborted, so the socket is released rather
// than left hanging on a server that has stopped talking.

// Eight seconds. Both callers are on a clock a person can feel: one is a volunteer waiting on a sign-in
// redirect, the other a chat message that is worthless late. Long enough to cross a slow link, short enough
// that the fallback happens while the volunteer is still looking at the screen.
export const OUTBOUND_TIMEOUT_MS = 8_000;

export async function fetchBounded(fetchImpl, url, opts = {},
                                   { timeoutMs = OUTBOUND_TIMEOUT_MS, label = "the server" } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetchImpl(url, { ...opts, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} did not answer within ${timeoutMs / 1000}s`));
        }, timeoutMs);
        timer.unref?.();     // a pending timeout must never be the reason the process stays alive
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
