// Backup. One file, copied consistently, kept for a fortnight, optionally pushed to 4water's own NextCloud —
// which the org already treats as important and already backs up, so this adds no new infrastructure and the
// recovery procedure is "download yesterday's file".
//
//   node tools/backup.mjs                 # back up, prune, upload if configured
//   node tools/backup.mjs --no-upload     # local only
//
// VACUUM INTO rather than copying the file: a plain copy of a live SQLite database can catch a write in
// progress and produce something that opens fine and is subtly wrong. VACUUM INTO takes a consistent
// snapshot and compacts it.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, mkdirSync, statSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
import { fetchBounded } from "../src/outbound.mjs";

const PREFIX = "4water-";
const SUFFIX = ".sqlite";
// Only ever matches files this tool produced. A looser pattern in a pruning loop is how a backup script
// deletes something it did not create.
const BACKUP_RE = /^4water-(\d{4}-\d{2}-\d{2}T\d{6}Z)\.sqlite$/;

export function backupConfig(env = process.env) {
  return {
    db: env.FOURWATER_DB || path.join(ROOT, "4water.db"),
    dir: env.FOURWATER_BACKUP_DIR || path.join(ROOT, "backups"),
    keep: Math.max(1, Number(env.FOURWATER_BACKUP_KEEP) || 14),
    webdavUrl: String(env.NEXTCLOUD_WEBDAV_URL || "").trim(),      // e.g. https://cloud/remote.php/dav/files/user/4water-backups
    webdavUser: String(env.NEXTCLOUD_USER || "").trim(),
    webdavPass: String(env.NEXTCLOUD_APP_PASSWORD || "").trim(),   // an app password, never the account password
  };
}

export const uploadEnabled = (cfg) => Boolean(cfg.webdavUrl && cfg.webdavUser && cfg.webdavPass);
// Host only. The credential is in the password, but a full URL in a log is still more than anyone needs.
export const describeTarget = (cfg) => {
  if (!uploadEnabled(cfg)) return "local only";
  try { return `nextcloud(${new URL(cfg.webdavUrl).host})`; } catch { return "nextcloud(invalid-url)"; }
};

