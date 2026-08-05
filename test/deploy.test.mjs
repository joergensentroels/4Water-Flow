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

// ---- the Node floor, stated in four places (increment T) ------------------------------------------------
// It was wrong in three of them: "22.5" is when node:sqlite was ADDED, not when it became usable without
// --experimental-sqlite (22.13.0). On 22.5–22.12 the app cannot start at all. And package.json `engines`
// cannot enforce anything here, because a project with no dependencies never has `npm install` run against
// it — so the runtime check in src/db.mjs is the only thing that actually protects a deployer.
test("every declared Node floor agrees with what node:sqlite actually needs", async () => {
  const { MIN_NODE, nodeTooOld } = await import("../src/db.mjs");
  const floor = MIN_NODE.join(".");
  assert.deepEqual(MIN_NODE, [22, 13, 0], "node:sqlite is unflagged from 22.13.0; below that the import fails");

  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.engines.node, `>=${MIN_NODE[0]}.${MIN_NODE[1]}`,
    `package.json engines must match the runtime check (${floor})`);

  // The Dockerfile pin must clear the floor. Parsed, not eyeballed, so lowering it fails here.
  const pin = read("Dockerfile").match(/^FROM node:(\d+)\.(\d+)/m);
  assert.ok(pin, "the Dockerfile must pin an exact Node minor");
  const [maj, min] = [Number(pin[1]), Number(pin[2])];
  assert.ok(maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]),
    `Dockerfile pins node:${maj}.${min}, which is below the ${floor} floor`);

  // And no document may still advertise the old, wrong floor. A line may MENTION 22.5 in order to explain why
  // it is NOT the floor — that is the useful thing to say — so the exculpatory words are listed explicitly and
  // matched case-insensitively. The first version of this check used /not\b/ against a line reading
  // "Not 22.5, which this file used to claim" and flagged the correction itself as the error.
  const OLD_VERSION = /\b22\.(5|6|7|8|9|10|11|12)\b/;
  const CLAIMS_A_FLOOR = /needs?|require|floor|>=|≥|engines/i;
  const EXPLAINS_WHY_NOT = /\bnot\b|\buntil\b|\bbehind\b|\badded in\b|\bused to\b|\bcannot\b|\bnever\b|\bbelow\b/i;
  for (const f of ["README.md", "RUNBOOK.md", "CONTRIBUTING.md", "Dockerfile", "package.json"]) {
    const offending = read(f).split("\n")
      .filter((l) => OLD_VERSION.test(l) && CLAIMS_A_FLOOR.test(l) && !EXPLAINS_WHY_NOT.test(l));
    assert.deepEqual(offending, [], `${f} still states a Node floor below ${floor}:\n  ${offending.join("\n  ")}`);
  }
});

// FOURWATER_PATTERN is a seam, and a runnable tool that ignores it reads a DIFFERENT config from the app it
// operates on. `tools/backup.mjs` did, on the path that deletes: it called `loadPattern()` with no argument, so
// pruneSeasons was told to protect the default file's season key rather than the one in use, and pruned
// notifications by the default file's window. server.mjs resolved it correctly and the tool did not — two readers
// of one seam with two policies, the same shape as the invite link that built an origin from the Host header while
// every other link builder used FOURWATER_BASE_URL.
//
// The exemption is declared with a reason rather than left as a silent difference, like the CSRF audit's one route
// and PLANNER_WRITE_HONOURS.
const PATTERN_READERS = {
  "src/server.mjs": "resolves",
  "tools/backup.mjs": "resolves",
  "tools/bootstrap.mjs": "resolves",
  "tools/demo.mjs": "DEFAULT, deliberately — the demo derives a demo pattern FROM the real one as its base, so " +
                    "reading config/pattern.json is the input to its job rather than a mistake about which " +
                    "config is live. It then writes demo-pattern.json and tells you to run with that.",
};

