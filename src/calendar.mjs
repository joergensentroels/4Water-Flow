// A subscribable calendar feed, so a volunteer's shifts appear in the calendar app they already look at.
//
// Why this is worth its complexity: the pain being replaced is "it's a nightmare on the phone". Even a good
// phone-first web app is something you have to remember to open; a calendar subscription is something that
// tells YOU. Missed shifts are the failure this scheduling exists to prevent, and a reminder the volunteer
// never has to seek out is the strongest tool against them.
//
// Three things are load-bearing here and none of them are the iCalendar syntax.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ---- times ---------------------------------------------------------------------------------------------
// The database stores a DATE and a wall-clock HOUR. Nothing records an offset, because the department has one
// and everyone is in it — which is fine until a calendar has to be told when 19:00 actually is.
//
// Two ways to express that in iCalendar: a floating/TZID time plus a VTIMEZONE block, or an absolute UTC
// instant. This emits UTC. A VTIMEZONE has to carry the zone's whole DST ruleset, hand-written and destined
// to rot; a UTC instant is unambiguous forever and every client agrees on it. The cost is that we must
// resolve "19:00 in Europe/Copenhagen on this date" ourselves — with Intl, which ships with Node and knows
// the rules, rather than a hardcoded +01:00 that would be an hour wrong for half the season.
export function tzOffsetMs(instantMs, timeZone) {
  // What clock time does `timeZone` show at this instant? The difference from the same reading taken as UTC
  // IS the offset. Using formatToParts rather than string parsing so a locale cannot change the answer.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(instantMs))) p[type] = value;
  // Intl reports midnight as hour 24 in some ICU versions; normalise before arithmetic.
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUtc - instantMs;
}

// The UTC instant at which a given wall-clock time occurs in `timeZone`.
//
// Iterated rather than solved: the offset depends on the instant, and the instant is what we are looking for.
// Two passes converge everywhere except inside a DST gap, where the wall time does not exist at all and any
// answer is a choice — this one lands just after the jump, which is what calendars do.
export function utcInstantFor(dateIso, hour, minute, timeZone) {
  const naive = Date.parse(`${dateIso}T00:00:00Z`) + hour * 3600000 + minute * 60000;
  let t = naive - tzOffsetMs(naive, timeZone);
  const corrected = naive - tzOffsetMs(t, timeZone);
  if (corrected !== t) t = corrected;
  return t;
}

export const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// ---- text ----------------------------------------------------------------------------------------------
// RFC 5545 §3.3.11: backslash, semicolon and comma are separators inside a property value and a newline is
// written as \n. An activity label containing a comma would otherwise silently truncate the summary — and the
// labels come from a config file somebody else edits.
export const escapeText = (s) => String(s ?? "")
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
  .replace(/\r\n|\r|\n/g, "\\n");

// RFC 5545 §3.1: lines are folded at 75 OCTETS, not characters. Folding by character length would split a
// multi-byte character across the fold and hand the client a mangled name — which matters here, because
// volunteer names are exactly where non-ASCII shows up.
export function foldLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0, limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never cut inside a UTF-8 sequence: continuation bytes are 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;                 // continuation lines carry a leading space, which counts toward the 75
  }
  return out.join("\r\n ");
}

