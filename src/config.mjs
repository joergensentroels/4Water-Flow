// Loading the two seam files. Everything department-specific enters the program HERE and nowhere else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

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
  }
  if (!Array.isArray(p.roles) || !p.roles.includes("volunteer")) err("roles must include volunteer");
  return p;
}

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
  const t = (key, vars) => {
    let s;
    if (key in primary) s = primary[key];
    else { missing.add(key); s = key in fallback ? fallback[key] : key; }
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  };
  t.missing = () => [...missing];
  t.weekday = (dow) => t(`weekday.${dow}`);
  return t;
}
