// Loading the two seam files. Everything department-specific enters the program HERE and nowhere else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Tolerates a leading byte-order mark, and names the file when it still cannot parse.
//
// RUNBOOK tells an operator to hand-edit config/pattern.json for four values — the clock times, the hand-back
// cutoff, the shift length, the CSV delimiter. Notepad and several other Windows editors write a BOM when they
// save, and `JSON.parse` refuses one. Measured on a file differing from the working config by exactly that one
// invisible character: a SyntaxError complaining about an unexpected token which itself renders as nothing,
// quoting a snippet that appears to begin with an ordinary brace.
//
// The real server exited 1 with that stack and nothing else: no filename, no hint that the content is fine and
// the first character is not, and nothing an operator could act on. For a failure caused by saving a file in the
// obvious editor, that is the worst possible diagnosis.
//
// This app already writes a BOM deliberately, in the CSV export, precisely because Windows tools expect one — so
// it knows they exist. Refusing to read what its own environment produces was the asymmetry. Stripping is what
// every BOM-aware reader does (Python's `utf-8-sig`, Excel, LibreOffice); it changes nothing for a file without
// one, since the mark is only meaningful at the very start.
const readJson = (p) => {
  const text = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`config: ${p} is not valid JSON — ${e.message}`); }
};

// Which build is running, read once at load and shown on /status.
//
// A pre-release suffix, not `1.0.0`, and the suffix is the honest part: this is feature-complete and the whole suite
// passes, and it has never been built as a container, never spoken to a real NextCloud, and never been used by a
// volunteer. A version number that claims otherwise is the same overstatement as a comment asserting a cause the
// code contradicts. What makes it 1.0.0 is written in RUNBOOK.md.
//
// That sentence used to state a test count. PLAN.md is the only place allowed to, and a test enforces it — but
// the test scanned the markdown documents only, and this is source. Worse, the number and the word were split
// across a line wrap with a `// ` between them, so even a scan extended to source would have walked past it. It
// was stale by two dozen before anybody looked. Both holes are closed now, and the number is described rather
// than quoted here: writing it out to explain its own removal is how the first draft of this comment became an
// offender against the check it was documenting.
//
// This is also the only thing that reads package.json at runtime. Until now the Dockerfile copied it for no
// reason a running app could detect — which test/image.test.mjs said out loud rather than implying coverage it
// did not have. Now the copy is load-bearing and that test notices if it goes missing.
export const VERSION = (() => {
  try { return String(readJson(path.join(ROOT, "package.json")).version || "unknown"); }
  catch { return "unknown"; }        // a version nobody can read must not stop the app serving a schedule
})();

// The permission roles the application itself refers to by name. Declared here, beside the validation that
// enforces them, so there is one answer to "which roles must exist".
export const REQUIRED_ROLES = ["admin", "planner", "volunteer"];

