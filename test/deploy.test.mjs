// Increment I. Docker is not installed on the machine this was written on, so "the image builds" is NOT
// verified here — see RUNBOOK.md, which says so plainly. What IS verified is everything that can be checked
// without a daemon, and that is most of what actually goes wrong:
//   - every path the Dockerfile copies exists (a typo here fails the build on someone else's host)
//   - the compose file keeps the properties the spec chose it for
//   - secrets and the database are excluded from both the image and git
//   - the app behaves correctly under the exact environment the image sets, including NODE_ENV=production
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { ROOT } from "../src/config.mjs";

const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
// Instructions only. Asserting "this file does not contain X" against raw text matches X inside a comment
// that explains why X is absent — which is exactly how the first version of the npm check below failed.
const instructions = (f) => read(f).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("every path the Dockerfile copies actually exists", () => {
  const df = read("Dockerfile");
  const copied = [...df.matchAll(/^COPY\s+(\S+)\s+\.\/?(\S*)$/gm)].map((m) => m[1]);
  assert.ok(copied.length >= 5, `expected several COPY lines, found ${copied.length}`);
  for (const src of copied) {
    assert.ok(existsSync(path.join(ROOT, src)), `Dockerfile copies "${src}" which does not exist`);
  }
  // The suite is deliberately NOT copied — tests are not part of a deployment artefact.
  assert.ok(!copied.includes("test"), "test/ should not be in the image");
});

test("the Dockerfile runs unprivileged, pins Node, and sets the data paths", () => {
  const df = read("Dockerfile");
  assert.match(df, /^FROM node:22\.\d+/m, "the Node version must be pinned, not a floating tag");
  assert.match(df, /^USER node$/m, "this shares a host with the department's identity provider — do not run as root");
  assert.match(df, /FOURWATER_DB=\/data\//, "the database must live on the mounted volume, not in the image layer");
  assert.match(df, /NODE_ENV=production/);
  assert.match(df, /HEALTHCHECK/, "a container with no healthcheck fails silently");
  assert.ok(!/npm (install|ci)/.test(instructions("Dockerfile")),
    "there are no dependencies to install; if that ever changes it is the story, not a detail");
});

test("compose keeps the properties the spec chose this shape for", () => {
  const c = read("compose.yml");
  assert.match(c, /^volumes:\s*$/m, "a named volume, so SQLite stays on local disk");
  assert.match(c, /4water-data:\/data/);
  assert.ok(!/\/mnt\/|\/\/[a-z]/i.test(c.split("volumes:")[1] ?? ""), "no network path should appear as the data mount");
  assert.match(c, /mem_limit:/, "co-tenanting with the identity provider needs limits");
  assert.match(c, /cpus:/);
  assert.match(c, /127\.0\.0\.1:8080:8080/, "bind to loopback — TLS is the reverse proxy's job");
  assert.match(c, /restart: unless-stopped/);
  assert.match(c, /FOURWATER_SECRET: \$\{FOURWATER_SECRET:\?/, "a missing secret must stop compose, not default");
  assert.match(c, /profiles: \["tools"\]/, "the backup service must not start with `compose up`");
});

// Does an ignore file actually exclude a given filename? A minimal glob is enough for the patterns these
// files use, and testing the PROPERTY beats testing for a literal line: the first version of this test
// asserted the string "4water.db" was present, and broke the moment the pattern was correctly broadened to
// "*.db" — which covered strictly more. It was checking the spelling, not the protection.
// LAST matching pattern wins, and a leading "!" re-includes — the real gitignore/dockerignore semantics.
// Dropping the negations instead reported .env.example as excluded when both files explicitly ship it, which
// is a false alarm of exactly the kind that trains people to ignore a test.
function ignores(body, filename) {
  let verdict = false;
  for (const line of body.split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).replace(/\/$/, "");
    const rx = new RegExp("^" + pattern.split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
    if (rx.test(filename) || rx.test(filename.split("/")[0])) verdict = !negated;
  }
  return verdict;
}

test("the database and secrets are excluded from the image and from git", () => {
  // Real filenames this project actually produces, including ones a differently-configured deployment would
  // produce: FOURWATER_DB can name the database anything.
  const mustBeIgnored = ["4water.db", "4water.db-wal", "demo.db", "roster.db", "snapshot.sqlite", ".env",
                         ".env.production", "backups", "demo-pattern.json"];
  for (const file of [".dockerignore", ".gitignore"]) {
    const body = read(file);
    for (const name of mustBeIgnored) {
      // .dockerignore does not need the demo pattern; it is generated, not shipped.
      if (file === ".dockerignore" && name === "demo-pattern.json") continue;
      assert.ok(ignores(body, name),
        `${file} would NOT exclude ${name} — it holds volunteers' contact details or a secret`);
    }
    assert.ok(!ignores(body, ".env.example"), `${file} must still ship .env.example`);
  }
  // And the example env file must not have acquired a real value.
  const example = read(".env.example");
  assert.match(example, /^FOURWATER_SECRET=\s*$/m, ".env.example must ship EMPTY, never with a working secret");
  for (const line of example.split("\n")) {
    if (/^(OIDC_CLIENT_SECRET|NEXTCLOUD_APP_PASSWORD|MATTERMOST_WEBHOOK)=/.test(line)) {
      assert.match(line, /=\s*$/, `.env.example leaked a value: ${line}`);
    }
  }
});

// ---- behaviour under the image's own environment ------------------------------------------------------
function bootWith(env, port) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "4water-deploy-"));
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    env: { ...process.env, FOURWATER_DB: path.join(dir, "app.db"), PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, dir, out: () => out, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
const waitForHealth = async (port, child) => {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) return 0;
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return r.status; } catch {}
  }
  return 0;
};

