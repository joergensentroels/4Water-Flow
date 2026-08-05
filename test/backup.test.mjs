// Increment I. A backup nobody has restored is a hope, not a backup — so these tests make a real one from a
// real database, open it, and read the rows back out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { migrate } from "../src/db.mjs";
import { ROOT, loadPattern } from "../src/config.mjs";
import { seedStructure, seedPeople, openEverySession } from "../src/seed.mjs";
import { makeBackup, prune, verifyBackup, upload, backupConfig, uploadEnabled, describeTarget,
         refuseUnsafeDir, stampFor } from "../tools/backup.mjs";

// A real on-disk database with real rows — :memory: cannot be backed up by a separate connection.
function realDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-bk-"));
  const dbPath = path.join(dir, "live.db");
  const db = new DatabaseSync(dbPath);
  migrate(db);
  const pattern = loadPattern();
  const { seasonId } = seedStructure(db, pattern);
  const people = seedPeople(db, seasonId, [1, 2, 3].map((i) => ({
    name: `Volunteer ${i}`, contact: `v${i}@example.org`, can: [pattern.activities[0].key],
  })));
  openEverySession(db, seasonId);
  const slot = db.prepare("SELECT id FROM assignments WHERE person_id IS NULL LIMIT 1").get().id;
  db.prepare("UPDATE assignments SET person_id=? WHERE id=?").run(people[0], slot);
  db.close();
  return { dir, dbPath, backups: path.join(dir, "backups"), people };
}
const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };

test("a backup is made, passes integrity_check, and contains the real rows", () => {
  const w = realDb();
  try {
    const r = makeBackup({ db: w.dbPath, dir: w.backups, now: new Date("2026-08-03T09:15:00Z") });
    assert.equal(r.ok, true, r.message);
    assert.match(path.basename(r.file), /^4water-2026-08-03T091500Z\.sqlite$/);
    assert.ok(r.bytes > 0);

    const v = verifyBackup(r.file);
    assert.equal(v.ok, true, `integrity_check said: ${v.integrity}`);
    assert.equal(v.counts.people, 3, "the roster must be in the backup");
    assert.ok(v.counts.sessions > 0);
    assert.equal(v.counts.assignments > 0, true);
  } finally { cleanup(w.dir); }
});

test("the restored file is a WORKING database, not just a readable one", () => {
  const w = realDb();
  try {
    const r = makeBackup({ db: w.dbPath, dir: w.backups });
    // Restore = copy the file into place. Then open it read-write and use it like the app would.
    const restored = path.join(w.dir, "restored.db");
    writeFileSync(restored, readFileSync(r.file));
    const db = new DatabaseSync(restored);
    try {
      // A query the app actually runs, not SELECT 1: the point is that the schema and data survived.
      const assigned = db.prepare(`SELECT p.name FROM assignments a JOIN people p ON p.id = a.person_id LIMIT 1`).get();
      assert.equal(assigned.name, "Volunteer 1");
      // And it can still be written to — a read-only artefact would be useless for recovery.
      db.prepare("UPDATE people SET contact=? WHERE name=?").run("changed@example.org", "Volunteer 1");
      assert.equal(db.prepare("SELECT contact FROM people WHERE name=?").get("Volunteer 1").contact, "changed@example.org");
      migrate(db);   // migration must be idempotent against a restored copy too
    } finally { db.close(); }
  } finally { cleanup(w.dir); }
});

test("verifyBackup rejects a file that is not a database", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-bad-"));
  try {
    const junk = path.join(dir, "junk.sqlite");
    writeFileSync(junk, "this is not a database");
    assert.throws(() => verifyBackup(junk), /file is not a database|malformed|unable to open/i);
    assert.deepEqual(verifyBackup(path.join(dir, "nope.sqlite")), { ok: false, reason: "missing" });
  } finally { cleanup(dir); }
});

test("retention keeps the newest N and reports exactly what it removed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-prune-"));
  try {
    mkdirSync(dir, { recursive: true });
    const names = [];
    for (let d = 1; d <= 20; d++) {
      const n = `4water-2026-08-${String(d).padStart(2, "0")}T010000Z.sqlite`;
      writeFileSync(path.join(dir, n), "x");
      names.push(n);
    }
    const r = prune(dir, 14);
    assert.equal(r.kept.length, 14);
    assert.equal(r.removed.length, 6);
    assert.deepEqual(r.removed, names.slice(0, 6), "the OLDEST six should go");
    assert.deepEqual(r.kept, names.slice(6));
    assert.equal(readdirSync(dir).length, 14);
  } finally { cleanup(dir); }
});