// One validator, used both when loading the file and when the admin screen writes it back. Two copies would
// let the admin save a file that the next boot refuses to load — a self-inflicted outage.
export function validatePattern(p) {
  const err = (m) => { throw new Error(`config: ${m}`); };
  if (!p || typeof p !== "object") err("not an object");
  if (!Array.isArray(p.activities) || p.activities.length === 0) err("at least one activity is required");
  if (!Array.isArray(p.weekly) || p.weekly.length === 0) err("at least one weekly entry is required");
  if (!p.season?.key || !p.season?.from || !p.season?.to) err("season needs key, from and to");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.season.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.season.to)) err("season dates must be yyyy-mm-dd");
  if (p.season.from > p.season.to) err("the season ends before it starts");

  const keys = new Set();
  for (const a of p.activities) {
    if (!a.key || !/^[a-z0-9_]+$/.test(a.key)) err(`activity key "${a.key}" must be lowercase letters, digits or underscores`);
    if (keys.has(a.key)) err(`duplicate activity key "${a.key}"`);
    if (!a.label) err(`activity "${a.key}" has no label`);
    keys.add(a.key);

    // What the activity needs staffing-wise. Most partner-dance classes need a leader AND a follower;
    // a workshop can be run by one person whose role is irrelevant. Absent means {any: 1}, so an older
    // config keeps working and reads as "one person, role does not matter".
    if (a.needs !== undefined) {
      const n = a.needs;
      if (!n || typeof n !== "object" || Array.isArray(n)) err(`activity "${a.key}": needs must be an object like {"l":1,"f":1} or {"any":1}`);
      for (const [role, count] of Object.entries(n)) {
        if (!["l", "f", "any"].includes(role)) err(`activity "${a.key}": unknown role "${role}" — use l, f or any`);
        if (!Number.isInteger(count) || count < 0 || count > 10) err(`activity "${a.key}": needs.${role} must be a whole number 0..10`);
      }
      if (Object.values(n).reduce((s, c) => s + c, 0) < 1) err(`activity "${a.key}": needs at least one person`);
      // Mixing "any" with a specific role is ambiguous: would a leader satisfy the any-slot or the l-slot?
      // Refusing is better than picking a rule nobody can predict.
      if (n.any && (n.l || n.f)) err(`activity "${a.key}": use either {"any":n} or {"l":..,"f":..}, not both`);
    }
  }
  // A weekly entry naming an activity that does not exist would otherwise surface months later as "why is
  // there no yoga slot" — far harder to trace than a startup error.
  for (const w of p.weekly) {
    if (!Number.isInteger(w.dayOfWeek) || w.dayOfWeek < 0 || w.dayOfWeek > 6) err(`dayOfWeek must be 0..6, got ${w.dayOfWeek}`);
    if (!Number.isInteger(w.hour) || w.hour < 0 || w.hour > 23) err(`hour must be 0..23, got ${w.hour}`);
    if (!Array.isArray(w.activities) || w.activities.length === 0) err("a weekly entry needs at least one activity");
    for (const k of w.activities) if (!keys.has(k)) err(`weekly references unknown activity "${k}"`);
    // Optional, and absent means weekly. Bounded above because a slot recurring less often than every eighth week
    // is almost certainly a typo, and a typo here removes sessions from the plan without saying anything.
    if (w.everyNth !== undefined) {
      if (!Number.isInteger(w.everyNth) || w.everyNth < 1 || w.everyNth > 8) {
        err(`everyNth must be a whole number 1..8 (1 = every week, 2 = fortnightly), got ${w.everyNth}`);
      }
    }
    if (w.weekOffset !== undefined) {
      const every = Number(w.everyNth ?? 1);
      // An offset at or above the cadence can NEVER match: `week % 2 === 2` is false for every week there will
      // ever be, so the slot silently produces no sessions and the season looks thinner than anybody intended.
      // Refused at load, where it is one message, rather than discovered as an absence months later.
      if (!Number.isInteger(w.weekOffset) || w.weekOffset < 0 || w.weekOffset >= every) {
        err(`weekOffset must be a whole number from 0 to ${every - 1} for everyNth ${every} — `
          + `${w.weekOffset} can never come round, so that slot would never run at all`);
      }
    }
  }
  // Every role the CODE depends on, not just the one it was checking.
  //
  // This required only `volunteer`, while eleven gated routes, `IMPLIES` and the last-admin guard all name
  // `admin` or `planner` as string literals. Measured on a config declaring `roles: ["volunteer"]`: it validated,
  // seeded that one role, and then `setRole(…, "admin", true)` returned `no_such_role`, `requireRole` gave 403,
  // and the boot warning "there is no administrator yet" became permanently true with no remedy inside the app.
  // A locked-out instance from a config the validator approved — precisely the self-inflicted outage this
  // function's own header says it exists to prevent.
  //
  // `roles` is therefore not a seam. Which roles EXIST is fixed by the code; config only gets to list them, and
  // test/deploy.test.mjs checks this constant against the names the source actually gates on, so a fourth role
  // added in code cannot be left out of here.
  if (!Array.isArray(p.roles)) err("roles must be an array");
  const missing = REQUIRED_ROLES.filter((r) => !p.roles.includes(r));
  if (missing.length) err(`roles must include ${missing.join(", ")} — the app gates routes on ${missing.length > 1 ? "these names" : "this name"} and cannot grant a role that does not exist`);

  // The calendar feed needs to know when "19:00" actually is, and how long a shift runs — neither of which the
  // schema records. Absent means the defaults below, so an older config keeps working.
  if (p.calendar !== undefined) {
    const c = p.calendar;
    if (!c || typeof c !== "object" || Array.isArray(c)) err("calendar must be an object");
    if (c.timezone !== undefined) {
      if (typeof c.timezone !== "string") err("calendar.timezone must be a string like \"Europe/Copenhagen\"");
      // Asked of Intl rather than pattern-matched: a typo like "Europe/Copenhagn" looks perfectly well-formed
      // and would silently put every shift in UTC, an hour or two off, all season.
      try { new Intl.DateTimeFormat("en-US", { timeZone: c.timezone }); }
      catch { err(`calendar.timezone "${c.timezone}" is not a time zone this system knows`); }
    }
    if (c.eventMinutes !== undefined) {
      if (!Number.isInteger(c.eventMinutes) || c.eventMinutes < 15 || c.eventMinutes > 600) {
        err("calendar.eventMinutes must be a whole number of minutes, 15..600");
      }
    }
  }

  // How late a shift may be handed back. THE ONLY CONFIG SECTION THIS VALIDATOR DID NOT LOOK AT, and the one
  // RUNBOOK singles out: "Without a sensible value the shift exchange becomes the no-show channel."
  //
  // `patternFromForm` sets it with a bare `Number(form.cutoffDays)`, and the form's only protection is
  // `type="number" min="0" max="30"` — client side. Measured by posting to /admin/season directly, every one of
  // these was accepted and written to the file:
  //
  //   "abc" -> stored null, effective 0        the cutoff is off, silently
  //   "-5"  -> stored -5,   effective -5       likewise: handBackSlot only acts when cutoffDays > 0
  //   "0.5" -> half a day
  //   "1e9" -> a billion days, so every hand-back is flagged late forever
  //
  // Two directions of harm, both quiet. Off means a volunteer drops a shift the same evening and no planner is
  // told, which is exactly the no-show channel. Enormous means every hand-back screams, which trains planners to
  // ignore the flag — the same end state by the other road.
  //
  // Zero stays legal and means no cutoff: an organisation may decide a hand-back never needs escalating, and that
  // is their call. What is not their call is storing something that is not a number of days.
  if (p.board !== undefined) {
    const b = p.board;
    if (!b || typeof b !== "object" || Array.isArray(b)) err("board must be an object");
    if (b.cutoffDays !== undefined) {
      if (!Number.isInteger(b.cutoffDays) || b.cutoffDays < 0 || b.cutoffDays > 30) {
        err("board.cutoffDays must be a whole number of days, 0..30 — 0 means a hand-back is never flagged late");
      }
    }
  }

  // How far ahead a volunteer is reminded of a shift. Zero is meaningful and allowed — it means same-day only —
  // but a long window is not: reminding somebody three weeks out is noise they will have forgotten by the time
  // it matters, and the point of the message is to catch the shift they had lost track of.
  if (p.notify !== undefined) {
    const n = p.notify;
    if (!n || typeof n !== "object" || Array.isArray(n)) err("notify must be an object");
    if (n.remindDaysBefore !== undefined) {
      if (!Number.isInteger(n.remindDaysBefore) || n.remindDaysBefore < 0 || n.remindDaysBefore > 14) {
        err("notify.remindDaysBefore must be a whole number of days, 0..14");
      }
    }
  }

  // The season export. A delimiter is not a detail here: a spreadsheet splits a double-clicked .csv on the
  // LOCALE's list separator, so on a Danish Windows a comma-separated file arrives with every row in one cell.
  // Which separator is right is a property of who opens the file, which makes it configuration rather than a
  // constant — the same reason no weekday name appears in this codebase.
  if (p.export !== undefined) {
    const e = p.export;
    if (!e || typeof e !== "object" || Array.isArray(e)) err("export must be an object");
    if (e.csvDelimiter !== undefined) {
      // Deliberately a short allow-list. A quote or CR/LF as the delimiter would produce a file no parser can
      // read, and a multi-character separator is not CSV at all.
      if (typeof e.csvDelimiter !== "string" || ![",", ";", "\t", "|"].includes(e.csvDelimiter)) {
        err('export.csvDelimiter must be one of "," ";" "\\t" or "|"');
      }
    }
  }
  return p;
}

