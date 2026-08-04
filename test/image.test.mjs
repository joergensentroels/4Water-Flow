// What the Dockerfile produces, without a daemon to build it.
//
// test/deploy.test.mjs already checks that every path the Dockerfile COPYs exists in the repository. That is a
// check on the Dockerfile's INPUTS, and it cannot fail for the reason a real build fails: a file the app needs
// at runtime that nothing ever copies. The repo has every file, so reading paths out of the repo will always
// look fine — the same shape as the harness supplying what production did not.
//
// So: parse the COPY lines, materialise exactly those into an empty directory, and run the real entry point
// from there with the image's own ENV. Nothing else is present. If the copied set is insufficient, this fails
// the way the container would, and for the same reason.
//
// It does not replace building the image. It cannot see a broken base tag, an apk step, or a permissions
// problem from USER/chown. It does cover the failure that is actually likely in a zero-dependency app whose
// deployment is "copy these six things".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, cpSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { ROOT } from "../src/config.mjs";
import { MIN_NODE, nodeTooOld } from "../src/db.mjs";

const PORT = 8302;
const BASE = `http://127.0.0.1:${PORT}`;

// Parse the instructions rather than restating them, so editing the Dockerfile changes what this tests.
function readDockerfile() {
  const text = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const copies = [];
  const env = {};
  let cmd = null, healthcheck = null, workdir = null, user = null;

  for (const line of lines) {
    let m;
    if ((m = line.match(/^COPY\s+(\S+)\s+(\S+)$/))) copies.push({ from: m[1], to: m[2] });
    else if ((m = line.match(/^WORKDIR\s+(\S+)$/))) workdir = m[1];
    else if ((m = line.match(/^USER\s+(\S+)$/))) user = m[1];
    else if ((m = line.match(/^CMD\s+(\[.*\])$/))) cmd = JSON.parse(m[1]);
    else if (line.startsWith("HEALTHCHECK")) healthcheck = line;
  }
  // ENV is written across continued lines in this Dockerfile; pull the assignments out of the whole text.
  const envBlock = text.match(/ENV ([\s\S]*?)\n\n/);
  if (envBlock) {
    for (const m of envBlock[1].matchAll(/([A-Z_]+)=(\S+)/g)) env[m[1]] = m[2];
  }
  // The HEALTHCHECK's CMD is a shell-ish line; take everything after "CMD".
  const hc = text.match(/HEALTHCHECK[^\n]*\n\s*CMD ([\s\S]*?)\n/);
  return { copies, env, cmd, healthcheck: hc ? hc[1].trim() : null, workdir, user };
}

// The generalisation of a defect found by accident: test/journey.test.mjs read `demo-pattern.json` from the
// repository root, and `.gitignore` excludes that file. So the acceptance gate — the one test written because a
// green suite twice reported success over a deployment that could not work — was the one test nobody with a
// fresh clone could run. It survived because this repo has no remote yet, so CI has never executed once.
//
// A suite that only runs where it was written is not a suite. This asserts the general property rather than
// that one file: every path the tests reach for under the repo root must be something git actually carries.
test("no test depends on a file git does not carry", () => {
  const ignored = [];
  for (const rel of readdirSync(path.join(ROOT, "test"))) {
    if (!rel.endsWith(".mjs")) continue;
    const text = readFileSync(path.join(ROOT, "test", rel), "utf8");
    // Only paths built from ROOT — a temp directory the test creates itself is exactly what it should use.
    for (const m of text.matchAll(/path\.join\(ROOT,\s*([^)]*)\)/g)) {
      const parts = [...m[1].matchAll(/"([^"]+)"/g)].map((p) => p[1]);
      if (!parts.length) continue;
      const target = path.join(...parts);
      const check = spawnSync("git", ["check-ignore", "-q", target], { cwd: ROOT });
      // 0 = ignored, 1 = not ignored, other = git unavailable (a tarball, no git): then skip rather than fail.
      if (check.status === 0) ignored.push(`test/${rel} reads ${target.replace(/\\/g, "/")}, which .gitignore excludes`);
    }
  }
  assert.deepEqual(ignored, [], `these tests cannot run on a fresh clone:\n${ignored.join("\n")}`);
});