test("retention never touches a file it did not create", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-prune2-"));
  try {
    // Things that superficially resemble a backup, plus something entirely unrelated.
    const bystanders = ["notes.txt", "4water.db", "4water-backup.sqlite", "4water-2026-08-03.sqlite",
                        "old-4water-2026-08-03T010000Z.sqlite", "4water-2026-08-03T010000Z.sqlite.bak"];
    for (const f of bystanders) writeFileSync(path.join(dir, f), "keep me");
    for (let d = 1; d <= 5; d++) writeFileSync(path.join(dir, `4water-2026-09-0${d}T010000Z.sqlite`), "x");

    const r = prune(dir, 2);
    assert.equal(r.removed.length, 3);
    for (const f of bystanders) {
      assert.ok(existsSync(path.join(dir, f)), `pruning deleted an unrelated file: ${f}`);
    }
  } finally { cleanup(dir); }
});

test("pruning an empty or missing directory is not an error", () => {
  assert.deepEqual(prune(path.join(os.tmpdir(), "4water-does-not-exist-xyz"), 5), { kept: [], removed: [] });
});

// ---- refusing unsafe destinations ---------------------------------------------------------------------
test("it refuses to write backups inside a git work tree", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-git-"));
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const nested = path.join(dir, "deep", "backups");
    const why = refuseUnsafeDir(nested);
    assert.match(why ?? "", /git work tree/, "a backup holds volunteers' contact details; one add -A publishes it");

    // And makeBackup refuses BEFORE creating anything.
    const r = makeBackup({ db: path.join(dir, "nope.db"), dir: nested });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsafe_dir");
    assert.ok(!existsSync(nested), "it must not create the directory it is about to refuse");
  } finally { cleanup(dir); }
});

test("it refuses a cloud-synced folder, and accepts an ordinary one", () => {
  assert.match(refuseUnsafeDir(path.join(os.tmpdir(), "OneDrive - PDC A S", "backups")) ?? "", /cloud-synced/);
  assert.match(refuseUnsafeDir(path.join(os.tmpdir(), "Dropbox", "backups")) ?? "", /cloud-synced/);
  const plain = mkdtempSync(path.join(os.tmpdir(), "4water-plain-"));
  try { assert.equal(refuseUnsafeDir(path.join(plain, "backups")), null); } finally { cleanup(plain); }
});

test("a missing database is a clear failure, not an empty backup", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-nodb-"));
  try {
    const r = makeBackup({ db: path.join(dir, "absent.db"), dir: path.join(dir, "backups") });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_database");
    assert.equal(readdirSync(dir).filter((f) => f !== "backups").length, 0);
  } finally { cleanup(dir); }
});

// ---- the CLI, run as a process ------------------------------------------------------------------------
//
// Everything above tests the exported functions. The MAIN BLOCK is not one of them, and it is where the retention
// step lives — the part that reads the config and then deletes things. It called `loadPattern()` with no argument,
// so on any deployment setting FOURWATER_PATTERN (the multi-department plan, and the demo) it applied a DIFFERENT
// config's retention policy than the app runs on: the wrong season protected from pruning, and the wrong
// notification window.
//
// No unit test reaches that code, and CI's backup step only checks the resulting file is sound — not which config
// was used. So this spawns the tool for real and reads what it says it did. Verifying my own fix by hand once is
// not the same as it staying fixed.
test("the CLI applies the retention policy of the config this instance runs on", async () => {
  const { dir, dbPath } = realDb();
  try {
    // A second department's file, distinguishable purely by its retention numbers.
    const alt = path.join(dir, "alt-pattern.json");
    writeFileSync(alt, JSON.stringify({ ...loadPattern(), retention: { seasons: 4, notificationDays: 17 } }, null, 2));

    const run = (env, backupDir) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "tools", "backup.mjs"), "--no-upload"], {
        env: { ...process.env, FOURWATER_DB: dbPath, FOURWATER_BACKUP_DIR: backupDir, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.once("exit", (code) => resolve({ code, out }));
    });

    // Separate directories: the stamp has second precision and refuses to overwrite, which is correct — a backup
    // must never clobber another — but it means two runs in one second collide. Found by doing exactly that.
    const withDefault = await run({ FOURWATER_PATTERN: "" }, path.join(dir, "b-default"));
    assert.equal(withDefault.code, 0, `the default run failed: ${withDefault.out}`);
    const base = loadPattern();
    assert.match(withDefault.out, new RegExp(`older than ${base.retention?.notificationDays ?? 90} days`),
      `the default run should use the repository config's window:\n${withDefault.out}`);

    const withAlt = await run({ FOURWATER_PATTERN: alt }, path.join(dir, "b-alt"));
    assert.equal(withAlt.code, 0, `the configured run failed: ${withAlt.out}`);
    assert.match(withAlt.out, /older than 17 days/,
      `FOURWATER_PATTERN was set and the tool used a different config's retention window:\n${withAlt.out}`);
    assert.match(withAlt.out, /newest 4/, "and a different season keep count");

    // The control: the two runs must actually DIFFER, or this passes on a tool that ignores both files equally.
    assert.notEqual(
      withDefault.out.match(/older than (\d+) days/)?.[1],
      withAlt.out.match(/older than (\d+) days/)?.[1],
      "both runs reported the same window, so this test is not distinguishing the configs at all");
  } finally { cleanup(dir); }
});