test("every runnable tool resolves the config through the seam, or says why not", () => {
  // Only files that can be executed as a process: a library taking `pattern` as an argument is a different case.
  const runnable = ["src/server.mjs", "tools/backup.mjs", "tools/bootstrap.mjs", "tools/demo.mjs"];
  for (const f of runnable) {
    const text = read(f);
    assert.ok(/import\.meta\.url/.test(text) || /export function/.test(text),
      `${f} does not look like the file this check thinks it is`);
    const declared = PATTERN_READERS[f];
    assert.ok(declared, `${f} is runnable and not listed in PATTERN_READERS`);

    // Comments stripped BEFORE either check. Probing the second one caught this: with the import removed and the
    // call neutered, the test still passed, because the comment explaining the fix contains the word
    // `patternFileFor(`. A gate satisfied by its own documentation is the same defect as one that fails on it —
    // both mean the gate is reading prose instead of code.
    const code = text.replace(/^\s*\/\/.*$/gm, "");

    if (declared === "resolves") {
      assert.match(code, /patternFileFor\(/,
        `${f} runs as a process and must resolve the config through patternFileFor(), or it reads a different ` +
        `file from the app it is operating on`);

      // And no bare `loadPattern()` in the part that RUNS. Scoped to the main block on purpose: a bare call is
      // legitimate as a library default — `buildApp({ pattern = loadPattern() })` is how a test builds a world,
      // and the boot block always passes its own resolved pattern — but inside the main block it is a process
      // deciding for itself which config is live, which is exactly what went wrong in backup.mjs.
      //
      // The limit, stated rather than implied: this looks only at the main block, so a bare call added to an
      // exported function that the main block then calls would not be caught. What catches that is the same thing
      // that caught it this time, which is somebody reading the file.
      const guard = code.indexOf("import.meta.url");
      if (guard !== -1) {
        const main = code.slice(guard);
        assert.ok(!/loadPattern\(\)/.test(main),
          `${f}'s main block calls loadPattern() with no argument — it would read the default config rather than ` +
          `the one this instance runs on`);
      }
    } else {
      assert.ok(declared.length >= 60, `${f}: record WHY the default is right, not just that it is used`);
    }
  }
  // Nothing may be listed that is not actually runnable — a stale exemption is how one becomes permanent.
  for (const f of Object.keys(PATTERN_READERS)) {
    assert.ok(runnable.includes(f), `PATTERN_READERS lists ${f}, which this check does not treat as runnable`);
  }
});

// `roles` looks like a seam and is not: which roles EXIST is fixed by the code, and config only lists them. The
// validator required just `volunteer`, so a config declaring only that validated, seeded one role, and left an
// instance where `setRole(…, "admin", true)` answers `no_such_role`, every admin route 403s, and the boot warning
// "there is no administrator yet" is permanently true. Locked out by a config the validator approved.
//
// Both halves matter. The first is that each required role is actually required. The second is that the constant
// covers what the source gates on — a fourth role introduced in code would otherwise be missing from config with
// nothing to notice, which is the same shape as the gate added to GATE and missed in assignSlot.
test("every role the code gates on is required by the validator, and each one really is", async () => {
  const { REQUIRED_ROLES, loadPattern, validatePattern } = await import("../src/config.mjs");
  const base = loadPattern();

  assert.doesNotThrow(() => validatePattern({ ...base, roles: [...REQUIRED_ROLES] }));
  for (const role of REQUIRED_ROLES) {
    const roles = REQUIRED_ROLES.filter((r) => r !== role);
    assert.throws(() => validatePattern({ ...base, roles }), new RegExp(role),
      `a config without "${role}" must be refused, and the message must name it`);
  }
  assert.throws(() => validatePattern({ ...base, roles: "admin" }), /roles must be an array/);

  // Which names the source actually gates on. Read from the code rather than restated, so this cannot agree with
  // a stale copy of itself.
  const used = new Set();
  for (const f of ["src/server.mjs", "src/auth.mjs", "src/admin.mjs"]) {
    const text = read(f);
    // gate({...}, "planner") / postGate({...}, "admin")
    for (const m of text.matchAll(/\b(?:post)?[gG]ate\([^)]*,\s*"(\w+)"\s*\)/g)) used.add(m[1]);
    // SQL that names a role: WHERE r.name='admin'
    for (const m of text.matchAll(/r\.name\s*=\s*'(\w+)'/g)) used.add(m[1]);
    // The implication table, and the two roleName literals.
    for (const m of text.matchAll(/IMPLIES\s*=\s*\{\s*(\w+):\s*\[\s*"(\w+)"/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of text.matchAll(/roleName\s*(?:===|=)\s*"(\w+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 3, `only found ${used.size} role names in the source — this check is not looking properly`);

  const ungoverned = [...used].filter((r) => !REQUIRED_ROLES.includes(r));
  assert.deepEqual(ungoverned, [],
    `the code gates on ${ungoverned.join(", ")}, which REQUIRED_ROLES does not list — a config need not declare ` +
    `it, and the app would refuse to grant a role it depends on.`);
});

test("the version guard rejects what it should and accepts what it should", async () => {
  const { nodeTooOld, MIN_NODE, MIN_BY_MAJOR } = await import("../src/db.mjs");

  // DERIVED from the floor table, not hand-listed. The hand-listed version of this test refused 22.5.0, 22.9.1,
  // 22.12.99, 21.7.3 and 20.11.0 and accepted 23.4.0 — so it checked the 23-line boundary on the pass side and
  // never asked about the fail side, while 23.0 through 23.3 were being accepted and would have died at the
  // node:sqlite import. A list of examples cannot notice the case nobody thought of; walking the table can.
  for (const [maj, [, min, pat]] of Object.entries(MIN_BY_MAJOR)) {
    assert.equal(nodeTooOld(`${maj}.${min}.${pat}`), false, `${maj}.${min}.${pat} is the floor and must be accepted`);
    // Just below it, both one patch and one minor down, must be refused.
    if (pat > 0) assert.equal(nodeTooOld(`${maj}.${min}.${pat - 1}`), true, `${maj}.${min}.${pat - 1} is below the floor`);
    assert.equal(nodeTooOld(`${maj}.${min - 1}.99`), true, `${maj}.${min - 1}.99 is below the ${maj}-line floor`);
    assert.equal(nodeTooOld(`${maj}.0.0`), true, `${maj}.0.0 predates the flag being lifted on that line`);
    // And comfortably above it must be fine.
    assert.equal(nodeTooOld(`${maj}.${min + 1}.0`), false, `${maj}.${min + 1}.0 is above the ${maj}-line floor`);
  }

  // Below every line: no floor entry can rescue these.
  for (const v of ["21.7.3", "20.11.0", "18.20.4"]) {
    assert.equal(nodeTooOld(v), true, `${v} never had node:sqlite at all and must be refused`);
  }
  // Above every line with a cutoff: majors absent from the table shipped it unflagged from .0.
  const beyond = Math.max(...Object.keys(MIN_BY_MAJOR).map(Number)) + 1;
  for (const v of [`${beyond}.0.0`, `${beyond + 1}.7.2`, "99.0.0"]) {
    assert.equal(nodeTooOld(v), false, `${v} is past every flag cutoff and must not be refused`);
  }

  // The floor table and the headline constant must agree, or documents quoting MIN_NODE describe a different rule
  // from the one enforced.
  assert.deepEqual(MIN_BY_MAJOR[MIN_NODE[0]], MIN_NODE, "MIN_NODE must be the entry for its own major");

  // ⚠ WHAT THE LOOP ABOVE CANNOT DO, stated because it looks stronger than it is. It derives its cases from the
  // table, so it verifies the COMPARISON against the table — not the table against reality. Removing the 23 entry
  // was probed: the loop simply stops asking about 23 and everything stays green. A derived test cannot notice a
  // release line nobody declared, and no test inside this process can, because which Node minor unflagged
  // node:sqlite is a fact about Node's history rather than about this code.
  //
  // So the table is cross-checked against README, which states both floors in prose. Two places that must agree
  // beats one nobody re-reads — the same reason the Dockerfile tag, package.json's engines and the CI matrix are
  // all checked against it in test/image.test.mjs.
  const readme = read("README.md");
  for (const [maj, [, min]] of Object.entries(MIN_BY_MAJOR)) {
    assert.match(readme, new RegExp(`\\b${maj}\\.${min}\\b`),
      `README states no ${maj}-line floor of ${maj}.${min}. Either the table gained a line the documents do not ` +
      `mention, or a document was reworded — and an operator on the ${maj} line now has nothing to check against.`);
  }

  // The version this suite is running on, whatever it is, must be acceptable — otherwise the guard is lying.
  assert.equal(nodeTooOld(process.versions.node), false);
});