// ---- the document --------------------------------------------------------------------------------------
export function buildIcs({ rows, calendarName, timeZone, eventMinutes = 90, now = Date.now(), uidDomain = "4water.invalid", t = null }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//4water//Flow//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    // Clients poll on their own schedule; this is a hint, not a promise. An hour is frequent enough that a
    // swap agreed in the morning is on the phone by the afternoon.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  for (const r of rows) {
    const start = utcInstantFor(r.date, r.hour, r.minute ?? 0, timeZone);
    // One duration for every shift, from config. This used to read `Number(r.minutes) > 0 ? Number(r.minutes)
    // : eventMinutes`, a per-row override that nothing has ever set: `calendarRowsFor` does not select such a
    // column and no test passes one, so the ternary had exactly one reachable arm. A hook that looks wired and
    // is not is worse than no hook, because the next person reads it as a supported feature.
    //
    // If per-activity durations are wanted — a two-hour workshop against a ninety-minute class is the obvious
    // case — they belong on the activity entries in `config/pattern.json`, selected by `calendarRowsFor` and
    // validated in `config.mjs` beside `calendar.eventMinutes`. Adding them here alone would not reach the data.
    const minutes = eventMinutes;
    const role = r.role && t ? ` (${t(`role.dance.${r.role}`)})` : "";
    lines.push(
      "BEGIN:VEVENT",
      // Stable across regenerations: the same shift must UPDATE in the client, not appear twice. Keyed on the
      // assignment row, which survives a hand-back and re-claim.
      `UID:assignment-${r.assignmentId}@${uidDomain}`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(start + minutes * 60000)}`,
      `SUMMARY:${escapeText(`${r.activityLabel}${role}`)}`,
      // 'TENTATIVE' for a proposal a planner has not locked in yet: it is genuinely not settled, and showing
      // it as confirmed would have volunteers turning up for shifts that were still being moved around.
      `STATUS:${r.state === "proposed" ? "TENTATIVE" : "CONFIRMED"}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  // CRLF throughout, per the spec. Some clients tolerate LF; some silently ignore the whole file.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---- the token -----------------------------------------------------------------------------------------
// A calendar client cannot present a session cookie, so the URL itself is the credential. That has
// consequences which are stated plainly on the profile page and in the privacy notice rather than hidden:
// anyone holding the link can read that volunteer's shifts, so it is revocable and rotatable.
//
// Stored as a HASH, like invitations. A copy of the database must not yield working calendar URLs.
export const hashCalendarToken = (token) => createHash("sha256").update(String(token)).digest("hex");

export function calendarTokenFor(db, personId, { rotate = false } = {}) {
  const row = db.prepare("SELECT calendar_token_hash AS h FROM people WHERE id = ?").get(personId);
  if (!row) return null;
  if (row.h && !rotate) return { token: null, existing: true };   // the raw token is unrecoverable, by design
  const token = randomBytes(24).toString("base64url");
  db.prepare("UPDATE people SET calendar_token_hash = ? WHERE id = ?").run(hashCalendarToken(token), personId);
  return { token, existing: false };
}

export function revokeCalendarToken(db, personId) {
  return db.prepare("UPDATE people SET calendar_token_hash = NULL WHERE id = ?").run(personId).changes === 1;
}

export const hasCalendarToken = (db, personId) =>
  Boolean(db.prepare("SELECT calendar_token_hash AS h FROM people WHERE id = ?").get(personId)?.h);

// What actually protects this endpoint, written out because the comment that used to be here credited the wrong
// thing and got a fact wrong on the way.
//
// It said an attacker "can guess at their leisure". They cannot: `GET /calendar/:token.ics` runs every failed
// lookup through the same limiter that guards sign-in and invite redemption (`limiter.fail(key,
// "calendar-token")` in server.mjs), and answers 404 rather than 403 so a wrong token and a missing feed are
// indistinguishable. server.mjs's own comment says so. Two comments about one endpoint, disagreeing.
//
// The real protections, in the order they matter: the token is 24 random bytes, so guessing is not a strategy;
// failed lookups are throttled per caller; and only a SHA-256 hash is stored, so a copy of the database yields
// no working URLs.
//
// The constant-time compare below is NOT one of them, and saying so is more useful than implying it is. A
// timing attack on a comparison needs the attacker not to know the value being compared against — here they
// choose the token and can compute its hash themselves, and learning a stored hash from timing would mean
// finding a token whose SHA-256 has a chosen prefix, which is the brute force it was supposed to avoid. It is
// kept because comparing secrets in constant time is the right habit and it costs nothing at forty rows, not
// because anything rests on it. If this ever guards something guessable, that changes.
//
// One honest leak: the loop returns on the first match, so the time reveals roughly the matching row's position
// in the table. That is information only available to somebody who already holds a valid token.
export function personByCalendarToken(db, token) {
  const raw = String(token ?? "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(raw)) return null;
  const want = hashCalendarToken(raw);
  for (const row of db.prepare("SELECT id, name, calendar_token_hash AS h FROM people WHERE calendar_token_hash IS NOT NULL AND status='active'").all()) {
    if (row.h.length === want.length && timingSafeEqual(Buffer.from(row.h), Buffer.from(want))) {
      return { personId: row.id, name: row.name };
    }
  }
  return null;
}