// ---- upload -------------------------------------------------------------------------------------------
test("upload is skipped unless fully configured, and never names the credential", () => {
  assert.equal(uploadEnabled(backupConfig({})), false);
  assert.equal(describeTarget(backupConfig({})), "local only");

  const cfg = backupConfig({
    NEXTCLOUD_WEBDAV_URL: "https://cloud.example.org/remote.php/dav/files/bot/4water",
    NEXTCLOUD_USER: "bot", NEXTCLOUD_APP_PASSWORD: "SECRETPASSWORD",
  });
  assert.equal(uploadEnabled(cfg), true);
  const described = describeTarget(cfg);
  assert.equal(described, "nextcloud(cloud.example.org)");
  assert.ok(!described.includes("SECRETPASSWORD"));
  assert.ok(!described.includes("/dav/"), "the path is more than any log needs");
});

test("upload PUTs the file with basic auth to a per-file URL", async () => {
  const w = realDb();
  try {
    const made = makeBackup({ db: w.dbPath, dir: w.backups });
    const cfg = backupConfig({
      NEXTCLOUD_WEBDAV_URL: "https://cloud.example.org/remote.php/dav/files/bot/4water/",
      NEXTCLOUD_USER: "bot", NEXTCLOUD_APP_PASSWORD: "pw",
    });
    const calls = [];
    const fake = async (url, opts) => { calls.push({ url, method: opts.method, auth: opts.headers.Authorization, bytes: opts.body.length }); return { ok: true, status: 201 }; };

    const r = await upload(cfg, made.file, fake);
    assert.equal(r.ok, true);
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].url, `https://cloud.example.org/remote.php/dav/files/bot/4water/${path.basename(made.file)}`,
      "the trailing slash on the configured URL must not double up");
    assert.equal(calls[0].auth, `Basic ${Buffer.from("bot:pw").toString("base64")}`);
    assert.equal(calls[0].bytes, statSync(made.file).size, "the whole file must be sent");
  } finally { cleanup(w.dir); }
});

test("an upload failure is reported without leaking the URL or password", async () => {
  const w = realDb();
  try {
    const made = makeBackup({ db: w.dbPath, dir: w.backups });
    const cfg = backupConfig({
      NEXTCLOUD_WEBDAV_URL: "https://cloud.example.org/remote.php/dav/files/bot/4water",
      NEXTCLOUD_USER: "bot", NEXTCLOUD_APP_PASSWORD: "SECRETPASSWORD",
    });
    const dead = async () => { throw new Error("getaddrinfo ENOTFOUND cloud.example.org"); };
    const r = await upload(cfg, made.file, dead);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "network");
    assert.ok(!JSON.stringify(r).includes("SECRETPASSWORD"), `the result leaked the password: ${JSON.stringify(r)}`);

    const http = async () => ({ ok: false, status: 507 });
    assert.deepEqual(await upload(cfg, made.file, http), { ok: false, status: 507, reason: "http" });
  } finally { cleanup(w.dir); }
});

test("timestamps sort chronologically as plain strings", () => {
  const a = stampFor(new Date("2026-08-03T09:00:00Z"));
  const b = stampFor(new Date("2026-08-03T10:00:00Z"));
  const c = stampFor(new Date("2026-09-01T00:00:00Z"));
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
  assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{6}Z$/);
});