// The database holds volunteers' names and contact details. Two destinations are refused outright, before
// anything is created, because both turn a backup into a disclosure:
//   - inside a git work tree: one `git add -A` publishes the roster
//   - inside a cloud-sync folder that is NOT the intended NextCloud target: silent copies elsewhere
export function refuseUnsafeDir(dir, { cwd = ROOT } = {}) {
  const resolved = path.resolve(dir);
  let probe = resolved;
  for (;;) {
    if (existsSync(path.join(probe, ".git"))) {
      return `refusing to write backups inside a git work tree (${probe}) — one "git add -A" would publish volunteers' contact details`;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const segments = resolved.split(/[\\/]/);
  for (const bad of ["OneDrive", "Dropbox", "iCloudDrive", "Google Drive"]) {
    if (segments.some((s) => s.toLowerCase().startsWith(bad.toLowerCase()))) {
      return `refusing to write backups into a cloud-synced folder (${bad}) — use NEXTCLOUD_WEBDAV_URL for the intended copy instead`;
    }
  }
  return null;
}

export const stampFor = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  .replace(/^(\d{4})(\d{2})(\d{2})T(\d{6})Z$/, "$1-$2-$3T$4Z");

export function makeBackup({ db: dbPath, dir, now = new Date() }) {
  const unsafe = refuseUnsafeDir(dir);
  if (unsafe) return { ok: false, reason: "unsafe_dir", message: unsafe };
  if (!existsSync(dbPath)) return { ok: false, reason: "no_database", message: `no database at ${dbPath}` };

  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${PREFIX}${stampFor(now)}${SUFFIX}`);
  // VACUUM INTO cannot take a bound parameter, so the path is interpolated — which makes rejecting quotes a
  // correctness requirement, not tidiness.
  if (target.includes("'")) return { ok: false, reason: "bad_path", message: "backup path may not contain a single quote" };
  if (existsSync(target)) return { ok: false, reason: "exists", message: `${target} already exists` };

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { db.exec(`VACUUM INTO '${target}'`); } finally { db.close(); }
  return { ok: true, file: target, bytes: statSync(target).size };
}

// Prune to the newest `keep`. Returns what it removed so the caller can say so out loud — a retention policy
// that deletes silently is indistinguishable from one that is broken.
export function prune(dir, keep) {
  if (!existsSync(dir)) return { kept: [], removed: [] };
  const files = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();   // stamp sorts chronologically
  const removed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of removed) rmSync(path.join(dir, f));
  return { kept: files.slice(Math.max(0, files.length - keep)), removed };
}

// Two minutes, not the eight seconds src/outbound.mjs uses by default: this PUTs a whole database file, so the
// transfer legitimately takes time, and cutting off a slow-but-working upload would turn "offsite backups are
// slow" into "offsite backups do not happen". Bounded all the same, because this runs from cron — an upload
// that hangs forever is a cron job that never exits, and the next scheduled run starts another one on top of it.
export const UPLOAD_TIMEOUT_MS = 120_000;

export async function upload(cfg, file, fetchImpl = fetch, { timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  if (!uploadEnabled(cfg)) return { ok: false, skipped: true, reason: "not_configured" };
  const body = readFileSync(file);
  const url = `${cfg.webdavUrl.replace(/\/+$/, "")}/${path.basename(file)}`;
  const auth = Buffer.from(`${cfg.webdavUser}:${cfg.webdavPass}`).toString("base64");
  try {
    // The label, not the URL: it lands in the returned message and from there in a log. The URL carries the
    // path, and the credentials are in the header.
    const res = await fetchBounded(fetchImpl, url, {
      method: "PUT",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/octet-stream" },
      body,
    }, { timeoutMs, label: "the backup destination" });
    if (!res.ok) return { ok: false, status: res.status, reason: "http" };
    return { ok: true, status: res.status };
  } catch (e) {
    // Never include the URL or credentials in the error text that gets logged upstream.
    return { ok: false, reason: "network", message: e.message };
  }
}

// Open a backup and confirm it is actually usable, rather than merely present. A backup nobody has restored
// is a hope, not a backup.
export function verifyBackup(file) {
  if (!existsSync(file)) return { ok: false, reason: "missing" };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    const ok = String(Object.values(integrity)[0]).toLowerCase() === "ok";
    const counts = {};
    for (const t of ["people", "activities", "sessions", "assignments", "availability_day", "availability_hour"]) {
      counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    }
    return { ok, integrity: Object.values(integrity)[0], counts };
  } finally { db.close(); }
}

if (process.argv[1] && (await import("node:url")).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const cfg = backupConfig();
  const made = makeBackup(cfg);
  if (!made.ok) { console.error(`backup failed: ${made.message}`); process.exit(1); }
  const check = verifyBackup(made.file);
  if (!check.ok) { console.error(`backup wrote ${made.file} but it does not pass integrity_check`); process.exit(2); }
  console.log(`backed up ${(made.bytes / 1024).toFixed(0)} KB to ${made.file} (${check.counts.people} people, ${check.counts.assignments} assignments)`);

  const { removed, kept } = prune(cfg.dir, cfg.keep);
  console.log(`backup retention: keeping ${kept.length}, removed ${removed.length}${removed.length ? ` (${removed.join(", ")})` : ""}`);

  // Data retention runs AFTER the backup, deliberately: whatever it deletes is still recoverable from
  // tonight's copy for the next fortnight. Deleting first would make the policy irreversible the same night.
  // Both are scheduled clean-ups, so one command is one thing for an operator to remember.
  if (!process.argv.includes("--no-retention")) {
    const { openDb } = await import("../src/db.mjs");
    const { loadPattern } = await import("../src/config.mjs");
    const { runRetention } = await import("../src/retention.mjs");
    const live = openDb(cfg.db);
    try {
      const pattern = loadPattern();
      const r = runRetention(live, { pattern, currentKey: pattern.season.key });
      const bits = [
        `${r.notifications.removed} message(s) older than ${r.config.notificationDays} days`,
        `${r.seasons.removed.length} season(s) beyond the newest ${r.config.seasons}`,
      ];
      if (r.seasons.orphanedAvailability) bits.push(`${r.seasons.orphanedAvailability} orphaned availability row(s)`);
      console.log(`data retention: removed ${bits.join(", ")}`);
    } finally { live.close(); }
  }

  if (!process.argv.includes("--no-upload")) {
    const up = await upload(cfg, made.file);
    if (up.skipped) console.log(`upload: skipped (${describeTarget(cfg)})`);
    else if (up.ok) console.log(`upload: sent to ${describeTarget(cfg)}`);
    else { console.error(`upload FAILED to ${describeTarget(cfg)}: ${up.reason}${up.status ? ` ${up.status}` : ""}`); process.exit(3); }
  }
}