test("under the image's exact environment the app boots and the healthcheck command succeeds", async () => {
  const port = 8131;
  const b = bootWith({ NODE_ENV: "production", FOURWATER_SECRET: "d".repeat(48), HOST: "127.0.0.1" }, port);
  try {
    assert.equal(await waitForHealth(port, b.child), 200, `did not become healthy. Output:\n${b.out()}`);

    // The literal HEALTHCHECK expression from the Dockerfile, run as a separate process.
    const df = read("Dockerfile");
    const expr = df.match(/CMD node -e "([^"]+)"/)[1].replace(/8080/g, String(port));
    const probe = spawn(process.execPath, ["-e", expr], { stdio: "ignore" });
    assert.equal(await new Promise((r) => probe.once("exit", r)), 0, "the healthcheck expression must exit 0 when healthy");
  } finally { b.child.kill(); await new Promise((r) => b.child.once("exit", r)); b.cleanup(); }
});

test("NODE_ENV=production disables the developer sign-in even if the flag is set", async () => {
  const port = 8132;
  // Both switches deliberately flipped the wrong way: this is the mistake a hurried deploy makes.
  const b = bootWith({ NODE_ENV: "production", FOURWATER_AUTH: "dev", FOURWATER_SECRET: "e".repeat(48), HOST: "127.0.0.1" }, port);
  try {
    assert.equal(await waitForHealth(port, b.child), 200, `did not become healthy. Output:\n${b.out()}`);

    // The sign-in page must not offer it...
    const page = await (await fetch(`http://127.0.0.1:${port}/signin`)).text();
    assert.ok(!/Developer sign-in|Udviklerlogin/.test(page), "production must not render a developer sign-in");
    assert.ok(!/action="\/auth\/dev"/.test(page));

    // ...and posting to it directly must not produce a session.
    const r = await fetch(`http://127.0.0.1:${port}/auth/dev`, {
      method: "POST", redirect: "manual", body: new URLSearchParams({ personId: "1" }),
    });
    assert.notEqual(r.status, 303, "the dev route must not sign anyone in under production");
    const setCookie = r.headers.getSetCookie?.() ?? [];
    assert.deepEqual(setCookie, [], "and it must certainly not set a session cookie");
    const body = await r.text();
    assert.ok(!/Users|FOURWATER|Error:/.test(body), `the refusal leaked internals: ${body.slice(0, 200)}`);
  } finally { b.child.kill(); await new Promise((r) => b.child.once("exit", r)); b.cleanup(); }
});