// Defaults live here, next to their validation, so there is one answer to "how long is a shift".
// UTC as the fallback zone is deliberate: it is wrong for every department, which makes a missing
// calendar.timezone visible as an offset rather than plausible-looking and quietly incorrect.
export const calendarConfig = (pattern) => ({
  timezone: pattern?.calendar?.timezone || "UTC",
  eventMinutes: pattern?.calendar?.eventMinutes || 90,
  configured: Boolean(pattern?.calendar?.timezone),
});

// The comma is the default because it is what RFC 4180 says and what every non-spreadsheet reader expects —
// Google Sheets, LibreOffice, pandas. A deployment whose people open the file in a spreadsheet on a locale that
// uses a semicolon as the list separator sets it, and config/pattern.json does exactly that with the reason
// written beside it.
export const exportConfig = (pattern) => ({
  csvDelimiter: pattern?.export?.csvDelimiter || ",",
});

// Two days: far enough ahead to arrange cover through the shift exchange, close enough that the shift is still
// the thing on the volunteer's mind. `?? 2` rather than `|| 2`, because 0 is a legitimate setting meaning
// same-day only, and `||` would silently turn it into two days.
export const notifyTimingConfig = (pattern) => ({
  remindDaysBefore: pattern?.notify?.remindDaysBefore ?? 2,
});

