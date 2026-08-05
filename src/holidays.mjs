// Public holidays, and why a scheduling app has to know about them.
//
// The season is generated from a weekly rhythm, so it cheerfully created a Bachata class on Christmas Day and
// Easter Monday, opened slots on them, and put them on the shift exchange. Nobody turns up, the planner chases
// cover for a class that was never going to run, and a volunteer who claimed it looks like a no-show.
//
// 4water's instruction was specific about the direction: **suppress by default, and the planner explicitly adds
// the date if classes run anyway.** That is the right way round — the cost of a missing session is one planner
// action, and the cost of a phantom session is a volunteer's evening.
//
// NO DEPENDENCIES, so the movable feasts are computed rather than looked up. That is nine lines of arithmetic and
// a table per country, against a package that would be the app's only runtime dependency.
//
// The tables are OFFICIAL PUBLIC HOLIDAYS ONLY. Days when a dance school is closed but the country is not —
// 24 and 31 December, Danish Grundlovsdag — are a judgement 4water makes, so they belong in the config's `extra`
// list where the board can see and change them, not hidden in code. Suppressing a session is a decision about
// somebody's evening; the reason for each one should be somewhere a human can read it.

// Anonymous Gregorian computus. Returns the ISO date of Easter Sunday, from which every movable feast is an
// offset. Checked against published dates for several years in test/holidays.test.mjs rather than trusted.
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const shift = (iso, days) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const fixed = (year, mmdd) => `${year}-${mmdd}`;

// Keyed by ISO 3166-1 alpha-2, because that is what a config author will reach for. The label is a key into the
// strings files, not text: this list is read by Danish and English speakers on the same screen.
export const COUNTRIES = {
  // Denmark — Copenhagen. Store bededag was ABOLISHED as a public holiday from 2024, which is why the table takes
  // a year rather than being a constant list: a 2023 season must still show it, and a 2026 one must not.
  DK: (year) => {
    const easter = easterSunday(year);
    const days = [
      [fixed(year, "01-01"), "newYear"],
      [shift(easter, -3), "maundyThursday"],
      [shift(easter, -2), "goodFriday"],
      [easter, "easterSunday"],
      [shift(easter, 1), "easterMonday"],
      [shift(easter, 39), "ascension"],
      [shift(easter, 49), "whitSunday"],
      [shift(easter, 50), "whitMonday"],
      [fixed(year, "12-25"), "christmas1"],
      [fixed(year, "12-26"), "christmas2"],
    ];
    if (year < 2024) days.push([shift(easter, 26), "prayerDay"]);
    return days;
  },
  // France — Lyon, which is the department that hosts the server, so a second instance there is a real
  // possibility rather than a hypothetical.
  FR: (year) => {
    const easter = easterSunday(year);
    return [
      [fixed(year, "01-01"), "newYear"],
      [shift(easter, 1), "easterMonday"],
      [fixed(year, "05-01"), "labourDay"],
      [fixed(year, "05-08"), "victory1945"],
      [shift(easter, 39), "ascension"],
      [shift(easter, 50), "whitMonday"],
      [fixed(year, "07-14"), "bastille"],
      [fixed(year, "08-15"), "assumption"],
      [fixed(year, "11-01"), "allSaints"],
      [fixed(year, "11-11"), "armistice"],
      [fixed(year, "12-25"), "christmas1"],
    ];
  },
};

// The config, normalised, with the same refuse-to-guess policy as retentionConfig: an unknown country means NO
// suppression rather than a guess at which country somebody meant. A wrong holiday table silently deletes real
// classes, so the failure has to be visible — /status reports the country, and the admin screen names it.
export function holidayConfig(pattern) {
  const raw = pattern?.holidays ?? {};
  const country = typeof raw.country === "string" ? raw.country.toUpperCase() : null;
  const list = (v) => (Array.isArray(v) ? v.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) : []);
  return {
    country: country && country in COUNTRIES ? country : null,
    unknownCountry: country && !(country in COUNTRIES) ? country : null,
    extra: list(raw.extra),
    classesAnyway: list(raw.classesAnyway),
  };
}

// Every holiday touching a date range, oldest first, each with what it is and whether the planner has said classes
// run anyway. One entry per date: two holidays on one date (which happens — Easter Sunday can coincide with a
// fixed feast in some countries) would otherwise render twice and offer two contradictory buttons.
export function holidaysBetween(from, to, cfg) {
  const found = new Map();
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  if (cfg.country) {
    for (let y = fromYear; y <= toYear; y++) {
      for (const [date, key] of COUNTRIES[cfg.country](y)) {
        if (date >= from && date <= to && !found.has(date)) found.set(date, key);
      }
    }
  }
  // `extra` last and only where nothing is already recorded, so a board's own closing day cannot relabel a real
  // public holiday — the official name is the more informative one.
  for (const date of cfg.extra) {
    if (date >= from && date <= to && !found.has(date)) found.set(date, "extra");
  }
  const anyway = new Set(cfg.classesAnyway);
  return [...found.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, key]) => ({ date, key, classesAnyway: anyway.has(date) }));
}

// The one question seeding asks. Kept as its own function so the seeding loop cannot drift from the list the
// admin screen shows — the screen and the generator must agree about every date or the planner is toggling
// something that does nothing.
export function suppressed(iso, cfg) {
  if (cfg.classesAnyway.includes(iso)) return null;
  const year = Number(iso.slice(0, 4));
  if (cfg.country) {
    for (const [date, key] of COUNTRIES[cfg.country](year)) if (date === iso) return key;
  }
  return cfg.extra.includes(iso) ? "extra" : null;
}