// The simulation below runs the HOST's node, not the image's. So the one thing it structurally cannot see is
// the base tag: change `FROM node:22.14-alpine` to `node:20-alpine` and the simulation still passes, while the
// real container crash-loops on db.mjs's own version guard. The floor is declared in six files and only one of
// them executes, so check the machine-readable ones against it.
// Found by running the app, not by reading it: `.listen()` is asynchronous, and the success line used to sit on
// the next statement rather than in its callback. So a port collision printed "4water listening on ..." and THEN
// died — an operator tailing the log sees a clean start, and a stale copy of the app on the same port gets
// measured instead of the new one. It cost a round of debugging in exactly that way.
test("a failed bind does not report success", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "4water-bind-"));
  const env = {
    PATH: process.env.PATH, NODE_ENV: "production",
    FOURWATER_SECRET: "b".repeat(48), HOST: "127.0.0.1", PORT: String(PORT + 1),
  };
  const start = (dbName) => spawn(process.execPath, ["src/server.mjs"],
    { cwd: ROOT, env: { ...env, FOURWATER_DB: path.join(tmp, dbName) }, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (child) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    return () => out;
  };

  const first = start("a.db");
  const firstOut = collect(first);
  try {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { if ((await fetch(`http://127.0.0.1:${PORT + 1}/healthz`)).ok) break; } catch {}
    }
    assert.match(firstOut(), /listening on http:\/\/127\.0\.0\.1:/, "the one that DID bind must say so");

    // Now the same port again.
    const second = start("b.db");
    const secondOut = collect(second);
    const code = await new Promise((r) => second.once("exit", r));

    assert.notEqual(code, 0, "a process that could not bind must exit non-zero");
    assert.doesNotMatch(secondOut(), /listening on/,
      "and must NOT claim to be listening — that claim is what sent a measurement at the wrong process");
    assert.match(secondOut(), /already in use/, "it should say what is wrong");
    assert.doesNotMatch(secondOut(), /Unhandled 'error' event/, "and not as a raw Node stack trace");
  } finally {
    if (first.exitCode === null && first.signalCode === null) {
      first.kill();
      await new Promise((r) => first.once("exit", r));
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test("the Node floor is declared once and every copy of it agrees", () => {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const tag = dockerfile.match(/^FROM node:(\d+)\.(\d+)(?:\.(\d+))?-/m);
  assert.ok(tag, "the base image must pin a Node minor, not float on `node:22`");
  const base = `${tag[1]}.${tag[2]}.${tag[3] ?? 0}`;
  assert.ok(!nodeTooOld(base), `the image pins Node ${base}, below the app's floor of ${MIN_NODE.join(".")}`);

  // package.json's `engines` is documentation here — nothing runs `npm install` in a project with no
  // dependencies — but documentation that contradicts the guard sends an operator down the wrong path.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines?.node, `>=${MIN_NODE[0]}.${MIN_NODE[1]}`,
    "package.json disagrees with the floor db.mjs actually enforces");

  // And CI claims in a comment that it tests "what the Dockerfile pins". Prose goes stale exactly like code.
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(ci, new RegExp(`["']${tag[1]}\\.${tag[2]}["']`),
    `CI does not test ${tag[1]}.${tag[2]}, which is the version the image ships`);
});

test("the files the Dockerfile copies are enough to run the app", async () => {
  const df = readDockerfile();
  assert.ok(df.copies.length >= 5, `expected several COPY lines, parsed ${df.copies.length}`);
  assert.deepEqual(df.cmd, ["node", "src/server.mjs"], "the entry point this test must run");
  assert.equal(df.workdir, "/app");
  assert.equal(df.user, "node", "the container must not run as root");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "4water-image-"));
  const appRoot = path.join(tmp, "app");
  const dataDir = path.join(tmp, "data");
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Replicate the COPY lines, and NOTHING else. This directory is the image's /app.
  for (const { from, to } of df.copies) {
    const src = path.join(ROOT, from);
    assert.ok(existsSync(src), `Dockerfile copies "${from}", which does not exist`);
    // "./" means into WORKDIR under the same name; anything else is the given name.
    const destName = to === "./" || to === "." ? from : to.replace(/^\.\//, "");
    cpSync(src, path.join(appRoot, destName), { recursive: true });
  }

  // Measured, by omitting each copied path in turn: dropping src, tools, config or strings stops the boot
  // outright, and dropping static leaves the app serving pages with a 404 stylesheet (caught below). Dropping
  // package.json changes nothing at all — every file is .mjs, so `type: module` is never consulted, and there
  // are no dependencies to install. That omission is therefore undetectable from the outside, which is not a
  // hole in this test: there is no runtime behaviour to lose.

  // Prove the replica really is minimal — if this ever contains test/ or a database, the .dockerignore or the
  // COPY lines have drifted and the "image" being tested is not the image.
  const top = readdirSync(appRoot).sort();
  assert.ok(!top.includes("test"), "the suite must not be in the image");
  assert.ok(!top.some((f) => f.endsWith(".db")), "no database in the image");
  assert.ok(!top.includes(".env"), "no secrets in the image");
  assert.ok(!top.includes("node_modules"), "there are no dependencies to install");

  try {
    const child = spawn(process.execPath, df.cmd.slice(1), {
      cwd: appRoot,                        // as WORKDIR /app
      env: {
        // Only what the image sets, plus the one required secret and a test-safe bind. HOST is 0.0.0.0 in the
        // image; binding that from a test would expose it on the network.
        PATH: process.env.PATH,
        ...df.env,
        FOURWATER_DB: path.join(dataDir, "4water.db"),
        FOURWATER_BACKUP_DIR: path.join(dataDir, "backups"),
        FOURWATER_SECRET: "i".repeat(48),
        HOST: "127.0.0.1",
        PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });

    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null) break;
      try { healthy = (await fetch(`${BASE}/healthz`)).ok; } catch {}
    }
    assert.ok(healthy, `the copied set could not run the app.\nexit=${child.exitCode}\noutput:\n${out}`);

    try {
      // The env the image declares must actually reach the app: NODE_ENV=production means no dev sign-in.
      assert.equal(df.env.NODE_ENV, "production", "the image must declare production");
      const signin = await fetch(`${BASE}/signin`);
      assert.equal(signin.status, 200);
      const body = await signin.text();
      assert.ok(!/Developer sign-in/.test(body), "a production image must not offer the developer sign-in");
      assert.equal((await fetch(`${BASE}/auth/dev`, { method: "POST" })).status, 404,
        "and the route must not exist at all");

      // The stylesheet is served from the copied static directory. Every page links it, so a missing static/
      // would leave a working app that renders unstyled — the sort of thing a smoke test walks past.
      const css = await fetch(`${BASE}/static/app.css`);
      assert.equal(css.status, 200, "static/ must be in the image");
      assert.match(css.headers.get("content-type") ?? "", /text\/css/);
      assert.ok((await css.text()).includes("--tap"), "and be the real stylesheet");

      // Config and strings are read from ROOT, which is now the replica: if either were missing from the COPY
      // list the app would either fail to boot or render translation keys at people.
      assert.ok(!/[a-z]+\.[a-z]+[A-Z]/.test(body.replace(/<[^>]*>/g, "")), "no untranslated keys on the page");
      assert.match(body, /Sign in|Log ind/);

      // Boot must have seeded a usable season inside the image, not just migrated one.
      const db = new DatabaseSync(path.join(dataDir, "4water.db"), { readOnly: true });
      const slots = db.prepare("SELECT COUNT(*) n FROM assignments").get().n;
      const naked = db.prepare(`SELECT COUNT(*) n FROM sessions s
                                 WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.session_id = s.id)`).get().n;
      db.close();
      assert.ok(slots > 0, "a container starting on an empty volume must open its slots");
      assert.equal(naked, 0);

      // And the HEALTHCHECK line from the Dockerfile, run as written. A probe that cannot pass makes a
      // container restart forever, and nothing else here would notice.
      assert.ok(df.healthcheck, "the Dockerfile must define a healthcheck");
      const probe = df.healthcheck.replace(/^CMD\s+/, "").replace(/8080/g, String(PORT));
      const m = probe.match(/^node -e "([\s\S]*)"$/);
      assert.ok(m, `could not read the healthcheck command: ${probe}`);
      const ran = spawnSync(process.execPath, ["-e", m[1]], { cwd: appRoot });
      assert.equal(ran.status, 0, `the Dockerfile's healthcheck command failed: ${ran.stderr}`);
    } finally {
      // Not `once("exit")` unconditionally: the interesting failure here is a child that DIED at boot, and by
      // then its exit event is long past, so waiting for another one hangs. A test that hangs instead of
      // failing reports a timeout with no reason, which is worse than the bug it was written to find.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise((r) => child.once("exit", r));
      }
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