// Absent needs means one person, role irrelevant. Returned as a flat list of role slots, because that is what
// both the seeder and every screen actually want: one entry per person the session requires.
export function roleSlotsFor(activity) {
  const needs = activity?.needs ?? { any: 1 };
  const out = [];
  for (const role of ["l", "f", "any"]) {
    for (let i = 0; i < (needs[role] ?? 0); i++) out.push(role === "any" ? null : role);
  }
  return out;
}

export const PATTERN_FILE = path.join(ROOT, "config", "pattern.json");

// Which config file this instance uses. Overridable, because the multi-department plan (spec 6b) is one image
// running several instances — and until this existed they would all have read the same file baked into the
// image. Also what lets the demo run a season that spans today without editing 4water's real config.
export const patternFileFor = (env = process.env) =>
  (env.FOURWATER_PATTERN && String(env.FOURWATER_PATTERN).trim()) || PATTERN_FILE;

// WHERE THIS APP LIVES, normalised and validated in ONE place.
//
// Four callers already read FOURWATER_BASE_URL — the bootstrap invite link, the admin and profile calendar links,
// and the backup verifier — and each carried its own `String(env.X || "").replace(/\/+$/, "")`. Four copies of a
// normalisation is four chances for them to drift, and none of the four validated anything: a typo'd value was
// pasted straight into an invite link, and the operator heard about it from whoever could not log in.
//
// It is also why increment AI first went looking for a *new* variable to hang notification links on. Searching for
// publicUrl, APP_URL and FOURWATER_URL found nothing, and the conclusion drawn was "the app has no notion of its
// own address" — which was false. A fact spread across four call sites and named in none of the places you would
// grep for is a fact the codebase cannot tell you it already has. Hence: one name, one home, one normaliser.
//
// UNSET IS VALID and returns null, so `base ? url : path` keeps working exactly as it did. Every caller must
// handle null anyway: an operator cannot know the hostname the first time they boot this.
export function publicBaseUrl(env = process.env) {
  const value = String(env.FOURWATER_BASE_URL ?? "").trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `FOURWATER_BASE_URL is not a URL: ${JSON.stringify(value)}\n` +
      `  It is the address volunteers reach this app on, for example https://plan-cph.4water.org\n` +
      `  Leave it unset and links are rendered as paths, which is what they did before.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`FOURWATER_BASE_URL must be http or https, not ${parsed.protocol} — got ${value}`);
  }
  // Trailing slashes trimmed so a caller can join with "/board" without producing "//board".
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

// WHERE THE DATABASE IS, resolved identically for the app and for the thing that backs the app up.
//
// These were two defaults, not one. openDb() fell back to the bare string "4water.db" — resolved against the
// CURRENT WORKING DIRECTORY — while tools/backup.mjs fell back to path.join(ROOT, "4water.db"). Launch the server
// from anywhere other than the app directory, which a systemd unit and a plain `node /path/to/4water-app/src/
// server.mjs` both do, and the app creates its database in one place while the backup faithfully copies another.
// The backup would report success, because the file it names usually exists.
//
// Measured from a foreign cwd with FOURWATER_DB unset: openDb wanted <cwd>/4water.db, backupConfig wanted
// <app>/4water.db. And openDb's own error text — the message an operator reads at the precise moment the database
// cannot be found — said "default: 4water.db beside the app", which was backup.mjs's policy and not its own. The
// one line written to tell somebody where to look was pointing at the wrong directory.
//
// ROOT-relative is the resolution kept, because it is the one that does not depend on how the process was started.
// In the container this changes nothing: the Dockerfile sets WORKDIR /app, so both spellings already agreed there,
// which is exactly why this survived a deployment test.
export const dbFileFor = (env = process.env) =>
  (env.FOURWATER_DB && String(env.FOURWATER_DB).trim()) || path.join(ROOT, "4water.db");

export const loadPattern = (file = PATTERN_FILE) => validatePattern(readJson(file));

export function loadStrings(locale, dir = path.join(ROOT, "strings")) {
  return readJson(path.join(dir, `${locale}.json`));
}

// t() resolves against the requested locale, then English, then returns the KEY itself. Returning the key
// rather than "" or undefined means a missing translation is visible in the UI instead of rendering as a
// blank button — the failure announces itself rather than looking like a layout bug.
export function makeT(locale, dir) {
  const primary = loadStrings(locale, dir);
  const fallback = locale === "en" ? primary : loadStrings("en", dir);
  const missing = new Set();
  // vars fill {placeholders}. An unfilled placeholder is left visible rather than blanked, because
  // "Salsa on {date} is open" at least tells you what broke; "Salsa on  is open" does not.
  // ONE is a different sentence, not a smaller number. Every count string in this app read "1 proposals locked in
  // as final", "1 dates updated", "1 messages could not be sent" — the plural form with a 1 in front of it, on
  // screens a volunteer administrator reads and in the flash message after their own click. Danish and English
  // share the same rule (one versus everything else), so the whole mechanism is: when `n` is exactly 1 and
  // `<key>.one` exists, use that sentence instead.
  //
  // The fallback deliberately stays INSIDE the requested language. A `.one` present in English and missing in
  // Danish resolves to the DANISH plural — slightly wrong about number — rather than to the English singular,
  // which would switch language mid-page. Being wrong about grammar is a smaller failure than being wrong about
  // which language somebody reads. test/strings.test.mjs requires both, so this is what happens if that is ever
  // bypassed rather than a licence to skip one.
  const pick = (key, vars) => {
    const one = vars && Number(vars.n) === 1 ? `${key}.one` : null;
    if (one && one in primary) return primary[one];
    if (key in primary) return primary[key];
    missing.add(key);
    if (one && one in fallback) return fallback[one];
    return key in fallback ? fallback[key] : key;
  };
  const t = (key, vars) => {
    const s = pick(key, vars);
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  };
  t.missing = () => [...missing];
  t.weekday = (dow) => t(`weekday.${dow}`);
  return t;
}
